/**
 * service_place.gs … 場所の登録・編集
 *
 * **かつては service_slot.gs という名前で、枠（slots）の保存・テンプレート展開・
 * 日/週コピーも持っていた。枠の概念を廃止したため、場所だけが残った。**
 *
 * 【このファイルの約束】
 *
 * 1. **すべて Lock 内で実行する**（CLAUDE.md 開発ルール / gas.md 5.2）。
 *    呼び出し元の api.gs で withLock_() に包むこと。
 *
 * 2. **検証してから書く。途中で失敗させない。**
 *    入力を全件検証し、1件でも不正なら何も書かずに例外を投げる（all-or-nothing）。
 *    半分だけ書き換わった状態は、シートを直接見る運用者にとって最も厄介なため。
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
// 共通ヘルパー
// ---------------------------------------------------------------------------

/** 場所名。places から消えていても「(不明な場所)」で通す（画面から消さないため） */
function placeName_(placeById, placeId) {
  const place = placeById.get(trimStr_(placeId));
  return place ? place.name : '(不明な場所)';
}
