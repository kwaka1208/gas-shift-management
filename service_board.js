/**
 * service_board.gs … 配置表の組み立て
 *
 * 画面が必要とするデータを「1回の呼び出しで全部」返すことがこのファイルの役目
 * （design.md 7 / CLAUDE.md 開発ルール）。候補者の絞り込みはクライアント側で計算するため、
 * その計算に足りるだけのデータをここで揃えて渡す。
 *
 * 【公開範囲の原則】
 * 閲覧トークンを持つ人は全員が同じデータを見る（管理者を区別する認証は無い）。
 * したがって、返してよいのは「配布先の全員に見せてよい情報」だけに限る。
 *   - `contact` / `note` は誰にも返さない。必要なときは people シートを直接見る
 *   - 氏名は `public_name_style` に従って加工する
 *   - `gender` / `age` は管理画面からの呼び出しにだけ返す。ただし管理画面は
 *     閲覧URLに `&view=admin` を足せば誰でも開けるので、**秘匿ではなく目隠しである**
 *   - `_config` のうち view_token は絶対に返さない
 *
 * **充足判定・整合性警告（旧 Phase 4）は作らない。** 枠を廃止して割り当てと統合した結果、
 * 「必要だがまだ誰もいない」をデータとして持てなくなったため、不足を機械的に出せない。
 * 必要になったら、役割ごとの必要時間帯を持つテーブルから設計し直すこと。
 */

/** クライアントへ渡してよい `_config` のキー。ここに無いキーは返さない（ホワイトリスト） */
const PUBLIC_CONFIG_KEYS_ = [
  CONFIG_KEY.DAY_START,
  CONFIG_KEY.DAY_END,
  CONFIG_KEY.SLOT_UNIT_MINUTES,
  CONFIG_KEY.ENTRY_DEFAULT_START,
  CONFIG_KEY.ENTRY_DEFAULT_END,
  CONFIG_KEY.PUBLIC_NAME_STYLE
];

// ---------------------------------------------------------------------------
// getBootstrap
// ---------------------------------------------------------------------------

/**
 * 画面の初期化に必要な、日付に依存しないデータを返す。
 * 日付を切り替えても変わらないものだけを置くこと（毎回転送されるため）。
 *
 * @return {{ config: Object, places: Array }}
 */
function buildBootstrap_() {
  return {
    config: publicConfig_(),
    places: readPlaces_()
  };
}

/** `_config` のうち公開してよい値だけを返す */
function publicConfig_() {
  const out = {};
  PUBLIC_CONFIG_KEYS_.forEach(function (key) {
    out[key] = getConfigValue_(key, CONFIG_DEFAULTS[key] || '');
  });
  // 数値として使うものは数値で渡す（クライアント側での Number() を減らす）
  out[CONFIG_KEY.SLOT_UNIT_MINUTES] = Number(out[CONFIG_KEY.SLOT_UNIT_MINUTES]) || 10;
  return out;
}

/**
 * 役割の一覧。`active=false` も含めて返す。
 * 管理モードで「廃止した役割を復活させる」ことがあるため、画面側で絞る。
 */
function readPlaces_() {
  const rows = readTable_(SHEET_DEFS.PLACES);
  rows.sort(comparePlaces_);
  return rows.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      sort_order: p.sort_order === null ? 0 : p.sort_order,
      active: p.active,
      // 知らない色は返さない。シートを手で書き換えられても画面が壊れないようにする
      color: PLACE_COLORS.indexOf(trimStr_(p.color)) === -1 ? '' : trimStr_(p.color)
    };
  });
}

/** 表示順 → 名前の順に並べる。sort_order 未設定は末尾へ */
function comparePlaces_(a, b) {
  const ao = (a.sort_order === null || a.sort_order === '') ? Number.MAX_SAFE_INTEGER : Number(a.sort_order);
  const bo = (b.sort_order === null || b.sort_order === '') ? Number.MAX_SAFE_INTEGER : Number(b.sort_order);
  if (ao !== bo) return ao - bo;
  return String(a.name).localeCompare(String(b.name), 'ja');
}

