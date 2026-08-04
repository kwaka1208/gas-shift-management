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
 * **管理者の合言葉認証は無い。** 閲覧トークンを知っている人は全員が書き込める。
 * 書き込み系は代わりに操作者名の記名を必須とし、`_log` に残す。
 */

/** 成功レスポンス */
function ok_(data) {
  return { ok: true, data: data === undefined ? null : data };
}

/** 失敗レスポンス。例外の中身をそのままクライアントへ渡さない */
function err_(e) {
  const message = (e && e.message) ? e.message : String(e);
  console.error(message + (e && e.stack ? '\n' + e.stack : ''));
  return { ok: false, error: message };
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
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new Error('他の操作と重なりました。少し待ってからもう一度お試しください。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * 操作者名を検証する。
 *
 * 合言葉を廃止したため、**記名が唯一の説明責任の手がかり**になる。
 * 空のまま書き込ませない。
 */
function requireOperator_(operator) {
  const name = trimStr_(operator);
  if (!name) throw new Error('操作する人を選んでください。');
  if (name.length > 50) throw new Error('お名前が長すぎます。');
  return name;
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

/**
 * 画面の初期化データ。日付に依存しないものだけを返す。
 *
 * @param {string} token 閲覧トークン
 * @return {{ ok: boolean, data?: { config, places, operators, templateNames }, error?: string }}
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
 * @param {string} token 閲覧トークン
 * @param {Object} payload 名前 / 連絡先 / 種別 / 日付 / 時間帯配列 / 代理入力者
 */
function submitAvailability(token, payload) {
  return handle_('submitAvailability', function () {
    requireViewToken_(token);
    return withLock_(function () {
      return submitAvailabilityData_(payload);
    });
  });
}

// ---------------------------------------------------------------------------
// 書き込み（すべて閲覧トークン＋記名が必要。すべて Lock 内で実行する）
// ---------------------------------------------------------------------------

/**
 * 枠に人を割り当てる。
 *
 * **必要人数の超過は弾かない**（予備要員・引き継ぎの運用があるため）。
 * 超過した場合は data.notice にその旨が入るので、画面で伝えること。
 * 同じ時間に別の枠へ割り当て済みの場合だけはエラーにする。
 *
 * @param {string} token 閲覧トークン
 * @param {string} slotId
 * @param {string} personId
 * @param {string} operator 操作者名（記名。必須）
 */
function assign(token, slotId, personId, operator) {
  return handle_('assign', function () {
    requireViewToken_(token);
    const name = requireOperator_(operator);
    return withLock_(function () {
      return assignData_(slotId, personId, name);
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
 * @param {Object} payload date / place_id / start_time / end_time / required_count /
 *                         staff_required / person_id
 * @param {string} operator 操作者名（記名。必須）
 */
function assignToNewSlot(token, payload, operator) {
  return handle_('assignToNewSlot', function () {
    requireViewToken_(token);
    const name = requireOperator_(operator);
    return withLock_(function () {
      return assignToNewSlotData_(payload, name);
    });
  });
}

/**
 * 割り当てを解除する。既に解除済みでもエラーにしない。
 *
 * @param {string} token 閲覧トークン
 * @param {string} assignmentId
 * @param {string} operator 操作者名（記名。必須）
 */
function unassign(token, assignmentId, operator) {
  return handle_('unassign', function () {
    requireViewToken_(token);
    const name = requireOperator_(operator);
    return withLock_(function () {
      return unassignData_(assignmentId, name);
    });
  });
}

/**
 * 場所をまとめて保存する。行は削除せず、廃止は active=false で表す。
 *
 * @param {string} token 閲覧トークン
 * @param {Array<Object>} places 画面上の一覧そのまま
 * @param {string} operator 操作者名（記名。必須）
 */
function savePlaces(token, places, operator) {
  return handle_('savePlaces', function () {
    requireViewToken_(token);
    const name = requireOperator_(operator);
    return withLock_(function () {
      return savePlacesData_(places, name);
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
 * @param {string} operator 操作者名（記名。必須）
 */
function saveSlots(token, date, slots, operator) {
  return handle_('saveSlots', function () {
    requireViewToken_(token);
    const name = requireOperator_(operator);
    return withLock_(function () {
      return saveSlotsData_(date, slots, name);
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
 * @param {string} operator 操作者名（記名。必須）
 */
function generateSlots(token, templateName, fromDate, toDate, operator) {
  return handle_('generateSlots', function () {
    requireViewToken_(token);
    const name = requireOperator_(operator);
    return withLock_(function () {
      return generateSlotsData_(templateName, fromDate, toDate, name);
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
 * @param {string} operator 操作者名（記名。必須）
 */
function copySlots(token, fromDate, toDate, dayCount, operator) {
  return handle_('copySlots', function () {
    requireViewToken_(token);
    const name = requireOperator_(operator);
    return withLock_(function () {
      return copySlotsData_(fromDate, toDate, dayCount, name);
    });
  });
}
