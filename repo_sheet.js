/**
 * repo_sheet.gs … シート読み書きの共通処理（バッチ前提）
 *
 * 規約:
 *  - 読み書きは必ず getValues() / setValues() の一括。セル単位ループは書かない
 *  - 列はヘッダー名から解決する。列位置をハードコードしない
 *  - 呼び出し側はプレーンなオブジェクト配列だけを扱い、行番号を意識しない
 */

/** バインド先スプレッドシート。IDはハードコードしない（gas.md 7.2） */
function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** 定義からシートを取得する。無ければエラー（setup() 未実行の検知） */
function getSheet_(def) {
  const sheet = ss_().getSheetByName(def.name);
  if (!sheet) {
    throw new Error('シート「' + def.name + '」がありません。setup() を実行してください。');
  }
  return sheet;
}

/** ヘッダー名 → 列インデックス（0始まり）のマップ */
function getColumnMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach(function (h, i) {
    const key = trimStr_(h);
    if (key && !(key in map)) map[key] = i;
  });
  return map;
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

/**
 * テーブル全体をオブジェクト配列で返す（getValues 1回）。
 *
 * @param {Object} def SHEET_DEFS の要素
 * @param {Function=} filterFn 行オブジェクトを受け取り true なら採用。読み込み後に
 *                             メモリ上で絞るためのもの（シートアクセスは増えない）
 * @return {Array<Object>} 各行に _row（シート上の行番号）を含む
 */
function readTable_(def, filterFn) {
  const sheet = getSheet_(def);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(trimStr_);
  const colIndex = {};
  headers.forEach(function (h, i) {
    if (h && !(h in colIndex)) colIndex[h] = i;
  });

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const raw = values[r];
    const obj = { _row: r + 1 };
    let empty = true;
    def.columns.forEach(function (col) {
      const i = colIndex[col.id];
      const v = i === undefined ? '' : raw[i];
      obj[col.id] = coerceRead_(v, col.type);
      if (obj[col.id] !== '' && obj[col.id] !== null) empty = false;
    });
    if (empty) continue; // 末尾の空行・削除跡を無視する
    if (filterFn && !filterFn(obj)) continue;
    out.push(obj);
  }
  return out;
}

