/**
 * service_staff_import.gs … 職員の一括登録（`staff_import` シート）
 *
 * スプレッドシートのメニュー「シフト管理 ▸ 職員を一括登録」から実行する。
 * **何度実行しても安全**（下の「二重登録をどう防ぐか」を参照）。
 *
 * 【日付を書く行と書かない行】
 * 職員は申告が無くても、既定の勤務時間帯で毎日候補に出る
 * （service_board.js `appendStaffDefaultAvailability_`）。したがって
 *   - **日付を書かない行** … 人を登録するだけ。毎日、既定の時間帯で候補に出る（ふつうはこちら）
 *   - **日付を書いた行** … その日の申告として availability に入り、**既定より優先される。**
 *     「この日は早番」「この日は来られない時間がある」を表せる
 * の2通りになる。既定の時間帯は `_config` の `staff_default_start` / `staff_default_end`。
 *
 * 【二重登録をどう防ぐか】
 * 取り込んだ行には `person_id` を書き戻す。次に実行したとき、この列が埋まっている行は
 * 「同じ人への追記」として扱うので、人が増えない。可用性のほうは既存の申告と和集合を
 * 取るだけなので（`addAvailabilityBatch_`）、同じ行を何度取り込んでも増えない。
 *
 * 同じ実行の中では、氏名と連絡先が同じ行を同一人物とみなす。
 * **1人が複数の時間帯に入る場合は、行を分けて書けばよい。**
 * 同姓同名の別人を分けたいときは連絡先を入れて区別すること（人マスタの照合規則は
 * 応募フォームと同じ。service_entry.js `findOrCreatePerson_` 参照）。
 *
 * 【既存の人が見つかったとき】
 * シートに書かれている列だけを上書きし、書かれていない列には触らない。
 * **`type` と `is_recurring` は触らない。** ボランティアとして登録済みの人がこのシートに
 * 現れても、こちらの都合で職員に変えてしまわないため（status 列にその旨を書く）。
 */

/**
 * 一括登録を実行する。
 *
 * 匿名からは呼べない（`requireOwner_`）。google.script.run からも届く名前だが、
 * スクリプトエディタとメニュー以外では止まる（api.js 冒頭の規約）。
 */
function importStaff() {
  requireOwner_();
  const result = withLock_(function () {
    return importStaffData_();
  });
  console.log('--- 職員の一括登録 ---');
  console.log(formatStaffImportResult_(result));
  return result;
}

/**
 * 一括登録シートを用意して開く。
 *
 * setup() を実行し直さなくてもシートを作れるようにするためのもの。
 * 既にあるシートには手を触れない（足りない列とヘッダーのメモだけ整える）。
 */
function prepareStaffImportSheet() {
  requireOwner_();
  const message = ensureSheet_(SHEET_DEFS.STAFF_IMPORT);
  const sheet = getSheet_(SHEET_DEFS.STAFF_IMPORT);
  ss_().setActiveSheet(sheet);
  console.log(message);
  return message;
}

// ---------------------------------------------------------------------------
// 取り込み本体
// ---------------------------------------------------------------------------

/**
 * `staff_import` シートを読み、people と availability に反映する。
 *
 * 検証に落ちた行は `status` 列に理由を書いて飛ばし、**他の行は取り込む。**
 * 1行の書き間違いで全部が止まると、どこが悪いのか分からないまま作業が進まなくなる。
 *
 * @return {Object} 集計結果（formatStaffImportResult_ が文章にする）
 */
