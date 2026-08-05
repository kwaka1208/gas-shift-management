/**
 * service_assign.gs … 割り当ての作成・編集・解除
 *
 * 【1行が「誰がどこにいつ入るか」を丸ごと表す】
 *
 * かつては slots（枠）と assignments（割り当て）に分かれており、
 * 「枠を作ってから人を入れる」「人を入れると枠ができる」の2経路があった。
 * **1つの枠に入るのは1人まで**という方針にした結果、枠と割り当ては常に1対1になり、
 * 分けて持つ意味が無くなったため統合した（design.md 3 / 6.6）。
 *
 * 経路も1つになった。**場所・日付・時間帯・人を決めると、割り当てが1行できる。**
 *
 * 代わりに失ったものがある。**「必要だがまだ誰もいない」を表せない。**
 * 不足の可視化が要るなら、場所ごとの必要時間帯を別テーブルで持つところから設計し直すこと。
 *
 * 【このファイルの3つの約束】
 *
 * 1. **すべて Lock 内で実行する**（呼び出し元の api.gs が withLock_ に包む）。
 *    候補者の絞り込みはクライアント側で計算しているため、その計算は
 *    「画面を開いた時点のデータ」に基づく。書く直前にサーバーで読み直して
 *    再検証しない限り、二重割り当てを防げない（design.md 7 排他制御）。
 *
 * 2. **弾くのは「事実として成立しない割り当て」だけにする。**
 *    - **同じ場所・同じ時間に2人目 … 弾く**（design.md 6.6）。同じ時間に複数人を
 *      置きたい場合は、場所を複数作って運用する
 *    - 同じ人が同日の重なる時間に二重 … 弾く（体はひとつしかない）
 *    - 可用性が時間帯を覆っていない … **弾かない。** design.md 6.5 の考え方
 *      （警告は表示のみ、自動削除はしない）に合わせる
 *
 * 3. **解除は冪等に扱う。**
 *    画面は楽観的更新（先に消してから送信）で動く。既に消えている行への解除を
 *    エラーにすると、消えたはずの人が画面に復活する。見た目と実態が合う方を選ぶ。
 */

/** メモの最大文字数 */
const ASSIGNMENT_NOTE_MAX = 100;

/**
 * 割り当てを1件作る（design.md 7 `assign`）。
 *
 * @param {Object} input date / place_id / start_time / end_time / person_id / note
 * @param {string} operator 操作者名（記名）
 * @return {{ assignment: Object }}
 */
function assignData_(input, operator) {
  const cleaned = validateAssignmentInput_(input);
  const peopleById = indexById_(readTable_(SHEET_DEFS.PEOPLE));
  const person = resolvePerson_(cleaned.person_id, peopleById);

  checkConflicts_(cleaned, person.id, null, peopleById);

  const inserted = insertRows_(SHEET_DEFS.ASSIGNMENTS, [{
    date: cleaned.date,
    place_id: cleaned.place_id,
    start_time: cleaned.start_time,
    end_time: cleaned.end_time,
    person_id: person.id,
    note: cleaned.note,
    assigned_by: operator
  }])[0];

  appendLog_(operator, 'assign', inserted.id, describeAssignment_(inserted, person.name));

  return { assignment: publicAssignment_(inserted) };
}

/**
 * 既にある割り当ての場所・時間帯・メモを直す（design.md 7 `saveAssignment`）。
 *
 * **人は変えない。** 人を替えるのは「解除してから入れ直す」操作であり、
 * ここで一緒にできるようにすると、`_log` 上で誰がいつ外れたのかが追えなくなる。
 *
 * @param {Object} input id / place_id / start_time / end_time / note
 * @param {string} operator 操作者名（記名）
 */
function saveAssignmentData_(input, operator) {
  const payload = input || {};
  const id = trimStr_(payload.id);
  if (!id) throw new Error('編集する割り当てが指定されていません。');

  const current = readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) { return r.id === id; })[0];
  if (!current) {
    throw new Error('この割り当ては見つかりません。他の端末で解除された可能性があります。画面を更新してください。');
  }

  // 日付と人は動かさない。画面から送られてきても現在の値を使う
  const cleaned = validateAssignmentInput_({
    date: current.date,
    place_id: payload.place_id,
    start_time: payload.start_time,
    end_time: payload.end_time,
    person_id: current.person_id,
    note: payload.note
  });

  const peopleById = indexById_(readTable_(SHEET_DEFS.PEOPLE));
  const person = resolvePerson_(current.person_id, peopleById);

  // 自分自身は衝突相手から除く
  checkConflicts_(cleaned, person.id, id, peopleById);

  updateRowsById_(SHEET_DEFS.ASSIGNMENTS, [{
    id: id,
    place_id: cleaned.place_id,
    start_time: cleaned.start_time,
    end_time: cleaned.end_time,
    note: cleaned.note
  }]);

  const updated = readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) { return r.id === id; })[0];
  appendLog_(operator, 'save_assignment', id, describeAssignment_(updated, person.name));

  return { assignment: publicAssignment_(updated) };
}

