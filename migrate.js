/**
 * migrate.gs … 枠（slots）の廃止にともなう1回きりのデータ移行
 *
 * スクリプトエディタから `migrateSlots()` を1回実行する。**何度実行しても安全**
 * （移行済みなら何もしない）。
 *
 * 【何をするか】
 *   旧: slots（場所・日付・時間帯）＋ assignments（slot_id・person_id）の2枚
 *   新: assignments 1枚（場所・日付・時間帯・人）
 *
 *   旧 assignments の各行について、参照先の slot から日付・場所・時間帯・メモを
 *   引き写して、新しい assignments の1行にする。
 *
 * 【消さないもの】
 *   - 旧シートは `slots_old_YYYYMMDD` のように名前を変えて残す。**削除しない。**
 *     移行の結果がおかしかったときに、元を見ないと直しようがないため
 *   - **割り当ての無い枠は移行できない。** 新しい形は「人が入っていること」が前提で、
 *     空の枠を表す手段が無い。件数だけ実行ログに出すので、必要なら旧シートを見て手で入れ直す
 *
 * 【なぜ列を足すのではなくシートを作り直すのか】
 *   既存の assignments には `slot_id` 列が残っており、新しい定義には無い。
 *   `ensureSheet_` は足りない列を右端に足すだけで、要らない列は消さない。
 *   その状態だと定義の列数（10）とシートの列数（11）が食い違い、`insertRows_` の
 *   一括書き込みが列数不一致で失敗する。**新しい形の空シートを作り直すのが唯一安全な道。**
 */
function migrateSlots() {
  requireOwner_();

  const spreadsheet = ss_();
  const assignSheet = spreadsheet.getSheetByName(SHEET_DEFS.ASSIGNMENTS.name);

  if (!assignSheet) {
    console.log('assignments シートがありません。先に setup() を実行してください。');
    return { ok: false };
  }

  const headers = readHeaderRow_(assignSheet);
  if (headers.indexOf('slot_id') === -1) {
    console.log('移行済みです（assignments に slot_id 列がありません）。何もしませんでした。');
    return { ok: true, migrated: 0, skipped: 0, alreadyDone: true };
  }

  const slotSheet = spreadsheet.getSheetByName('slots');
  const slotsById = slotSheet ? indexRawById_(readRawTable_(slotSheet)) : new Map();
  const oldRows = readRawTable_(assignSheet);

  // --- 新しい行を組み立てる（まだ何も書かない） ----------------------------
  const migrated = [];
  const orphans = [];

  oldRows.forEach(function (row) {
    const slot = slotsById.get(trimStr_(row.slot_id));
    if (!slot) {
      orphans.push(row);
      return;
    }
    migrated.push({
      id: trimStr_(row.id),                 // idは引き継ぐ（_log から辿れるように）
      date: trimStr_(slot.date),
      place_id: trimStr_(slot.place_id),
      start_time: trimStr_(slot.start_time),
      end_time: trimStr_(slot.end_time),
      person_id: trimStr_(row.person_id),
      note: trimStr_(slot.note),            // メモは枠が持っていた。割り当てへ引き継ぐ
      assigned_by: trimStr_(row.assigned_by),
      created_at: trimStr_(row.created_at),
      updated_at: trimStr_(row.updated_at)
    });
  });

  const emptySlots = slotSheet
    ? readRawTable_(slotSheet).filter(function (s) {
        return !oldRows.some(function (a) { return trimStr_(a.slot_id) === trimStr_(s.id); });
      })
    : [];

  // --- ここから書き込み ----------------------------------------------------
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');

  // 旧 assignments を退避してから、新しい形の空シートを作る
  assignSheet.setName('assignments_old_' + stamp);
  const fresh = spreadsheet.insertSheet(SHEET_DEFS.ASSIGNMENTS.name);
  const cols = SHEET_DEFS.ASSIGNMENTS.columns.map(function (c) { return c.id; });
  fresh.getRange(1, 1, 1, cols.length).setValues([cols]);
  fresh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
  fresh.setFrozenRows(1);
  applyTextFormat_(fresh, SHEET_DEFS.ASSIGNMENTS);

  if (migrated.length > 0) {
    // insertRows_ は id / created_at が空のときだけ埋めるので、引き継いだ値は保たれる
    insertRows_(SHEET_DEFS.ASSIGNMENTS, migrated);
  }

  // 枠のシートも退避する（削除はしない）
  RETIRED_SHEET_NAMES.forEach(function (name) {
    const sheet = spreadsheet.getSheetByName(name);
    if (sheet) sheet.setName(name + '_old_' + stamp);
  });

  appendLog_(LOG_OPERATOR, 'migrate_slots', '',
    '移行 ' + migrated.length + '件 / 参照先の無い割り当て ' + orphans.length + '件 / ' +
    '割り当ての無い枠 ' + emptySlots.length + '件');

  // --- 結果を伝える --------------------------------------------------------
  console.log('--- 枠の廃止にともなう移行 ---');
  console.log('移行した割り当て: ' + migrated.length + '件');
  console.log('退避したシート: assignments_old_' + stamp +
    RETIRED_SHEET_NAMES.map(function (n) { return ' / ' + n + '_old_' + stamp; }).join(''));

  if (orphans.length > 0) {
    console.log('');
    console.log('⚠ 参照先の枠が見つからず、移行できなかった割り当てが ' + orphans.length + '件あります。');
    console.log('  assignments_old_' + stamp + ' を確認してください（slot_id が空か、枠が消えています）。');
  }
  if (emptySlots.length > 0) {
    console.log('');
    console.log('⚠ 誰も入っていない枠が ' + emptySlots.length + '件ありました。**移行していません。**');
    console.log('  新しい形は「人が入っていること」が前提で、空の枠を表せません。');
    console.log('  必要なら slots_old_' + stamp + ' を見て、画面から入れ直してください。');
  }

  return {
    ok: true,
    migrated: migrated.length,
    orphans: orphans.length,
    emptySlots: emptySlots.length
  };
}