function importStaffData_() {
  const def = SHEET_DEFS.STAFF_IMPORT;
  const empty = {
    sheetCreated: false, total: 0, created: 0, reused: 0,
    failed: 0, availabilityAdded: 0, errors: []
  };

  if (!ss_().getSheetByName(def.name)) {
    ensureSheet_(def);
    return Object.assign({}, empty, { sheetCreated: true });
  }

  const sheet = getSheet_(def);
  const rows = readTable_(def).filter(function (r) { return !isBlankStaffImportRow_(r); });
  if (rows.length === 0) return empty;
  if (rows.length > STAFF_IMPORT_MAX_ROWS) {
    throw new Error('一度に取り込めるのは' + STAFF_IMPORT_MAX_ROWS + '行までです（いまは ' +
      rows.length + '行）。行を分けて実行してください。');
  }

  const people = readTable_(SHEET_DEFS.PEOPLE);
  const ctx = {
    people: people,
    byId: indexById_(people),
    personIdByKey: {},  // 同一実行内で同じ人を指す行をまとめる
    newPeople: [],
    patches: {},        // id → 既存の人への更新（同じ人への更新は1つにまとめる）
    availability: [],
    results: [],        // シートへ書き戻す値
    errors: [],
    failed: 0,
    reused: 0
  };

  const defaults = {
    start: getConfigValue_(CONFIG_KEY.ENTRY_DEFAULT_START, CONFIG_DEFAULTS.entry_default_start),
    end: getConfigValue_(CONFIG_KEY.ENTRY_DEFAULT_END, CONFIG_DEFAULTS.entry_default_end),
    unit: Number(getConfigValue_(CONFIG_KEY.SLOT_UNIT_MINUTES, 10)) || 10
  };

  rows.forEach(function (row) { importStaffRow_(row, ctx, defaults); });

  // --- ここから書き込み ----------------------------------------------------
  if (ctx.newPeople.length > 0) insertRows_(SHEET_DEFS.PEOPLE, ctx.newPeople);

  const patches = Object.keys(ctx.patches).map(function (id) { return ctx.patches[id]; });
  if (patches.length > 0) updateRowsById_(SHEET_DEFS.PEOPLE, patches);

  const availability = addAvailabilityBatch_(ctx.availability);
  writeStaffImportResults_(sheet, ctx.results);

  const result = {
    sheetCreated: false,
    total: rows.length,
    created: ctx.newPeople.length,
    reused: ctx.reused,
    failed: ctx.failed,
    availabilityAdded: availability.addedCount,
    errors: ctx.errors
  };

  appendLog_(LOG_OPERATOR, 'import_staff', '',
    '新規 ' + result.created + '人 / 既存へ追加 ' + result.reused + '行 / ' +
    'エラー ' + result.failed + '行 / 可用性 ' + result.availabilityAdded + '件');

  return result;
}

/** 人が記入する列（`status` などの書き戻し列を除いたもの） */
const STAFF_IMPORT_INPUT_COLUMNS_ = [
  'name', 'kana', 'gender', 'age', 'contact',
  'start_date', 'end_date', 'start_time', 'end_time', 'note'
];

/**
 * 記入欄がすべて空の行か。
 *
 * 取り込んだあとに内容だけ消すと、`status` / `person_id` が残って行としては空にならない。
 * それを毎回「氏名を入力してください」と言い続けないための判定。
 */
function isBlankStaffImportRow_(row) {
  return STAFF_IMPORT_INPUT_COLUMNS_.every(function (id) {
    return trimStr_(row[id]) === '';
  });
}

/** 1行を検証し、人と可用性の書き込み予定を ctx に積む */
function importStaffRow_(row, ctx, defaults) {
  const errors = [];

  const name = trimStr_(row.name);
  if (!name) errors.push('氏名を入力してください');
  if (name.length > 50) errors.push('氏名が長すぎます');

  const contact = trimStr_(row.contact);
  if (contact.length > 100) errors.push('連絡先が長すぎます');

  const gender = parseImportGender_(row.gender, errors);
  const age = parseImportAge_(row.age, errors);
  const dates = parseImportDates_(row, errors);
  const range = parseImportTimes_(row, defaults, errors);

  if (errors.length > 0) {
    ctx.failed++;
    const reason = errors.join(' / ');
    ctx.errors.push(row._row + '行目' + (name ? '（' + name + '）' : '') + ': ' + reason);
    ctx.results.push({ row: row._row, status: 'エラー: ' + reason });
    return;
  }

  const input = {
    name: name,
    kana: trimStr_(row.kana),
    gender: gender,
    age: age,
    contact: contact,
    note: trimStr_(row.note),
    personId: trimStr_(row.person_id)
  };

  const person = resolveImportPerson_(input, ctx);
  if (!person.isNew) ctx.reused++;

  dates.forEach(function (date) {
    ctx.availability.push({
      personId: person.id, date: date, start: range.start, end: range.end
    });
  });

  ctx.results.push({
    row: row._row,
    // 日付を書かない行は「毎日出る」。日数を書くと0日と読めて誤解を招く
    status: person.status + ' / ' + (dates.length > 0
      ? dates.length + '日分'
      : '勤務日の指定なし（毎日候補に出ます）'),
    person_id: person.id,
    imported_at: nowStamp_()
  });
}

