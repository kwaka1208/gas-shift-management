/**
 * service_slot.gs … 場所と枠の書き込み（登録・編集・テンプレート展開・コピー）
 *
 * 【このファイルの3つの約束】
 *
 * 1. **すべて Lock 内で実行する**（CLAUDE.md 開発ルール / gas.md 5.2）。
 *    呼び出し元の api.gs で withLock_() に包むこと。
 *
 * 2. **検証してから書く。途中で失敗させない。**
 *    入力を全件検証し、1件でも不正なら何も書かずに例外を投げる（all-or-nothing）。
 *    半分だけ書き換わった状態は、シートを直接見る運用者にとって最も厄介なため。
 *
 * 3. **消す前に参照を確かめる。**
 *    割り当てのある枠は削除しない。要件 4.6 の「自動削除は事故のもと」と同じ考え方で、
 *    黙って連鎖削除せず、管理者に判断させる。
 */

// ---------------------------------------------------------------------------
// 場所
// ---------------------------------------------------------------------------

/**
 * 場所をまとめて保存する。画面の一覧をそのまま受け取る想定。
 *
 * **行は消さない。** 廃止は `active=false` で表す（design.md 3 places）。
 * 過去の枠が参照している場所名を消すと、過去の配置表が読めなくなるため。
 *
 * @param {Array<{id?: string, name: string, sort_order?: number, active?: boolean}>} places
 * @param {string} operator 操作者名（記名）
 * @return {{ places: Array }}
 */
function savePlacesData_(places, operator) {
  const input = Array.isArray(places) ? places : [];
  const existing = readTable_(SHEET_DEFS.PLACES);
  const byId = indexById_(existing);

  // --- 検証 ---------------------------------------------------------------
  const errors = [];
  const cleaned = input.map(function (p, i) {
    const label = (i + 1) + '行目';
    const name = trimStr_(p.name);
    if (!name) errors.push(label + ': 場所名を入力してください。');

    const id = trimStr_(p.id);
    if (id && !byId.has(id)) errors.push(label + ': 存在しない場所です（他の端末で削除された可能性があります）。');

    const order = p.sort_order === '' || p.sort_order === null || p.sort_order === undefined
      ? i + 1
      : Number(p.sort_order);
    if (!isFinite(order)) errors.push(label + ': 表示順は数値で指定してください。');

    return { id: id, name: name, sort_order: order, active: p.active !== false };
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));

  // --- 差分だけ書く -------------------------------------------------------
  const inserts = [];
  const updates = [];
  cleaned.forEach(function (p) {
    if (!p.id) {
      inserts.push(p);
      return;
    }
    const current = byId.get(p.id);
    if (current.name !== p.name ||
        Number(current.sort_order) !== p.sort_order ||
        current.active !== p.active) {
      updates.push(p);
    }
  });

  if (inserts.length > 0) insertRows_(SHEET_DEFS.PLACES, inserts);
  if (updates.length > 0) updateRowsById_(SHEET_DEFS.PLACES, updates);

  if (inserts.length > 0 || updates.length > 0) {
    appendLog_(operator, 'save_places', '', '追加 ' + inserts.length + ' 件 / 更新 ' + updates.length + ' 件');
  }
  return { places: readPlaces_() };
}

// ---------------------------------------------------------------------------
// 枠
// ---------------------------------------------------------------------------

/**
 * 指定日の枠をまとめて保存する（design.md 7 `saveSlots(token, date, slots, operator)`）。
 *
 * 画面上は枠を1つずつ編集するが、保存はその日の一覧を丸ごと送ってもらう。
 * 追加・更新・削除を1回の呼び出しで表現でき、クライアントとサーバーの状態が食い違わない。
 *   - `id` 無し           … 追加
 *   - `id` 有り           … 更新
 *   - 送られてこない `id` … 削除
 *
 * @param {string} date 'YYYY-MM-DD'
 * @param {Array<Object>} slots その日の枠の全件
 * @param {string} operator 操作者名（記名）
 */