// ---------------------------------------------------------------------------
// getDayBoard
// ---------------------------------------------------------------------------

/**
 * 指定日の描画と候補者計算に必要なデータを、まとめて1回で返す（design.md 7）。
 *
 * ここでサーバー往復を1回に抑えることが、この画面の使い勝手を決める。
 * データを足したくなったら関数を増やさず、この戻り値に足すこと。
 *
 * @param {string} date 'YYYY-MM-DD'
 * @param {boolean=} admin 管理画面からの呼び出しなら true（性別・年齢を含める）
 */
function buildDayBoard_(date, admin) {
  if (!isValidDateStr_(date)) {
    throw new Error('日付の指定が正しくありません。');
  }
  const nameStyle = getConfigValue_(CONFIG_KEY.PUBLIC_NAME_STYLE, 'full');

  // 人マスタはここで1回だけ読む。可用性の補完（職員の既定勤務時間帯）と
  // 「その日に必要な人」の絞り込みの両方が人マスタを要るため
  const allPeople = readTable_(SHEET_DEFS.PEOPLE);

  const assignments = readAssignmentsByDate_(date);
  const availability = appendStaffDefaultAvailability_(
    readAvailabilityByDate_(date), allPeople, date);
  const people = readRelatedPeople_(assignments, availability, allPeople);

  return {
    date: date,
    assignments: assignments,
    availability: availability,
    people: people.map(function (p) { return toPublicPerson_(p, nameStyle, admin === true); })
  };
}

/*
  【日をまたぐ行の繰り越し】

  `22:00`〜`26:00` は **8/10 の1行**として持つ（`date` は開始日のまま動かさない。design.md 5.1）。
  そのままだと 8/11 の画面には何も出ず、「翌朝2時まで人がいる」ことが分からない。

  そこで **前日の行のうち24時を越える分を、その日のタイムラインへ写して返す。**
  写した行は時刻を24時間ぶん戻し（`26:00` → `02:00`）、`carried_from` に元の日付を入れる。

  **シートには何も書かない。** 画面の上だけで前日の続きを見せる。
  割り当てだけでなく**可用性も同じように写すこと。** 片方だけ写すと、
  申告の中に入っているはずの割り当てが「申告外」と誤警告される。
*/

/** 24時を越えて翌日へ続く行か */
function extendsToNextDay_(row) {
  return isValidTimeStr_(row.end_time) && toMinutes_(row.end_time) > DAY_MINUTES_;
}

/** 前日の行を、その日のタイムライン上の時刻に写す（24時間ぶん戻す） */
function shiftToNextDay_(row) {
  const start = Math.max(0, toMinutes_(row.start_time) - DAY_MINUTES_);
  const end = toMinutes_(row.end_time) - DAY_MINUTES_;
  return { start_time: toHHMM_(start), end_time: toHHMM_(end) };
}

/**
 * 指定日の割り当て。役割の表示順 → 開始時刻の順に並べる。
 *
 * **1行が「誰がどこにいつ入るか」を丸ごと持つ**（design.md 3 assignments）。
 * 前日から続いている分も含める（上の「日をまたぐ行の繰り越し」）。
 */