// ---------------------------------------------------------------------------
// 人マスタ
// ---------------------------------------------------------------------------

/**
 * 行が指す人を決める。見つからなければ新しく作る（書き込みはまだしない）。
 *
 * 探す順番には意味がある。**上から順に「確かさ」が下がる。**
 *   1. 前回の取り込みで書き戻した `person_id`（同じ行の続き。いちばん確か）
 *   2. 同じ実行の中で既に出てきた 氏名＋連絡先（1人の複数時間帯を行で分けた場合）
 *   3. 人マスタの 氏名＋連絡先 の完全一致（応募フォームと同じ照合規則）
 *   4. どれにも当たらなければ新規
 *
 * 連絡先が空の行は 3 を試さない。同姓同名の別人を勝手に統合しないため。
 * （2 は同じ実行の中の話なので、連絡先が空でも同じ人とみなす）
 */
function resolveImportPerson_(input, ctx) {
  const key = input.name + '\n' + input.contact;

  // 1. 前回の取り込みで書き戻したID
  if (input.personId) {
    const id = resolvePersonId_(input.personId, ctx.byId);
    if (ctx.byId.has(id)) {
      ctx.personIdByKey[key] = id;
      queuePersonPatch_(id, input, ctx);
      return { id: id, isNew: false, status: '既存の人に追加' + typeCaution_(id, ctx) };
    }
    // ID が人マスタに無い（消された・打ち間違い）。下へ進んで探し直す
  }

  // 2. 同じ実行の中で既に出てきた人
  if (ctx.personIdByKey[key]) {
    return { id: ctx.personIdByKey[key], isNew: false, status: '同じ人の別の時間帯として追加' };
  }

  // 3. 人マスタの 氏名＋連絡先 の完全一致
  if (input.contact) {
    const matched = ctx.people.filter(function (p) {
      return trimStr_(p.name) === input.name && trimStr_(p.contact) === input.contact;
    });
    if (matched.length > 0) {
      const id = resolvePersonId_(matched[0].id, ctx.byId);
      ctx.personIdByKey[key] = id;
      queuePersonPatch_(id, input, ctx);
      return { id: id, isNew: false, status: '既存の人に追加' + typeCaution_(id, ctx) };
    }
  }

  // 4. 新規。ID はここで決める（可用性を先に組み立てるため）
  const id = newId_();
  ctx.newPeople.push({
    id: id,
    name: input.name,
    kana: input.kana,
    gender: input.gender || GENDER.UNDISCLOSED,
    age: input.age,
    type: PERSON_TYPE.STAFF,
    contact: input.contact,
    is_recurring: true,  // 職員は毎回候補に出す（service_entry.js と揃える）
    merged_into: '',
    note: input.note
  });
  ctx.personIdByKey[key] = id;
  return { id: id, isNew: true, status: '新しく登録' };
}

/**
 * 既存の人が職員でなかったときの注記。
 *
 * **種別は書き換えない。** ボランティアとして登録済みの人がこのシートに現れても、
 * 一括登録の都合で職員に変えてよい理由が無い。気づけるように status に残すだけにする。
 */
function typeCaution_(id, ctx) {
  const person = ctx.byId.get(id);
  if (!person || trimStr_(person.type) === PERSON_TYPE.STAFF) return '';
  return '（種別は ' + trimStr_(person.type) + ' のままです）';
}

/**
 * 既存の人への更新を積む。**シートに書かれている列だけを上書きする。**
 *
 * 未記入の列で既存の値を消さないこと。一括登録シートは毎回すべての列を
 * 埋め直すとは限らず、空欄は「変えない」の意味で使われる。
 */