function saveSlotsData_(date, slots, operator) {
  if (!isValidDateStr_(date)) throw new Error('日付の指定が正しくありません。');

  const input = Array.isArray(slots) ? slots : [];
  const existing = readTable_(SHEET_DEFS.SLOTS, function (r) { return r.date === date; });
  const byId = indexById_(existing);
  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));
  const unit = Number(getConfigValue_(CONFIG_KEY.SLOT_UNIT_MINUTES, 10)) || 10;

  // --- 検証 ---------------------------------------------------------------
  const errors = [];
  const cleaned = [];
  input.forEach(function (s, i) {
    const label = (i + 1) + '件目';
    const id = trimStr_(s.id);
    if (id && !byId.has(id)) {
      errors.push(label + ': 存在しない枠です（他の端末で削除された可能性があります）。');
      return;
    }
    const row = validateSlotInput_(s, date, placeById, unit, label, errors);
    if (row) {
      row.id = id;
      cleaned.push(row);
    }
  });

  // --- 削除対象の確認 -----------------------------------------------------
  const keep = new Set(cleaned.map(function (r) { return r.id; }).filter(function (v) { return v; }));
  const removeIds = existing
    .filter(function (r) { return !keep.has(r.id); })
    .map(function (r) { return r.id; });

  // 割り当てのある枠は消させない。連鎖削除は黙ってやらない（要件 4.6）
  if (removeIds.length > 0) {
    const blocked = countAssignmentsBySlot_(removeIds);
    Object.keys(blocked).forEach(function (slotId) {
      const s = byId.get(slotId);
      errors.push('枠「' + placeName_(placeById, s.place_id) + ' ' + s.start_time + '-' + s.end_time +
        '」には割り当てが ' + blocked[slotId] + ' 件あります。先に割り当てを解除してください。');
    });
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));

  // --- 差分だけ書く -------------------------------------------------------
  const inserts = cleaned.filter(function (r) { return !r.id; });
  const updates = cleaned.filter(function (r) {
    if (!r.id) return false;
    const c = byId.get(r.id);
    return c.place_id !== r.place_id ||
      c.start_time !== r.start_time ||
      c.end_time !== r.end_time ||
      Number(c.required_count) !== r.required_count ||
      Number(c.staff_required) !== r.staff_required ||
      trimStr_(c.note) !== r.note;
  });

  if (inserts.length > 0) insertRows_(SHEET_DEFS.SLOTS, inserts);
  if (updates.length > 0) updateRowsById_(SHEET_DEFS.SLOTS, updates);
  if (removeIds.length > 0) deleteRowsById_(SHEET_DEFS.SLOTS, removeIds);

  if (inserts.length > 0 || updates.length > 0 || removeIds.length > 0) {
    appendLog_(operator, 'save_slots', date,
      '追加 ' + inserts.length + ' / 更新 ' + updates.length + ' / 削除 ' + removeIds.length);
  }
  return { slots: readSlotsByDate_(date) };
}

/**
 * 枠1件分の入力を検証し、シートに書ける形に整えて返す。
 * 不正な場合は errors にメッセージを積み、null を返す。
 *
 * クライアント側でも同じ検証をするが、**サーバー側の検証が本体**（gas.md 5.3）。
 * 匿名アクセス可のデプロイであり、クライアントの検証は迂回できる。
 */
function validateSlotInput_(s, date, placeById, unit, label, errors) {
  let bad = false;

  const placeId = trimStr_(s.place_id);
  if (!placeId || !placeById.has(placeId)) {
    errors.push(label + ': 場所を選んでください。');
    bad = true;
  }

  const start = trimStr_(s.start_time);
  const end = trimStr_(s.end_time);
  if (!isValidTimeStr_(start) || !isValidTimeStr_(end)) {
    errors.push(label + ': 時刻は HH:mm の形式で指定してください。');
    bad = true;
  } else {
    if (toMinutes_(start) >= toMinutes_(end)) {
      errors.push(label + ': 終了時刻は開始時刻より後にしてください。');
      bad = true;
    }
    if (!isOnUnit_(start, unit) || !isOnUnit_(end, unit)) {
      errors.push(label + ': 時刻は ' + unit + ' 分単位で指定してください。');
      bad = true;
    }
  }

  const required = toCount_(s.required_count);
  if (required === null) {
    errors.push(label + ': 必要人数は0以上の整数で指定してください。');
    bad = true;
  }
  const staffRequired = toCount_(s.staff_required);
  if (staffRequired === null) {
    errors.push(label + ': 職員の最低人数は0以上の整数で指定してください。');
    bad = true;
  }
  if (required !== null && staffRequired !== null && staffRequired > required) {
    errors.push(label + ': 職員の最低人数が必要人数を超えています。');
    bad = true;
  }

  if (bad) return null;
  return {
    date: date,
    place_id: placeId,
    start_time: start,
    end_time: end,
    required_count: required,
    staff_required: staffRequired,
    note: trimStr_(s.note)
  };
}