/**
 * 割り当てを解除する（design.md 7 `unassign`）。
 * 既に無い場合もエラーにしない（冒頭の約束3）。
 *
 * @param {string} assignmentId
 * @param {string} operator 操作者名（記名）
 * @return {{ removed: boolean, already: boolean }}
 */
function unassignData_(assignmentId, operator) {
  const aid = trimStr_(assignmentId);
  if (!aid) throw new Error('解除する割り当てが指定されていません。');

  const assignment = readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) { return r.id === aid; })[0];
  if (!assignment) {
    return { removed: true, already: true };
  }

  const person = readTable_(SHEET_DEFS.PEOPLE, function (r) {
    return r.id === assignment.person_id;
  })[0];

  deleteRowsById_(SHEET_DEFS.ASSIGNMENTS, [aid]);
  appendLog_(operator, 'unassign', aid,
    describeAssignment_(assignment, person ? person.name : '(不明な人)'));

  return { removed: true, already: false };
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

/**
 * 割り当ての入力を検証して整える。
 * **作成と編集で同じものを通す。** 入口が違っても検査は同じにする。
 */
function validateAssignmentInput_(input) {
  const payload = input || {};
  const errors = [];

  const date = trimStr_(payload.date);
  if (!isValidDateStr_(date)) errors.push('日付の指定が正しくありません。');

  const placeId = trimStr_(payload.place_id);
  if (!placeId) {
    errors.push('場所を選んでください。');
  } else if (!indexById_(readTable_(SHEET_DEFS.PLACES)).has(placeId)) {
    errors.push('この場所は places シートにありません（place_id: ' + placeId + '）。');
  }

  const unit = Number(getConfigValue_(CONFIG_KEY.SLOT_UNIT_MINUTES, 10)) || 10;
  const start = trimStr_(payload.start_time);
  const end = trimStr_(payload.end_time);

  if (!isValidTimeStr_(start) || !isValidTimeStr_(end)) {
    errors.push('時刻は HH:mm の形式で指定してください（24時以降は翌日を表します）。');
  } else {
    if (toMinutes_(start) >= toMinutes_(end)) {
      errors.push('終了時刻は開始時刻より後にしてください。');
    }
    if (!isOnUnit_(start, unit) || !isOnUnit_(end, unit)) {
      errors.push('時刻は ' + unit + ' 分単位で指定してください。');
    }
  }

  const personId = trimStr_(payload.person_id);
  if (!personId) errors.push('割り当てる人を選んでください。');

  const note = trimStr_(payload.note);
  if (note.length > ASSIGNMENT_NOTE_MAX) {
    errors.push('メモは' + ASSIGNMENT_NOTE_MAX + '文字までです。');
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));

  return {
    date: date,
    place_id: placeId,
    start_time: start,
    end_time: end,
    person_id: personId,
    note: note
  };
}

/** 名寄せを解決して人を取り出す。見つからなければ例外 */
function resolvePerson_(personId, peopleById) {
  const pid = resolvePersonId_(trimStr_(personId), peopleById);
  const person = peopleById.get(pid);
  if (!person) {
    throw new Error('人が見つかりません。画面を更新してください。');
  }
  return person;
}

/**
 * 指定日のタイムライン上に載る割り当てを、すべて分単位で返す。
 *
 * **前後の日も見る。** 時刻は24時間制の延長で持つため（design.md 5.1）、
 * 日をまたぐ割り当ては前日の行として存在する。日付の完全一致だけで探すと、
 *   - 8/10 の `22:00–26:00` と 8/11 の `00:00–02:00`
 * が「別の日だから重ならない」と判定され、**同じ場所に2人立つ**。
 *
 * 前日の行は24時間ぶん戻し、翌日の行は24時間ぶん進めて、この日の物差しに揃える。
 *
 * @param {?string} selfId 除外する割り当てID（編集中の自分自身）
 * @return {Array<{start: number, end: number, place_id, person_id, start_time, end_time}>}
 */