function queuePersonPatch_(id, input, ctx) {
  const current = ctx.byId.get(id) || {};
  const patch = ctx.patches[id] || { id: id };

  if (input.kana && input.kana !== trimStr_(current.kana)) patch.kana = input.kana;
  if (input.gender && input.gender !== trimStr_(current.gender)) patch.gender = input.gender;
  if (input.age !== null && input.age !== current.age) patch.age = input.age;
  if (input.contact && input.contact !== trimStr_(current.contact)) patch.contact = input.contact;
  if (input.note && input.note !== trimStr_(current.note)) patch.note = input.note;

  if (Object.keys(patch).length > 1) ctx.patches[id] = patch;
}

// ---------------------------------------------------------------------------
// 入力の検証
// ---------------------------------------------------------------------------

/**
 * 性別を読む。**未記入は空文字を返す**（新規なら undisclosed、既存なら触らない）。
 * 日本語の書き方も受ける（GENDER_ALIASES）。
 */
function parseImportGender_(raw, errors) {
  const s = trimStr_(raw);
  if (s === '') return '';

  const lower = s.toLowerCase();
  if (GENDER_VALUES.indexOf(lower) !== -1) return lower;

  const alias = GENDER_ALIASES[s] || GENDER_ALIASES[lower];
  if (alias) return alias;

  errors.push('性別は ' + GENDER_VALUES.join(' / ') +
    ' か 男性 / 女性 / その他 / 回答しない で入力してください（' + s + '）');
  return '';
}

/**
 * 年齢を読む。**未記入は null**（応募フォームと違い、一括登録では任意）。
 * 書き方の規則は応募フォームと同じ（service_entry.js `parseAge_`）。
 */
function parseImportAge_(raw, errors) {
  const s = trimStr_(raw);
  if (s === '') return null;
  if (!/^[0-9]+$/.test(s)) {
    errors.push('年齢は半角数字で入力してください（' + s + '）');
    return null;
  }
  const n = Number(s);
  if (n < AGE_MIN || n > AGE_MAX) {
    errors.push('年齢は' + AGE_MIN + '〜' + AGE_MAX + 'の間で入力してください（' + s + '）');
    return null;
  }
  return n;
}

/**
 * 勤務する日を配列にする。終了日が空なら開始日の1日だけ。
 *
 * **開始日は任意。** 職員は申告が無くても既定の勤務時間帯で毎日候補に出るため
 * （service_board.js `appendStaffDefaultAvailability_`）、日付を書かない行は
 * 人の登録だけを行う。**日付を書いた日はその申告が既定より優先される**ので、
 * 「この日は早番」のような例外を表せる。
 *
 * ただし終了日や時刻だけが書かれている行はエラーにする。
 * 開始日の書き忘れを「毎日出るからいい」と黙って流すと、意図した勤務が消える。
 */
function parseImportDates_(row, errors) {
  const start = trimStr_(row.start_date);
  if (start === '') {
    const others = ['end_date', 'start_time', 'end_time'].filter(function (id) {
      return trimStr_(row[id]) !== '';
    });
    if (others.length > 0) {
      errors.push('start_date を入力してください（' + others.join(' / ') + ' だけでは日が決まりません）');
    }
    return [];
  }
  if (!isValidDateStr_(start)) {
    errors.push('start_date は 2026-08-10 の形式で入力してください（' + start + '）');
    return [];
  }

  const end = trimStr_(row.end_date) || start;
  if (!isValidDateStr_(end)) {
    errors.push('end_date は 2026-08-10 の形式で入力してください（' + end + '）');
    return [];
  }

  const days = diffDays_(start, end);
  if (days < 0) {
    errors.push('end_date は start_date より後にしてください');
    return [];
  }
  if (days + 1 > STAFF_IMPORT_MAX_DAYS) {
    errors.push('1行で指定できるのは' + STAFF_IMPORT_MAX_DAYS + '日までです（' +
      (days + 1) + '日ぶん指定されています）');
    return [];
  }
  return dateRange_(start, end);
}