function readAssignmentsByDate_(date) {
  const own = readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) { return r.date === date; })
    .map(publicAssignment_);

  const prev = addDays_(date, -1);
  const carried = readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) {
    return r.date === prev && extendsToNextDay_(r);
  }).map(function (r) {
    const out = publicAssignment_(r);
    const shifted = shiftToNextDay_(r);
    // 元の値も残す。画面が「前日の 22:00–26:00 の続き」と説明できるようにするため
    out.origin_start_time = out.start_time;
    out.origin_end_time = out.end_time;
    out.start_time = shifted.start_time;
    out.end_time = shifted.end_time;
    out.carried_from = r.date;
    return out;
  });

  const order = placeOrderMap_();
  return own.concat(carried).sort(function (a, b) {
    const ao = order[a.place_id] === undefined ? Number.MAX_SAFE_INTEGER : order[a.place_id];
    const bo = order[b.place_id] === undefined ? Number.MAX_SAFE_INTEGER : order[b.place_id];
    if (ao !== bo) return ao - bo;
    if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
    return a.end_time < b.end_time ? -1 : 1;
  });
}

/** 指定日の可用性。割り当てと同じく、前日から続いている分も含める */
function readAvailabilityByDate_(date) {
  const toPublic = function (a, extra) {
    const out = {
      id: a.id,
      person_id: a.person_id,
      date: a.date,
      start_time: a.start_time,
      end_time: a.end_time
    };
    if (extra) {
      out.start_time = extra.start_time;
      out.end_time = extra.end_time;
      out.carried_from = a.date;
    }
    return out;
  };

  const own = readTable_(SHEET_DEFS.AVAILABILITY, function (r) { return r.date === date; })
    .map(function (a) { return toPublic(a, null); });

  const prev = addDays_(date, -1);
  const carried = readTable_(SHEET_DEFS.AVAILABILITY, function (r) {
    return r.date === prev && extendsToNextDay_(r);
  }).map(function (a) { return toPublic(a, shiftToNextDay_(a)); });

  return own.concat(carried);
}

/** place_id → 表示順（並べ替え用） */
function placeOrderMap_() {
  const map = {};
  readPlaces_().forEach(function (p, i) { map[p.id] = i; });
  return map;
}

/**
 * その日の画面に必要な人だけを返す（design.md 7）。
 *   - 割り当てに登場する人
 *   - その日に可用性がある人
 *   - `is_recurring` の人（継続参加者は毎回候補に出す）
 *
 * 名寄せ済み（`merged_into` あり）の人は、統合先の人に読み替える。
 * 過去の割り当てが統合元を指したままでも表示が壊れないようにするため。
 */
function readRelatedPeople_(assignments, availability, allPeople) {
  const all = allPeople || readTable_(SHEET_DEFS.PEOPLE);
  const byId = indexById_(all);

  const wanted = new Set();
  assignments.forEach(function (a) { wanted.add(resolvePersonId_(a.person_id, byId)); });
  availability.forEach(function (a) { wanted.add(resolvePersonId_(a.person_id, byId)); });
  all.forEach(function (p) {
    if (p.is_recurring === true && !trimStr_(p.merged_into)) wanted.add(p.id);
  });

  return all.filter(function (p) { return wanted.has(p.id); });
}

/**
 * 名寄せの参照を解決する（design.md `merged_into`）。
 * 循環や連鎖があっても止まるよう、たどる回数に上限を設ける。
 */
function resolvePersonId_(personId, byId) {
  let id = trimStr_(personId);
  for (let i = 0; i < 10; i++) {
    const person = byId.get(id);
    const next = person ? trimStr_(person.merged_into) : '';
    if (!next || next === id) return id;
    id = next;
  }
  return id;
}

/**
 * 申告の無い職員に、既定の勤務時間帯（`staff_default_*`）を仮想的に足す。
 *
 * **シートには1行も書かない。** 返す配列の上だけで足す。書いてしまうと
 *   - 本人が実際に申告した行と見分けが付かなくなる
 *   - 既定を変えても書いた行は変わらず、静かに食い違う
 *   - 日付を開くたびに行が増える
 * ため。**この仕組みは一度廃止して復活させた。** 廃止したときに「戻すなら
 * 仮想の行をシートに書かないという原則だけは守ること」と書き残していた決まりを引き継ぐ。
 *
 * 足す相手は「職員」かつ `is_recurring` かつ名寄せされていない人。
 * 候補から外したい職員（退職者など）は `is_recurring` を FALSE にする。
 *
 * **その日に本人の申告がある職員には足さない。** 「その日は13時から」と申告した職員に
 * 既定を重ねると、申告した意味が無くなる。
 *
 * ただし**前日から繰り越した行は「その日の申告」と数えない**（`carried_from` が付いた行）。
 * 前夜 22:00〜26:00 を申告した職員は翌日の 00:00〜02:00 にも居ることになるが、
 * それは前日の勤務の続きであって、その日の勤務を申告したわけではない。
 */