function readDayTimeline_(date, selfId) {
  const prev = addDays_(date, -1);
  const next = addDays_(date, 1);

  const rows = readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) {
    return r.id !== selfId && (r.date === date || r.date === prev || r.date === next);
  });

  const out = [];
  rows.forEach(function (r) {
    if (!isValidTimeStr_(r.start_time) || !isValidTimeStr_(r.end_time)) return;
    const shift = r.date === prev ? -DAY_MINUTES_ : (r.date === next ? DAY_MINUTES_ : 0);
    out.push({
      start: toMinutes_(r.start_time) + shift,
      end: toMinutes_(r.end_time) + shift,
      place_id: trimStr_(r.place_id),
      person_id: r.person_id,
      // メッセージには**元の日付の時刻**を出す。シートと突き合わせられる方が直しやすい
      start_time: r.start_time,
      end_time: r.end_time
    });
  });
  return out;
}

/**
 * 衝突を確かめる。**必ずロックの内側で、書く直前に呼ぶこと。**
 *
 * @param {Object} cleaned 検証済みの入力
 * @param {string} personId 名寄せ解決済み
 * @param {?string} selfId 編集中の割り当てID（衝突相手から除く）。新規なら null
 */
function checkConflicts_(cleaned, personId, selfId, peopleById) {
  const start = toMinutes_(cleaned.start_time);
  const end = toMinutes_(cleaned.end_time);

  const overlapping = readDayTimeline_(cleaned.date, selfId).filter(function (a) {
    return overlaps_(start, end, a.start, a.end);
  });

  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));

  /*
    **同じ場所・重なる時間には1人まで**（design.md 6.6）。
    複数人を置きたい場所は、場所そのものを複数作って運用する。
  */
  const placeTaken = overlapping.filter(function (a) {
    return trimStr_(a.place_id) === cleaned.place_id;
  })[0];

  if (placeTaken) {
    const who = peopleById.get(resolvePersonId_(placeTaken.person_id, peopleById));
    if (who && who.id === personId) {
      throw new Error(who.name + 'さんは、この時間に同じ場所へ既に入っています。');
    }
    throw new Error(
      placeName_(placeById, cleaned.place_id) + ' の ' +
      toDisplayTime_(placeTaken.start_time) + '–' + toDisplayTime_(placeTaken.end_time) +
      ' には既に' + (who ? who.name + 'さん' : '別の人') + 'が入っています。\n' +
      '1つの場所の同じ時間に入れるのは1人までです。' +
      'その人を解除するか、場所を分けて登録してください。');
  }

  // 同じ人が同時刻に別の場所へ入っていないか（体はひとつしかない）
  const personTaken = overlapping.filter(function (a) {
    return resolvePersonId_(a.person_id, peopleById) === personId;
  })[0];

  if (personTaken) {
    const person = peopleById.get(personId);
    throw new Error(
      (person ? person.name : 'この人') + 'さんは同じ時間に「' +
      placeName_(placeById, personTaken.place_id) + ' ' +
      toDisplayTime_(personTaken.start_time) + '–' + toDisplayTime_(personTaken.end_time) +
      '」へ割り当て済みです。先にそちらを解除してください。');
  }
}

// ---------------------------------------------------------------------------
// 整形
// ---------------------------------------------------------------------------

/** 割り当てを画面へ返す形にする（readAssignmentsByDate_ と同じ形） */
function publicAssignment_(row) {
  return {
    id: row.id,
    date: row.date,
    place_id: row.place_id,
    start_time: row.start_time,
    end_time: row.end_time,
    person_id: row.person_id,
    note: trimStr_(row.note),
    assigned_by: row.assigned_by
  };
}

/**
 * `_log` に残す内容。
 *
 * 行を消してしまうと後から誰を外したのか分からなくなるため、
 * 名前と場所をこの時点で文字列に焼き付けておく。運用者がシートで追える形にすることが目的。
 * **時刻は保存値のまま**（`25:00`）にする。シートの値と突き合わせられる方が優先。
 */
function describeAssignment_(row, personName) {
  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));
  return row.date + ' ' + placeName_(placeById, row.place_id) + ' ' +
    row.start_time + '–' + row.end_time + ' / ' + personName;
}
