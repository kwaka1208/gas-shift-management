/**
 * api.gs … google.script.run から呼ばれる公開関数
 *
 * ここには「入力検証 → service 呼び出し → 結果整形」だけを書く。ロジックは持たない。
 * 戻り値は必ず { ok: true, data } / { ok: false, error } に統一する。
 *
 * 【重要】末尾アンダースコアの無いグローバル関数は、どのファイルにあっても
 * google.script.run から呼び出せる。本アプリは匿名アクセス可でデプロイするため、
 *   - 内部関数は必ず末尾アンダースコアを付ける
 *   - 公開関数は読み書きを問わず冒頭で requireViewToken_(token) を呼ぶ
 *   - 運用系（setup など）は冒頭で requireOwner_() を呼ぶ
 * のいずれかを必ず満たすこと。
 *
 * **認証も記名も無い。** 閲覧トークンを知っている人は全員が書き込める。
 * 管理URL（?view=admin）は画面を分けるだけで、保護にはならない。
 * `_log` の操作者列には LOG_OPERATOR（固定値）が入る。
 */

/** 成功レスポンス */
function ok_(data) {
  return { ok: true, data: data === undefined ? null : data };
}

/**
 * 失敗レスポンス。例外の中身をそのままクライアントへ渡さない。
 *
 * `retryable` は「サーバー側の処理が1行も走っていない」ことが分かっている
 * エラーにだけ付く（現状はロック取得の失敗のみ）。画面はこの印がある場合に限って
 * 自動で送り直す。**それ以外に付けてはいけない。**
 * 途中まで書いたかもしれない失敗を送り直すと、二重に登録される。
 */
function err_(e) {
  const message = (e && e.message) ? e.message : String(e);
  console.error(message + (e && e.stack ? '\n' + e.stack : ''));
  const res = { ok: false, error: message };
  if (e && e.retryable === true) res.retryable = true;
  return res;
}

/**
 * ロックが取れなかったときのエラー。送り直してよい印を付ける。
 * ロックを取れていない＝シートには何も書いていないので、再送は安全。
 */
function lockBusyError_() {
  const e = new Error('ただいま混み合っています。少し待ってから、もう一度お試しください。');
  e.retryable = true;
  return e;
}

/**
 * 公開関数の共通ラッパー。例外を握って統一形式に変換する。
 * @param {string} name ログ用の関数名
 * @param {Function} fn 実処理。戻り値が data になる
 */
function handle_(name, fn) {
  try {
    return ok_(fn());
  } catch (e) {
    console.error('[' + name + '] ' + e);
    return err_(e);
  }
}

/**
 * 書き込みを Lock で保護する（CLAUDE.md 開発ルール / gas.md 5.2）。
 * **書き込みを伴う処理は必ずこれを通すこと。**
 *
 * 読み取りから書き込みまでをロック内に収めることが要点。
 * 外で読んで中で書くと、再検証の意味が無くなる。
 *
 * **解放前の `SpreadsheetApp.flush()` を外さないこと。**
 * シートへの書き込みはバッファされ、実行が終わるまで反映されないことがある。
 * flush せずにロックを解放すると、次にロックを取った実行が古い状態を読み、
 *   - insertRows_ が `getLastRow() + 1` を誤り、直前の追記を**上書きする**
 *   - findOrCreatePerson_ が既存の人を見落として二重に作る
 * という壊れ方をする。ロックがあっても flush が無ければ排他は成立しない。
 *
 * @param {Function} fn ロック内で実行する処理
 * @param {number=} timeoutMs 待機時間。省略時は LOCK_TIMEOUT_MS（10秒）。
 *                            応募受付だけは長く待つ（LOCK_TIMEOUT_ENTRY_MS）
 */