/**
 * 勤務する時間帯を分単位に直す。未記入なら `_config` の既定値を使う。
 * 24時以降（`26:00` など）は翌日を表す（util.js `isValidTimeStr_`）。
 */
function parseImportTimes_(row, defaults, errors) {
  const start = trimStr_(row.start_time) || defaults.start;
  const end = trimStr_(row.end_time) || defaults.end;

  if (!isValidTimeStr_(start) || !isValidTimeStr_(end)) {
    errors.push('時刻は 10:00 の形式で入力してください（' + start + '〜' + end +
      '）。24時以降は 26:00 のように書きます');
    return null;
  }
  if (toMinutes_(start) >= toMinutes_(end)) {
    errors.push('end_time は start_time より後にしてください（' + start + '〜' + end + '）');
    return null;
  }
  if (!isOnUnit_(start, defaults.unit) || !isOnUnit_(end, defaults.unit)) {
    errors.push('時刻は' + defaults.unit + '分単位で入力してください（' + start + '〜' + end + '）');
    return null;
  }
  return { start: toMinutes_(start), end: toMinutes_(end) };
}

// ---------------------------------------------------------------------------
// 可用性（一括版）
// ---------------------------------------------------------------------------

/**
 * 可用性をまとめて追加する。
 *
 * 規則は応募受付の `addAvailability_`（service_entry.js）と同じ。
 *   - 既存の申告との**和集合**を取る。可用な時間が減ることはない
 *   - 重なり・隣接は1本にまとめる（`mergeRanges_`）
 *   - 統合後の姿と一致する既存行はそのまま残し、無駄な書き換えをしない
 *
 * **違いはシートアクセスの回数だけ。** 1件ずつ `addAvailability_` を呼ぶと、
 * 人数×日数ぶん可用性シートを読み書きすることになる（20人×7日で140往復）。
 * ここでは全体で「読み1回・削除1回・追加1回」に抑える。
 *
 * 時刻が壊れている既存行（手で書き換えられた等）は**触らない。**
 * 消すと申告が失われ、残すと重複するが、一括登録の都合で人の申告を消すべきではない。
 *
 * @param {Array<{personId: string, date: string, start: number, end: number}>} requests 分単位
 * @return {{ addedCount: number, removedCount: number }}
 */
function addAvailabilityBatch_(requests) {
  if (!requests || requests.length === 0) return { addedCount: 0, removedCount: 0 };

  const plan = planAvailabilityBatch_(readTable_(SHEET_DEFS.AVAILABILITY), requests);

  if (plan.removeIds.length > 0) deleteRowsById_(SHEET_DEFS.AVAILABILITY, plan.removeIds);
  if (plan.inserts.length > 0) insertRows_(SHEET_DEFS.AVAILABILITY, plan.inserts);

  return { addedCount: plan.inserts.length, removedCount: plan.removeIds.length };
}

/**
 * 既存の可用性と追加したい区間から、消す行と足す行を決める。**シートには触らない。**
 *
 * 計算だけを切り出してあるのは、test_staff_import.js から
 * 本物のデータを壊さずに検証できるようにするため。
 *
 * @param {Array<Object>} existingRows availability シートの行
 * @param {Array<{personId, date, start, end}>} requests
 * @return {{ removeIds: Array<string>, inserts: Array<Object> }}
 */
