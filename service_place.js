/**
 * service_place.gs … 役割の登録・編集
 *
 * **かつては service_slot.gs という名前で、枠（slots）の保存・テンプレート展開・
 * 日/週コピーも持っていた。枠の概念を廃止したため、役割だけが残った。**
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
// 役割
// ---------------------------------------------------------------------------

/**
 * 役割をまとめて保存する。画面の一覧をそのまま受け取る想定。
 *
 * **行は消さない。** 廃止は `active=false` で表す（design.md 3 places）。
 * 過去の枠が参照している役割名を消すと、過去の配置表が読めなくなるため。
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
    if (!name) errors.push(label + ': 役割名を入力してください。');

    const id = trimStr_(p.id);
    if (id && !byId.has(id)) errors.push(label + ': 存在しない役割です（他の端末で削除された可能性があります）。');

    const order = p.sort_order === '' || p.sort_order === null || p.sort_order === undefined
      ? i + 1
      : Number(p.sort_order);
    if (!isFinite(order)) errors.push(label + ': 表示順は数値で指定してください。');

    // 空欄は「色なし」。知らない値は弾く（画面側の CSS に無い色を保存させない）
    const color = trimStr_(p.color);
    if (color && PLACE_COLORS.indexOf(color) === -1) {
      errors.push(label + ': 背景色の指定が正しくありません。');
    }

    return { id: id, name: name, sort_order: order, active: p.active !== false, color: color };
  });
  if (errors.length > 0) throw new Error(errors.join('\n'));

  /*
    color 列が無いシート（列を足す前の setup() で作られたもの）に色を保存しようとしたら
    止める。`insertRows_` は定義に無い列を黙って捨てるため、そのままだと
    「保存できたのに色が付かない」という、原因の分からない壊れ方になる。
  */
  const wantsColor = cleaned.some(function (p) { return p.color !== ''; });
  if (wantsColor && getColumnMap_(getSheet_(SHEET_DEFS.PLACES)).color === undefined) {
    throw new Error('places シートに color 列がありません。' +
      'スクリプトエディタから setup() を1回実行してください。');
  }

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
        current.active !== p.active ||
        trimStr_(current.color) !== p.color) {
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

/** 役割名。places から消えていても「(不明な役割)」で通す（画面から消さないため） */
function placeName_(placeById, placeId) {
  const place = placeById.get(trimStr_(placeId));
  return place ? place.name : '(不明な役割)';
}