function withLock_(fn, timeoutMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || LOCK_TIMEOUT_MS)) {
    throw lockBusyError_();
  }
  try {
    return fn();
  } finally {
    // 例外で抜けた場合も、途中まで書いた分を確定させてから解放する。
    // flush 自体の失敗でロックを握ったままにしない
    try {
      SpreadsheetApp.flush();
    } catch (e) {
      console.error('flush failed: ' + e);
    }
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

/**
 * 画面の初期化データ。日付に依存しないものだけを返す。
 *
 * @param {string} token 閲覧トークン
 * @return {{ ok: boolean, data?: { config, places, templateNames }, error?: string }}
 */
function getBootstrap(token) {
  return handle_('getBootstrap', function () {
    requireViewToken_(token);
    return buildBootstrap_();
  });
}

/**
 * 指定日の描画に必要な全データを1回で返す。
 * 候補者の絞り込みはクライアント側で行う（サーバー往復を増やさない）。
 *
 * @param {string} token 閲覧トークン
 * @param {string} date 'YYYY-MM-DD'
 */
function getDayBoard(token, date) {
  return handle_('getDayBoard', function () {
    requireViewToken_(token);
    return buildDayBoard_(date);
  });
}

// ---------------------------------------------------------------------------
// 可用性の登録（応募フォーム）
// ---------------------------------------------------------------------------

/**
 * 可用性を登録する。ボランティア本人、または管理者の代理入力から呼ばれる。
 *
 * **記名は求めない。** 応募者は自分の名前を payload.name に書いており、
 * それ自体が記名になっている。代理入力のときだけ payload.operator が入る。
 *
 * **ここだけロックを長く待つ**（LOCK_TIMEOUT_ENTRY_MS）。応募が集中する唯一の処理で、
 * 待たされることより登録できないことのほうが損害が大きい。
 * それでも取れなかったときは retryable が立ち、画面が自動で送り直す。
 *
 * @param {string} token 閲覧トークン
 * @param {Object} payload 名前 / 連絡先 / 種別 / days（日付と時間帯の配列）/ 代理入力者
 */
function submitAvailability(token, payload) {
  return handle_('submitAvailability', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return submitAvailabilityData_(payload);
    }, LOCK_TIMEOUT_ENTRY_MS);
  });
}

// ---------------------------------------------------------------------------
// 書き込み（閲覧トークンだけが条件。すべて Lock 内で実行する）
// ---------------------------------------------------------------------------

/**
 * 枠に人を割り当てる。
 *
 * **人数では止めない**（人数は場所単位で運用する方針）。
 * 同じ時間に別の枠へ割り当て済みの場合だけはエラーにする。
 *
 * @param {string} token 閲覧トークン
 * @param {string} slotId
 * @param {string} personId
 */
function assign(token, slotId, personId) {
  return handle_('assign', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return assignData_(slotId, personId, LOG_OPERATOR);
    });
  });
}

/**
 * 時間を指定して人を入れる。指定した時間の枠が無ければ作ってから割り当てる。
 *
 * 場所の空いているところをタップしたとき、既存の枠に別の時間で人を入れたいときの
 * 両方から呼ばれる。同じ日付・場所・開始・終了の枠が既にあれば、それを使い回す。
 *
 * @param {string} token 閲覧トークン
 * @param {Object} payload date / place_id / start_time / end_time / person_id
 */
function assignToNewSlot(token, payload) {
  return handle_('assignToNewSlot', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return assignToNewSlotData_(payload, LOG_OPERATOR);
    });
  });
}

/**
 * 割り当てを解除する。既に解除済みでもエラーにしない。
 *
 * @param {string} token 閲覧トークン
 * @param {string} assignmentId
 */
function unassign(token, assignmentId) {
  return handle_('unassign', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return unassignData_(assignmentId, LOG_OPERATOR);
    });
  });
}

/**
 * 場所をまとめて保存する。行は削除せず、廃止は active=false で表す。
 *
 * @param {string} token 閲覧トークン
 * @param {Array<Object>} places 画面上の一覧そのまま
 */
function savePlaces(token, places) {
  return handle_('savePlaces', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return savePlacesData_(places, LOG_OPERATOR);
    });
  });
}

/**
 * 指定日の枠をまとめて保存する。
 * 送られてこなかった枠は削除される（ただし割り当てのある枠は削除できない）。
 *
 * @param {string} token 閲覧トークン
 * @param {string} date 'YYYY-MM-DD'
 * @param {Array<Object>} slots その日の枠の全件
 */
function saveSlots(token, date, slots) {
  return handle_('saveSlots', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return saveSlotsData_(date, slots, LOG_OPERATOR);
    });
  });
}

/**
 * 週テンプレートから期間分の枠を生成する。
 * 同じ枠が既にあればスキップするので、二度実行しても増えない。
 *
 * @param {string} token 閲覧トークン
 * @param {string} templateName slot_templates の template_name
 * @param {string} fromDate 'YYYY-MM-DD'
 * @param {string} toDate 'YYYY-MM-DD'
 */
function generateSlots(token, templateName, fromDate, toDate) {
  return handle_('generateSlots', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return generateSlotsData_(templateName, fromDate, toDate, LOG_OPERATOR);
    });
  });
}

/**
 * 枠をコピーする（前日コピー: dayCount=1 / 前週コピー: dayCount=7）。
 * 割り当てはコピーしない。
 *
 * @param {string} token 閲覧トークン
 * @param {string} fromDate コピー元の開始日
 * @param {string} toDate コピー先の開始日
 * @param {number} dayCount コピーする日数（既定1）
 */
function copySlots(token, fromDate, toDate, dayCount) {
  return handle_('copySlots', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return copySlotsData_(fromDate, toDate, dayCount, LOG_OPERATOR);
    });
  });
}