/** 0以上の整数に変換する。不正なら null。空は0とみなす */
function toCount_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return null;
  return n;
}

/** 指定した枠に紐づく割り当て件数。0件の枠はキーを持たない */
function countAssignmentsBySlot_(slotIds) {
  const target = new Set(slotIds);
  const out = {};
  readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) { return target.has(r.slot_id); })
    .forEach(function (a) {
      out[a.slot_id] = (out[a.slot_id] || 0) + 1;
    });
  return out;
}

/** エラーメッセージ用の場所名 */
function placeName_(placeById, placeId) {
  const p = placeById.get(placeId);
  return p ? p.name : '(不明な場所)';
}

// ---------------------------------------------------------------------------
// 週テンプレートからの一括生成
// ---------------------------------------------------------------------------

/**
 * `slot_templates` から指定期間の枠を生成する（要件 4.1 の最優先機能）。
 *
 * `slot_templates` は運用者がシートを直接編集する前提のため、
 * **不正な行があれば1件も作らずに全件のエラーを返す。** 部分的に生成されると、
 * どこまで作られたのか運用者が追えなくなる。
 *
 * 既に同じ枠（日付・場所・開始・終了が一致）があればスキップする。
 * 同じ期間に対して二度実行しても増えないため、やり直しが安全にできる。
 *
 * @return {{ created: number, skipped: number, dates: number }}
 */
function generateSlotsData_(templateName, fromDate, toDate, operator) {
  const name = trimStr_(templateName);
  if (!name) throw new Error('テンプレート名を指定してください。');
  const dates = validateRange_(fromDate, toDate);

  const placeById = indexById_(readTable_(SHEET_DEFS.PLACES));
  const unit = Number(getConfigValue_(CONFIG_KEY.SLOT_UNIT_MINUTES, 10)) || 10;

  const templates = readTable_(SHEET_DEFS.SLOT_TEMPLATES, function (r) {
    return trimStr_(r.template_name) === name;
  });
  if (templates.length === 0) {
    throw new Error('テンプレート「' + name + '」がありません。slot_templates シートを確認してください。');
  }

  // --- テンプレート行の検証 ------------------------------------------------
  const errors = [];
  const valid = [];
  templates.forEach(function (t) {
    const label = 'slot_templates ' + t._row + '行目';
    const dow = Number(t.day_of_week);
    if (!isFinite(dow) || dow < 0 || dow > 6 || Math.floor(dow) !== dow) {
      errors.push(label + ': day_of_week は 0(日)〜6(土) で指定してください。');
      return;
    }
    // 日付は展開時に決まるので、検証には便宜上どの日を渡してもよい
    const row = validateSlotInput_(t, dates[0], placeById, unit, label, errors);
    if (row) valid.push({ dow: dow, row: row });
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));

  // --- 展開 ---------------------------------------------------------------
  const existingKeys = existingSlotKeys_(dates);
  const inserts = [];
  let skipped = 0;

  dates.forEach(function (date) {
    const dow = dayOfWeek_(date);
    valid.forEach(function (v) {
      if (v.dow !== dow) return;
      const row = Object.assign({}, v.row, { date: date });
      const key = slotKey_(row);
      if (existingKeys.has(key)) {
        skipped++;
        return;
      }
      existingKeys.add(key); // テンプレート内の重複行も1件にまとめる
      inserts.push(row);
    });
  });

  if (inserts.length > 0) insertRows_(SHEET_DEFS.SLOTS, inserts);
  appendLog_(operator, 'generate_slots', name,
    dates[0] + '〜' + dates[dates.length - 1] + ' / 作成 ' + inserts.length + ' / 重複 ' + skipped);

  return { created: inserts.length, skipped: skipped, dates: dates.length };
}