/**
 * 移行できなかった割り当ての中身を調べる。**読むだけで、何も書き換えない。**
 *
 * `migrateSlots()` が「参照先の枠が見つからず、移行できなかった」と言った行を、
 * 退避済みのシートから拾い直して実行ログに出す。
 * 捨ててよいのか入れ直すべきなのかは、中身を見ないと決められないため。
 *
 * 退避シートが複数ある場合は**いちばん新しいもの**を見る。
 */
function inspectMigrationOrphans() {
  requireOwner_();

  const assignOld = latestBackupSheet_('assignments_old_');
  if (!assignOld) {
    console.log('assignments_old_… のシートが見つかりません。migrateSlots() を実行しましたか？');
    return { ok: false };
  }

  const slotOld = latestBackupSheet_('slots_old_');
  const slotsById = slotOld ? indexRawById_(readRawTable_(slotOld)) : new Map();
  const peopleById = indexById_(readTable_(SHEET_DEFS.PEOPLE));
  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));

  const orphans = readRawTable_(assignOld).filter(function (row) {
    return !slotsById.has(trimStr_(row.slot_id));
  });

  console.log('--- 移行できなかった割り当て ---');
  console.log('見たシート: ' + assignOld.getName() +
    (slotOld ? ' / ' + slotOld.getName() : '（slots_old_… が見つかりません）'));
  console.log('件数: ' + orphans.length);

  if (orphans.length === 0) {
    console.log('移行できなかった行はありません。');
    return { ok: true, orphans: [] };
  }

  console.log('');
  orphans.forEach(function (row, i) {
    const person = peopleById.get(trimStr_(row.person_id));
    const reason = trimStr_(row.slot_id) === ''
      ? 'slot_id が空'
      : '枠が見つからない（slot_id: ' + row.slot_id + '）';

    console.log((i + 1) + '. ' + (person ? person.name + 'さん' : '(不明な人)') +
      '  … ' + reason);
    console.log('    assignment_id: ' + row.id);
    console.log('    person_id: ' + row.person_id);
    console.log('    登録日時: ' + (trimStr_(row.created_at) || '(不明)'));
  });

  console.log('');
  console.log('【この先どうするか】');
  console.log('・その人の勤務が実際にあったなら、配置表の画面から入れ直してください');
  console.log('  （新しい形は「場所・日付・時間帯・人」が揃っていないと1行になりません。');
  console.log('   枠が消えている以上、場所と時間はここからは復元できません）');
  console.log('・テスト中に出た行や、消したはずの割り当てなら、そのままで構いません');
  console.log('・元の行は ' + assignOld.getName() + ' に残っています。消さずに置いておけます');

  // 場所が特定できるならヒントを出す（同じ人の同じ日に他の割り当てがあれば参考になる）
  if (placeById.size === 0) {
    console.log('');
    console.log('※ places シートが空です。先に場所を登録してください。');
  }

  return { ok: true, orphans: orphans.length };
}

/** 接頭辞に一致する退避シートのうち、名前がいちばん新しいもの（名前に日時が入っている） */
function latestBackupSheet_(prefix) {
  const matched = ss_().getSheets().filter(function (sheet) {
    return sheet.getName().indexOf(prefix) === 0;
  });
  if (matched.length === 0) return null;
  matched.sort(function (a, b) {
    return a.getName() < b.getName() ? 1 : (a.getName() > b.getName() ? -1 : 0);
  });
  return matched[0];
}

// ---------------------------------------------------------------------------
// 移行専用の読み取り（SHEET_DEFS に頼らない）
// ---------------------------------------------------------------------------

/*
  移行の入力は「古い形」のシートで、SHEET_DEFS はもう新しい形しか知らない。
  readTable_ を使うと古い列（slot_id など）が読めないので、ここだけ生で読む。
*/

/** 1行目をヘッダー名の配列として読む */
function readHeaderRow_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(trimStr_);
}

/** ヘッダー名をキーにしたオブジェクト配列（型変換はしない。すべて文字列） */
function readRawTable_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(trimStr_);

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const obj = {};
    let empty = true;
    headers.forEach(function (h, i) {
      if (!h) return;
      obj[h] = trimStr_(values[r][i]);
      if (obj[h] !== '') empty = false;
    });
    if (!empty) out.push(obj);
  }
  return out;
}

/** id をキーにした Map */
function indexRawById_(rows) {
  const map = new Map();
  rows.forEach(function (r) {
    const id = trimStr_(r.id);
    if (id) map.set(id, r);
  });
  return map;
}