/** シートの値を列定義の型に合わせて変換する */
function coerceRead_(v, type) {
  if (v === null || v === undefined) return type === 'number' ? null : '';

  if (type === 'number') {
    if (v === '') return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  if (type === 'boolean') {
    if (typeof v === 'boolean') return v;
    return String(v).trim().toUpperCase() === 'TRUE';
  }

  // 'string' / 'date' / 'time'
  // 書式なしテキストの設定が外れて日付型で返ってきた場合の防御的変換
  if (v instanceof Date) {
    const tz = Session.getScriptTimeZone();
    if (type === 'date') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (type === 'time') return Utilities.formatDate(v, tz, 'HH:mm');
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(v).trim();
}

/** id → 行オブジェクトの Map */
function indexById_(rows) {
  const map = new Map();
  rows.forEach(function (row) { map.set(row.id, row); });
  return map;
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

/**
 * 行を末尾に一括追加する（setValues 1回）。
 * id / created_at / updated_at は未指定なら自動で埋める。
 *
 * @return {Array<Object>} 追加された行オブジェクト（id 等を補完済み）
 */
function insertRows_(def, objs) {
  if (!objs || objs.length === 0) return [];
  const sheet = getSheet_(def);
  const colMap = getColumnMap_(sheet);
  const width = def.columns.length;
  const stamp = nowStamp_();

  const prepared = objs.map(function (o) {
    const row = {};
    def.columns.forEach(function (col) { row[col.id] = o[col.id]; });
    if ('id' in row && !trimStr_(row.id)) row.id = newId_();
    if ('created_at' in row && !trimStr_(row.created_at)) row.created_at = stamp;
    if ('updated_at' in row) row.updated_at = stamp;
    return row;
  });

  const matrix = prepared.map(function (row) {
    const arr = new Array(width).fill('');
    def.columns.forEach(function (col) {
      const i = colMap[col.id];
      if (i === undefined) return;
      arr[i] = coerceWrite_(row[col.id], col.type);
    });
    return arr;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, matrix.length, width).setValues(matrix);
  return prepared;
}

/**
 * id を指定して行を更新する。
 *
 * @param {Object} def
 * @param {Array<Object>} patches [{ id, ...変更したい列だけ }]
 * @return {number} 更新できた行数
 */
function updateRowsById_(def, patches) {
  if (!patches || patches.length === 0) return 0;
  const sheet = getSheet_(def);
  const rows = readTable_(def);
  const byId = indexById_(rows);
  const colMap = getColumnMap_(sheet);
  const width = def.columns.length;
  const stamp = nowStamp_();

  let updated = 0;
  patches.forEach(function (patch) {
    const current = byId.get(patch.id);
    if (!current) return;

    const merged = {};
    def.columns.forEach(function (col) {
      merged[col.id] = (col.id in patch) ? patch[col.id] : current[col.id];
    });
    merged.id = current.id;
    if ('created_at' in merged) merged.created_at = current.created_at;
    if ('updated_at' in merged) merged.updated_at = stamp;

    const arr = new Array(width).fill('');
    def.columns.forEach(function (col) {
      const i = colMap[col.id];
      if (i === undefined) return;
      arr[i] = coerceWrite_(merged[col.id], col.type);
    });
    // 行単位の setValues。セル単位ではないので許容範囲（更新は通常1〜数行）
    sheet.getRange(current._row, 1, 1, width).setValues([arr]);
    updated++;
  });
  return updated;
}

/**
 * id を指定して行を削除する。
 * 行番号のずれを避けるため、下から順に消す。
 *
 * @return {number} 削除した行数
 */
function deleteRowsById_(def, ids) {
  if (!ids || ids.length === 0) return 0;
  const sheet = getSheet_(def);
  const targets = new Set(ids);
  const rows = readTable_(def).filter(function (r) { return targets.has(r.id); });
  if (rows.length === 0) return 0;

  const rowNumbers = rows.map(function (r) { return r._row; }).sort(function (a, b) { return b - a; });
  // 連続する行はまとめて削除する
  let i = 0;
  while (i < rowNumbers.length) {
    let j = i;
    while (j + 1 < rowNumbers.length && rowNumbers[j + 1] === rowNumbers[j] - 1) j++;
    const start = rowNumbers[j];
    const count = j - i + 1;
    sheet.deleteRows(start, count);
    i = j + 1;
  }
  return rowNumbers.length;
}

/** 値をシートへ書く形に整える。文字列列は先頭のアポストロフィ混入を防ぐため素で書く */
function coerceWrite_(v, type) {
  if (v === null || v === undefined) return '';
  if (type === 'number') {
    if (v === '') return '';
    const n = Number(v);
    return isNaN(n) ? '' : n;
  }
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v;
    return String(v).trim().toUpperCase() === 'TRUE';
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// _config
// ---------------------------------------------------------------------------

/** 実行ごとの `_config` キャッシュ。1リクエスト内で何度読んでもシートアクセスは1回 */
let configCache_ = null;

/** `_config` を { key: value } で返す */
function getConfig_() {
  if (configCache_) return configCache_;
  const rows = readTable_(SHEET_DEFS.CONFIG);
  const map = {};
  rows.forEach(function (r) {
    const key = trimStr_(r.key);
    if (key) map[key] = trimStr_(r.value);
  });
  configCache_ = map;
  return map;
}

/** `_config` の値を取得する。無ければ fallback */
function getConfigValue_(key, fallback) {
  const v = getConfig_()[key];
  return (v === undefined || v === '') ? fallback : v;
}

/** `_config` の値を書き込む（既存キーは更新、無ければ追記） */
function setConfigValue_(key, value) {
  setConfigValues_({ [key]: value });
}

/** `_config` に複数キーをまとめて書き込む */
function setConfigValues_(kv) {
  const keys = Object.keys(kv);
  if (keys.length === 0) return;

  const sheet = getSheet_(SHEET_DEFS.CONFIG);
  const rows = readTable_(SHEET_DEFS.CONFIG);
  const rowByKey = {};
  rows.forEach(function (r) {
    const k = trimStr_(r.key);
    if (k && !(k in rowByKey)) rowByKey[k] = r;
  });

  const appends = [];
  keys.forEach(function (k) {
    const value = String(kv[k]);
    const existing = rowByKey[k];
    if (existing) {
      sheet.getRange(existing._row, 1, 1, 2).setValues([[k, value]]);
    } else {
      appends.push([k, value]);
    }
  });
  if (appends.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, 2).setValues(appends);
  }
  configCache_ = null;
}

// ---------------------------------------------------------------------------
// _log
// ---------------------------------------------------------------------------

/**
 * 操作記録を `_log` に追記する。
 * ログの失敗で業務処理を止めないよう、例外は握りつぶして console に残す。
 */
function appendLog_(operator, action, targetId, detail) {
  try {
    const sheet = getSheet_(SHEET_DEFS.LOG);
    sheet.appendRow([
      nowStamp_(),
      trimStr_(operator),
      trimStr_(action),
      trimStr_(targetId),
      typeof detail === 'string' ? detail : JSON.stringify(detail || '')
    ]);
  } catch (e) {
    console.error('appendLog_ failed: ' + e);
  }
}
