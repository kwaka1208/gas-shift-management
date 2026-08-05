/**
 * service_assign.gs … 枠への割り当てと解除
 *
 * 【枠の作られ方は2通りある】
 *
 *   1. 先に枠を作っておく … 週テンプレートからの生成、日/週コピー（service_slot.gs）
 *   2. **割り当てのときに作る** … 場所と人と時間を選ぶと、その時間の枠ができて人が入る
 *
 * 2 が普段の運用で、1 は「まだ誰も入っていない枠」を先に置きたいときに使う。
 * どちらも行き着く先は同じ `slots` の1行なので、データの形は変わらない。
 *
 * 同じ日付・場所・開始・終了の枠が既にあれば**それを使い回す**。
 * 同じ時間の枠がいくつも増えると、配置表が段だらけになって読めなくなるため。
 * 使い回した枠が既に埋まっていれば `doAssign_` が弾く（1枠1人）。
 *
 * 【このファイルの3つの約束】
 *
 * 1. **すべて Lock 内で実行する**（呼び出し元の api.gs が withLock_ に包む）。
 *    候補者の絞り込みはクライアント側で計算しているため、その計算は
 *    「画面を開いた時点のデータ」に基づく。書く直前にサーバーで読み直して
 *    再検証しない限り、二重割り当てを防げない（design.md 7 排他制御）。
 *
 * 2. **弾くのは「事実として成立しない割り当て」と「1枠1人」だけにする。**
 *    - **1つの枠に2人目 … 弾く**（design.md 6.6）。同じ時間に複数人を置きたい場合は、
 *      場所を複数作って運用する
 *    - 同日の重なる枠への割り当て … 弾く（体はひとつしかない）
 *    - 可用性が枠を覆っていない … **弾かない。** design.md 6.5 の考え方（警告は表示のみ、
 *      自動削除はしない）に合わせ、Phase 4 で `no_availability` 警告として出す
 *
 * 3. **解除は冪等に扱う。**
 *    画面は楽観的更新（先に消してから送信）で動く。既に消えている行への解除を
 *    エラーにすると、消えたはずの人が画面に復活する。見た目と実態が合う方を選ぶ。
 */

/**
 * すでにある枠に人を割り当てる（design.md 7 `assign`）。
 *
 * @param {string} slotId
 * @param {string} personId
 * @param {string} operator 操作者名（記名）
 * @return {{ assignment: Object }}
 */
function assignData_(slotId, personId, operator) {
  const sid = trimStr_(slotId);
  if (!sid) throw new Error('枠が指定されていません。');

  const slot = readTable_(SHEET_DEFS.SLOTS, function (r) { return r.id === sid; })[0];
  if (!slot) {
    throw new Error('枠が見つかりません。他の端末で削除された可能性があります。画面を更新してください。');
  }
  return doAssign_(slot, personId, operator);
}

/**
 * 時間を指定して人を入れる（design.md 7 `assignToNewSlot`）。
 * 指定された時間の枠を用意してから割り当てる。
 *
 * 場所の空いているところをタップしたときと、既存の枠に別の時間で人を入れたいときの
 * 両方から呼ばれる。**呼び出し側は枠があるかどうかを気にしなくてよい。**
 *
 * @param {Object} input date / place_id / start_time / end_time / person_id
 * @param {string} operator 操作者名（記名）
 * @return {{ slot: Object, slotCreated: boolean, assignment: Object }}
 */
function assignToNewSlotData_(input, operator) {
  const payload = input || {};
  const date = trimStr_(payload.date);
  if (!isValidDateStr_(date)) throw new Error('日付の指定が正しくありません。');

  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));
  const unit = Number(getConfigValue_(CONFIG_KEY.SLOT_UNIT_MINUTES, 10)) || 10;

  // 枠の検証は枠の編集と同じものを使う。入口が違っても通す検査は同じにする
  const errors = [];
  const cleaned = validateSlotInput_({
    place_id: payload.place_id,
    start_time: payload.start_time,
    end_time: payload.end_time,
    // 1つの枠に入れるのは1人まで（design.md 6.6）。人数は常に固定
    required_count: SLOT_REQUIRED_COUNT,
    staff_required: payload.staff_required,
    note: payload.note
  }, date, placeById, unit, '枠', errors, null); // 新規作成なので場所の検証は厳格でよい
  if (errors.length > 0) throw new Error(errors.join('\n'));

  const found = findOrCreateSlot_(cleaned, operator);
  const result = doAssign_(found.slot, payload.person_id, operator);

  result.slot = publicSlot_(found.slot);
  result.slotCreated = found.created;
  return result;
}

/**
 * 同じ日付・場所・開始・終了の枠を探し、無ければ作る。
 *
 * 探してから作るのは、同じ時間の枠が二重にできるのを防ぐため。
 * ここは Lock の内側なので、探した直後に他の人が作ることはない。
 */
function findOrCreateSlot_(cleaned, operator) {
  const same = readTable_(SHEET_DEFS.SLOTS, function (r) {
    return r.date === cleaned.date &&
      r.place_id === cleaned.place_id &&
      r.start_time === cleaned.start_time &&
      r.end_time === cleaned.end_time;
  })[0];

  if (same) {
    // 既にある枠にそのまま入れる（同じ時間の枠を二重に作らない）
    return { slot: same, created: false };
  }

  const inserted = insertRows_(SHEET_DEFS.SLOTS, [cleaned])[0];
  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));
  appendLog_(operator, 'create_slot', inserted.id,
    cleaned.date + ' ' + placeName_(placeById, cleaned.place_id) + ' ' +
    cleaned.start_time + '–' + cleaned.end_time);

  return { slot: inserted, created: true };
}