function appendStaffDefaultAvailability_(availability, allPeople, date) {
  const start = getConfigValue_(CONFIG_KEY.STAFF_DEFAULT_START, CONFIG_DEFAULTS.staff_default_start);
  const end = getConfigValue_(CONFIG_KEY.STAFF_DEFAULT_END, CONFIG_DEFAULTS.staff_default_end);

  // 設定が壊れていても配置表そのものは出す。補完だけを諦める
  if (!isValidTimeStr_(start) || !isValidTimeStr_(end) || toMinutes_(start) >= toMinutes_(end)) {
    console.error('staff_default_start / staff_default_end が不正です: ' + start + '〜' + end);
    return availability;
  }

  const declared = {};
  availability.forEach(function (a) {
    if (a.carried_from) return;
    declared[a.person_id] = true;
  });

  const added = [];
  allPeople.forEach(function (p) {
    if (trimStr_(p.type) !== PERSON_TYPE.STAFF) return;
    if (p.is_recurring !== true) return;
    if (trimStr_(p.merged_into)) return;
    if (declared[p.id]) return;
    added.push({
      // シートに無い行。実在のIDと衝突しない形にして、取り違えを防ぐ
      id: 'default:' + p.id + ':' + date,
      person_id: p.id,
      date: date,
      start_time: start,
      end_time: end,
      virtual: true
    });
  });

  return availability.concat(added);
}

// ---------------------------------------------------------------------------
// 人の公開用整形
// ---------------------------------------------------------------------------

/**
 * 人の情報を、画面へ渡してよい形に落とす。
 *
 * **`contact` と `note` はここで落とす。誰にも返さない。**
 * 閲覧トークンを知っている人は全員が同じ画面を開けるため、連絡先を返すことは
 * 配布先の全員に連絡先を配ることと同じになる（要件 4.5）。
 * 連絡先が必要な場面では、管理者がスプレッドシートの people シートを直接見る。
 *
 * 性別・年齢は `admin` のときだけ返す。ただし**これは秘匿ではない。**
 * 管理画面は閲覧URLに `&view=admin` を足せば誰でも開けるため（main.js 13行目）、
 * 効果は「閲覧用URLを配った相手の目に触れにくくする」ことに留まる。
 * 本当に見せてはいけない情報は、`contact` と同じくここで落とすこと。
 */
function toPublicPerson_(person, nameStyle, admin) {
  const out = {
    id: person.id,
    name: displayName_(person.name, nameStyle),
    kana: person.kana,
    type: person.type,
    is_recurring: person.is_recurring === true,
    merged_into: person.merged_into
  };
  if (admin === true) {
    out.gender = person.gender;
    // 未登録（列を追加する前に登録された人）は null。画面側で表示を省く
    out.age = person.age;
  }
  return out;
}

/**
 * 公開ビューでの氏名の粒度（`public_name_style`）。
 *   'full'   … そのまま
 *   'family' … 姓のみ。空白で区切られていない場合は加工しない
 *
 * 空白の無い氏名を機械的に切ると別人の名前になりうるため、推測はしない。
 */
function displayName_(name, style) {
  const s = trimStr_(name);
  if (style !== 'family') return s;
  const parts = s.split(/[\s　]+/);
  return parts.length > 1 ? parts[0] : s;
}