function planAvailabilityBatch_(existingRows, requests) {
  const existingByKey = {};
  existingRows.forEach(function (r) {
    const key = r.person_id + '\n' + r.date;
    if (!existingByKey[key]) existingByKey[key] = [];
    existingByKey[key].push(r);
  });

  // 同じ人・同じ日への申告は、突き合わせる前に1つにまとめる
  const wantedByKey = {};
  requests.forEach(function (req) {
    const key = req.personId + '\n' + req.date;
    if (!wantedByKey[key]) {
      wantedByKey[key] = { personId: req.personId, date: req.date, ranges: [] };
    }
    wantedByKey[key].ranges.push({ start: req.start, end: req.end });
  });

  const removeIds = [];
  const inserts = [];

  Object.keys(wantedByKey).forEach(function (key) {
    const wanted = wantedByKey[key];
    const existing = existingByKey[key] || [];

    const existingRanges = [];
    existing.forEach(function (r) {
      if (!isValidTimeStr_(r.start_time) || !isValidTimeStr_(r.end_time)) return;
      existingRanges.push({ start: toMinutes_(r.start_time), end: toMinutes_(r.end_time) });
    });

    const merged = mergeRanges_(existingRanges.concat(wanted.ranges));
    const mergedKeys = {};
    merged.forEach(function (m) { mergedKeys[m.start + '-' + m.end] = true; });

    const keepKeys = {};
    existing.forEach(function (r) {
      if (!isValidTimeStr_(r.start_time) || !isValidTimeStr_(r.end_time)) return;
      const k = toMinutes_(r.start_time) + '-' + toMinutes_(r.end_time);
      if (mergedKeys[k] && !keepKeys[k]) keepKeys[k] = true;
      else removeIds.push(r.id);  // 統合で吸収された行、または重複行
    });

    merged.forEach(function (m) {
      if (keepKeys[m.start + '-' + m.end]) return;
      inserts.push({
        person_id: wanted.personId,
        date: wanted.date,
        start_time: toHHMM_(m.start),
        end_time: toHHMM_(m.end)
      });
    });
  });

  return { removeIds: removeIds, inserts: inserts };
}

// ---------------------------------------------------------------------------
// 結果の書き戻し・表示
// ---------------------------------------------------------------------------

/**
 * 取り込み結果を `status` / `person_id` / `imported_at` の3列へ書き戻す。
 *
 * **列ごとに1回の setValues にまとめる。** 行単位で書くと、行数ぶんの
 * シートアクセスが発生する（CLAUDE.md 開発ルール）。
 * 結果を持たない行（空行など）は既存の値をそのまま書き戻すので変化しない。
 */
function writeStaffImportResults_(sheet, results) {
  if (!results || results.length === 0) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const colMap = getColumnMap_(sheet);
  const height = lastRow - 1;

  ['status', 'person_id', 'imported_at'].forEach(function (colId) {
    const i = colMap[colId];
    if (i === undefined) return;

    const range = sheet.getRange(2, i + 1, height, 1);
    const values = range.getValues();
    let touched = false;

    results.forEach(function (r) {
      if (r[colId] === undefined) return;
      const idx = r.row - 2;
      if (idx < 0 || idx >= height) return;
      values[idx][0] = r[colId];
      touched = true;
    });

    if (touched) range.setValues(values);
  });
}

/** 取り込み結果を人が読む文章にする（実行ログとダイアログで共用） */
function formatStaffImportResult_(result) {
  if (result.sheetCreated) {
    return '一括登録用のシート「' + SHEET_DEFS.STAFF_IMPORT.name + '」を作りました。\n' +
      '氏名と勤務する日・時間帯を記入して、もう一度実行してください。\n' +
      '（各列の書き方は、1行目の見出しのメモに書いてあります）';
  }
  if (result.total === 0) {
    return 'シート「' + SHEET_DEFS.STAFF_IMPORT.name + '」に取り込む行がありません。';
  }

  const lines = [
    '取り込んだ行: ' + (result.total - result.failed) + ' / ' + result.total + '行',
    '新しく登録した職員: ' + result.created + '人',
    '既存の人に追加した行: ' + result.reused + '行',
    '勤務できる時間帯: ' + result.availabilityAdded + '件を登録'
  ];

  if (result.failed > 0) {
    lines.push('');
    lines.push('取り込めなかった行: ' + result.failed + '行');
    result.errors.slice(0, 10).forEach(function (e) { lines.push('  ・' + e); });
    if (result.errors.length > 10) {
      lines.push('  … ほか ' + (result.errors.length - 10) + '行');
    }
    lines.push('');
    lines.push('※ 同じ内容を各行の status 列にも書いています。');
    lines.push('  直してもう一度実行してください（取り込み済みの行が二重に登録されることはありません）。');
  }

  return lines.join('\n');
}
