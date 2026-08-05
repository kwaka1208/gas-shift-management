/**
 * util.gs … 日付/時刻変換、区間の重なり判定など
 *
 * 本ファイルの区間判定は配置表全体の土台になる（design.md 6）。
 * 変更したら必ず test_util.gs を実行して確認すること。
 *
 * 日付は 'YYYY-MM-DD'、時刻は 'HH:mm' の文字列で扱う（design.md 5.1）。
 * 比較・計算は必ず分単位の数値に変換してから行う。
 */

// ---------------------------------------------------------------------------
// 時刻
// ---------------------------------------------------------------------------

/** 'HH:mm' を 0時からの経過分に変換する */
function toMinutes_(hhmm) {
  if (!isValidTimeStr_(hhmm)) {
    throw new Error('時刻の形式が不正です: ' + hhmm);
  }
  const parts = hhmm.split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

/**
 * 0時からの経過分を 'HH:mm' に変換する。
 * 24時以降は `25:00` のように24時間制の延長で返す（`isValidTimeStr_` 参照）。
 */
function toHHMM_(minutes) {
  if (typeof minutes !== 'number' || !isFinite(minutes) || minutes < 0) {
    throw new Error('分の値が不正です: ' + minutes);
  }
  const m = Math.round(minutes);
  return pad2_(Math.floor(m / 60)) + ':' + pad2_(m % 60);
}

/**
 * 'HH:mm' 形式か（`00:00`〜`47:59`）。
 *
 * **24時以降は「翌日」を表す**（design.md 5.1）。日をまたぐ枠を1本で表せるように、
 * 24時間制の延長として扱う。`22:00`〜`26:00` は「その日の22時から翌日2時まで」。
 *
 * 上限を47:59（＝翌日の23:59）にしているのは、
 *   - 日付の列は開始日のまま動かさない設計なので、翌々日まで許すと
 *     「どの日の枠なのか」が人にもコードにも追えなくなる
 *   - 打ち間違い（`52:00`）を弾ける
 * ため。**48以上を通してはいけない。**
 */
function isValidTimeStr_(s) {
  return typeof s === 'string' && /^(0[0-9]|[1-3][0-9]|4[0-7]):[0-5][0-9]$/.test(s);
}

/** 時刻として扱える最大の分（47:59） */
const TIME_MAX_MINUTES_ = 47 * 60 + 59;

/**
 * 画面・メッセージに出す形にする。24時以降は「翌」を付ける（design.md 5.1）。
 *   '25:00' → '翌01:00' / '10:00' → '10:00'
 *
 * **保存値は変換しない。** シートにはあくまで `25:00` が入る。
 * ここを通すのは人が読む文字列だけにすること。
 * クライアント側の同じ処理は `common_script.html` の `timeLabel`。
 */
function toDisplayTime_(hhmm) {
  if (!isValidTimeStr_(hhmm)) return trimStr_(hhmm);
  const h = Number(hhmm.slice(0, 2));
  if (h < 24) return hhmm;
  return '翌' + pad2_(h - 24) + hhmm.slice(2);
}

/** 時刻が刻み幅（分）に乗っているか。10分刻みの入力検証に使う */
function isOnUnit_(hhmm, unitMinutes) {
  const unit = Number(unitMinutes);
  if (!unit || unit <= 0) return true;
  return toMinutes_(hhmm) % unit === 0;
}

// ---------------------------------------------------------------------------
// 区間（すべて分単位の数値。半開区間 [start, end) として扱う）
// ---------------------------------------------------------------------------

/**
 * [aStart, aEnd) と [bStart, bEnd) が重なるか。
 *
 * 境界が接するだけ（10:00-11:00 と 11:00-12:00）は「重ならない」。
 * ここを閉区間にすると連続する枠に同じ人を入れられなくなる（design.md 6.1）。
 */
function overlaps_(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** 可用性 [avStart, avEnd) が枠 [slotStart, slotEnd) を完全に含むか（design.md 6.2） */
function covers_(avStart, avEnd, slotStart, slotEnd) {
  return avStart <= slotStart && slotEnd <= avEnd;
}

/** 区間の長さ（分）。負にはならない */
function durationMinutes_(startMin, endMin) {
  return Math.max(0, endMin - startMin);
}

/**
 * 区間の集合を、重なりと隣接をまとめた最小の集合にする（和集合）。
 *
 * 可用性の登録に使う。同じ人の同じ日に
 *   09:00-12:00 と 11:00-13:00 → 09:00-13:00
 *   09:00-12:00 と 12:00-15:00 → 09:00-15:00（隣接も1本にする）
 *   09:00-12:00 と 13:00-15:00 → そのまま2本
 * となる。**可用な時間が減ることはない。**
 *
 * 重なった行を残すと、Phase 3 の候補者計算で同じ人が二重に数えられる。
 *
 * @param {Array<{start: number, end: number}>} ranges 分単位
 * @return {Array<{start: number, end: number}>} 開始時刻の昇順
 */
function mergeRanges_(ranges) {
  const sorted = ranges
    .filter(function (r) { return r.end > r.start; })
    .slice()
    .sort(function (a, b) { return a.start - b.start || a.end - b.end; });

  const out = [];
  sorted.forEach(function (r) {
    const last = out[out.length - 1];
    // 隣接（前の終わり＝次の始まり）もつなげる。区間としては連続しているため
    if (last && r.start <= last.end) {
      if (r.end > last.end) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 日付
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' 形式かつ実在する日付か */
function isValidDateStr_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  // うるう年を含む実在判定。UTC で組み立てるのでタイムゾーンの影響を受けない
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * 日付文字列に n 日加算する（n は負でもよい）。
 * ローカルタイムゾーンを一切使わないので、実行環境によるずれが起きない。
 */
function addDays_(dateStr, n) {
  const dt = toUtcDate_(dateStr);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtcDate_(dt);
}

/** 曜日を返す（0=日 〜 6=土）。slot_templates.day_of_week と対応する */
function dayOfWeek_(dateStr) {
  return toUtcDate_(dateStr).getUTCDay();
}

/** 2つの日付の差（日数）。toDate - fromDate */
function diffDays_(fromDate, toDate) {
  const ms = toUtcDate_(toDate).getTime() - toUtcDate_(fromDate).getTime();
  return Math.round(ms / 86400000);
}

/** fromDate から toDate までの日付文字列の配列（両端を含む） */
function dateRange_(fromDate, toDate) {
  const days = diffDays_(fromDate, toDate);
  if (days < 0) return [];
  const out = [];
  for (let i = 0; i <= days; i++) {
    out.push(addDays_(fromDate, i));
  }
  return out;
}

/** 'YYYY-MM-DD' → UTC の Date（内部専用） */
function toUtcDate_(dateStr) {
  if (!isValidDateStr_(dateStr)) {
    throw new Error('日付の形式が不正です: ' + dateStr);
  }
  return new Date(Date.UTC(
    Number(dateStr.slice(0, 4)),
    Number(dateStr.slice(5, 7)) - 1,
    Number(dateStr.slice(8, 10))
  ));
}

/** UTC の Date → 'YYYY-MM-DD'（内部専用） */
function fromUtcDate_(dt) {
  return dt.getUTCFullYear() + '-' + pad2_(dt.getUTCMonth() + 1) + '-' + pad2_(dt.getUTCDate());
}

// ---------------------------------------------------------------------------
// GAS 実行環境に依存するもの
// ---------------------------------------------------------------------------

/** スクリプトのタイムゾーンでの本日（'YYYY-MM-DD'） */
function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** 現在時刻（'YYYY-MM-DD HH:mm:ss'）。created_at / updated_at に使う */
function nowStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

/** UUID を発行する */
function newId_() {
  return Utilities.getUuid();
}

// ---------------------------------------------------------------------------
// 汎用
// ---------------------------------------------------------------------------

/** 1桁の数値を2桁のゼロ埋め文字列にする */
function pad2_(n) {
  return String(n).length >= 2 ? String(n) : '0' + String(n);
}

/** null / undefined を空文字にし、前後の空白を落とす */
function trimStr_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** HTML エスケープ。画面に値を差し込む前に必ず通す */
function escapeHtml_(s) {
  return trimStr_(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 配列を key ごとにまとめた Map を返す */
function groupBy_(rows, keyFn) {
  const map = new Map();
  rows.forEach(function (row) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}