/** 枠を画面へ返す形にする（readSlotsByDate_ と同じ形） */
function publicSlot_(slot) {
  return {
    id: slot.id,
    date: slot.date,
    place_id: slot.place_id,
    start_time: slot.start_time,
    end_time: slot.end_time,
    required_count: slot.required_count === null ? 0 : Number(slot.required_count),
    staff_required: slot.staff_required === null ? 0 : Number(slot.staff_required),
    note: trimStr_(slot.note)
  };
}

/**
 * 割り当ての本体。枠がどう用意されたかに関わらず、ここを必ず通す。
 *
 * @param {Object} slot slots の行（id / date / place_id / start_time / end_time / required_count）
 */
function doAssign_(slot, personId, operator) {
  const inputPersonId = trimStr_(personId);
  if (!inputPersonId) throw new Error('割り当てる人を選んでください。');

  const people = readTable_(SHEET_DEFS.PEOPLE);
  const peopleById = indexById_(people);
  // 名寄せ済みの人が指定されたら統合先へ読み替える（design.md `merged_into`）
  const pid = resolvePersonId_(inputPersonId, peopleById);
  const person = peopleById.get(pid);
  if (!person) {
    throw new Error('人が見つかりません。画面を更新してください。');
  }

  // --- 同日の状況を読み直す ------------------------------------------------
  const daySlots = readTable_(SHEET_DEFS.SLOTS, function (r) { return r.date === slot.date; });
  const daySlotById = indexById_(daySlots);
  const dayAssignments = readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) {
    return daySlotById.has(r.slot_id);
  });

  const mine = dayAssignments.filter(function (a) {
    return resolvePersonId_(a.person_id, peopleById) === pid;
  });

  // --- 検証 ---------------------------------------------------------------
  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));

  /*
    **1つの枠に入れるのは1人まで**（design.md 6.6）。
    複数人を置きたい場所は、場所そのものを複数作って運用する。

    本人が既に入っている場合と、別の人が入っている場合とで文言を分ける。
    「埋まっている」とだけ言われても、画面を更新すべきなのか
    自分の操作が重複したのかが分からないため。
  */
  const occupied = dayAssignments.filter(function (a) { return a.slot_id === slot.id; })[0];
  if (occupied) {
    if (resolvePersonId_(occupied.person_id, peopleById) === pid) {
      throw new Error(person.name + 'さんは、この枠に既に割り当てられています。');
    }
    const who = peopleById.get(resolvePersonId_(occupied.person_id, peopleById));
    throw new Error('この枠には既に' + (who ? who.name + 'さん' : '別の人') +
      'が入っています。1つの枠に入れるのは1人までです。\n' +
      '先にその人を解除するか、「時間を指定して入れる」から別の枠を作ってください。');
  }

  const start = toMinutes_(slot.start_time);
  const end = toMinutes_(slot.end_time);

  const conflict = mine.filter(function (a) {
    const other = daySlotById.get(a.slot_id);
    if (!other) return false;
    return overlaps_(start, end, toMinutes_(other.start_time), toMinutes_(other.end_time));
  })[0];

  if (conflict) {
    const other = daySlotById.get(conflict.slot_id);
    throw new Error(person.name + 'さんは同じ時間に「' + placeName_(placeById, other.place_id) + ' ' +
      toDisplayTime_(other.start_time) + '–' + toDisplayTime_(other.end_time) +
      '」へ割り当て済みです。先にそちらを解除してください。');
  }

  // --- 書き込み -----------------------------------------------------------
  const inserted = insertRows_(SHEET_DEFS.ASSIGNMENTS, [{
    slot_id: slot.id,
    person_id: pid,
    assigned_by: operator
  }])[0];

  const placeLabel = placeName_(placeById, slot.place_id) + ' ' + slot.start_time + '–' + slot.end_time;
  appendLog_(operator, 'assign', inserted.id,
    slot.date + ' ' + placeLabel + ' / ' + person.name);

  return {
    assignment: {
      id: inserted.id,
      slot_id: slot.id,
      person_id: pid,
      assigned_by: operator
    }
  };
}

/**
 * 割り当てを解除する（design.md 7 `unassign`）。
 *
 * 既に無い場合もエラーにしない（冒頭の約束3）。
 * **枠は残す。** 誰もいなくなった枠を自動で消すと、割り当てをやり直すたびに
 * 枠が消えたり生えたりして、先に立てた予定が失われる。
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

  deleteRowsById_(SHEET_DEFS.ASSIGNMENTS, [aid]);
  appendLog_(operator, 'unassign', aid, describeAssignment_(assignment));

  return { removed: true, already: false };
}

/**
 * `_log` に残す解除の内容。
 *
 * 行を消してしまうと後から誰を外したのか分からなくなるため、
 * 名前と枠をこの時点で文字列に焼き付けておく。運用者がシートで追える形にすることが目的。
 */
function describeAssignment_(assignment) {
  const slot = readTable_(SHEET_DEFS.SLOTS, function (r) { return r.id === assignment.slot_id; })[0];
  const person = readTable_(SHEET_DEFS.PEOPLE, function (r) { return r.id === assignment.person_id; })[0];
  const who = person ? person.name : '(不明な人)';
  if (!slot) return who + ' / (削除済みの枠)';

  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));
  return slot.date + ' ' + placeName_(placeById, slot.place_id) + ' ' +
    slot.start_time + '–' + slot.end_time + ' / ' + who;
}