// ---------------------------------------------------------------------------
// 日・週のコピー
// ---------------------------------------------------------------------------

/**
 * 枠をコピーする（要件 4.1「前日・前週の枠をコピーできる」）。
 *
 * design.md 7 の `copySlots(token, fromDate, toDate)` に日数を足してある。
 * 「日または週の単位」を1つの関数で表すため、コピーする日数を明示的に受ける。
 *   - 前日コピー: from=昨日, to=今日, dayCount=1
 *   - 前週コピー: from=先週の月曜, to=今週の月曜, dayCount=7
 *
 * コピー先に同じ枠があればスキップする（重複実行で増えない）。
 * **割り当てはコピーしない。** 枠だけを写す。
 *
 * @return {{ created: number, skipped: number, days: number }}
 */
function copySlotsData_(fromDate, toDate, dayCount, operator) {
  if (!isValidDateStr_(fromDate)) throw new Error('コピー元の日付が正しくありません。');
  if (!isValidDateStr_(toDate)) throw new Error('コピー先の日付が正しくありません。');

  const days = (dayCount === undefined || dayCount === null || dayCount === '') ? 1 : Number(dayCount);
  if (!isFinite(days) || days < 1 || days > 31 || Math.floor(days) !== days) {
    throw new Error('コピーする日数は1〜31で指定してください。');
  }
  if (fromDate === toDate) throw new Error('コピー元とコピー先が同じ日です。');

  const offset = diffDays_(fromDate, toDate);
  const sourceDates = [];
  const targetDates = [];
  for (let i = 0; i < days; i++) {
    sourceDates.push(addDays_(fromDate, i));
    targetDates.push(addDays_(toDate, i));
  }

  // 期間が重なっていると、コピー元とコピー先が入り混じって結果が読めなくなる
  if (Math.abs(offset) < days) {
    throw new Error('コピー元とコピー先の期間が重なっています。');
  }

  const sourceSet = new Set(sourceDates);
  const source = readTable_(SHEET_DEFS.SLOTS, function (r) { return sourceSet.has(r.date); });
  if (source.length === 0) {
    return { created: 0, skipped: 0, days: days };
  }

  const existingKeys = existingSlotKeys_(targetDates);
  const inserts = [];
  let skipped = 0;

  source.forEach(function (s) {
    const row = {
      date: addDays_(s.date, offset),
      place_id: s.place_id,
      start_time: s.start_time,
      end_time: s.end_time,
      required_count: s.required_count === null ? 0 : s.required_count,
      staff_required: s.staff_required === null ? 0 : s.staff_required,
      note: s.note
    };
    const key = slotKey_(row);
    if (existingKeys.has(key)) {
      skipped++;
      return;
    }
    existingKeys.add(key);
    inserts.push(row);
  });

  if (inserts.length > 0) insertRows_(SHEET_DEFS.SLOTS, inserts);
  appendLog_(operator, 'copy_slots', fromDate,
    fromDate + ' → ' + toDate + ' / ' + days + '日分 / 作成 ' + inserts.length + ' / 重複 ' + skipped);

  return { created: inserts.length, skipped: skipped, days: days };
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** 同じ枠かどうかの判定キー。必要人数やメモが違っても「同じ枠」とみなす */
function slotKey_(slot) {
  return [slot.date, slot.place_id, slot.start_time, slot.end_time].join('|');
}

/** 指定した日付群に既に存在する枠のキー集合 */
function existingSlotKeys_(dates) {
  const target = new Set(dates);
  const keys = new Set();
  readTable_(SHEET_DEFS.SLOTS, function (r) { return target.has(r.date); })
    .forEach(function (r) { keys.add(slotKey_(r)); });
  return keys;
}

/** 期間を検証して日付配列を返す。長すぎる期間は実行時間の制限に触れる前に止める */
function validateRange_(fromDate, toDate) {
  if (!isValidDateStr_(fromDate) || !isValidDateStr_(toDate)) {
    throw new Error('期間の指定が正しくありません。');
  }
  const dates = dateRange_(fromDate, toDate);
  if (dates.length === 0) throw new Error('終了日は開始日以降にしてください。');
  if (dates.length > 92) throw new Error('一度に生成できるのは92日分（約3か月）までです。');
  return dates;
}
