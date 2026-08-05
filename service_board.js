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
 * 充足判定（design.md 6.4）と整合性警告（6.5）は Phase 4 で追加する。
 * このファイルの返却形（warnings[]）は、そのときに中身が入る前提で先に用意してある。
 */

/** クライアントへ渡してよい `_config` のキー。ここに無いキーは返さない（ホワイトリスト） */
const PUBLIC_CONFIG_KEYS_ = [
  CONFIG_KEY.DAY_START,
  CONFIG_KEY.DAY_END,
  CONFIG_KEY.SLOT_UNIT_MINUTES,
  CONFIG_KEY.STAFF_DEFAULT_START,
  CONFIG_KEY.STAFF_DEFAULT_END,
  CONFIG_KEY.DEFAULT_SLOT_START,
  CONFIG_KEY.DEFAULT_SLOT_END,
  CONFIG_KEY.DEFAULT_SLOT_REQUIRED,
  CONFIG_KEY.PUBLIC_NAME_STYLE
];

// ---------------------------------------------------------------------------
// getBootstrap
// ---------------------------------------------------------------------------

/**
 * 画面の初期化に必要な、日付に依存しないデータを返す。
 * 日付を切り替えても変わらないものだけを置くこと（毎回転送されるため）。
 *
 * @return {{ config: Object, places: Array, templateNames: Array<string> }}
 */
function buildBootstrap_() {
  return {
    config: publicConfig_(),
    places: readPlaces_(),
    // テンプレート本体は運用者がシートを直接編集する。画面では名前を選ばせるだけなので
    // 名前の一覧だけを渡す
    templateNames: readTemplateNames_()
  };
}

/** `slot_templates` に登録されているテンプレート名の一覧（重複を除く） */
function readTemplateNames_() {
  const seen = {};
  const out = [];
  readTable_(SHEET_DEFS.SLOT_TEMPLATES).forEach(function (t) {
    const name = trimStr_(t.template_name);
    if (!name || seen[name]) return;
    seen[name] = true;
    out.push(name);
  });
  return out.sort(function (a, b) { return a.localeCompare(b, 'ja'); });
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
 * 場所の一覧。`active=false` も含めて返す。
 * 管理モードで「廃止した場所を復活させる」ことがあるため、画面側で絞る。
 */
function readPlaces_() {
  const rows = readTable_(SHEET_DEFS.PLACES);
  rows.sort(comparePlaces_);
  return rows.map(function (p) {
    return {
      id: p.id,
      name: p.name,
      sort_order: p.sort_order === null ? 0 : p.sort_order,
      active: p.active
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

  const slots = readSlotsByDate_(date);
  const availability = readAvailabilityByDate_(date);
  const assignments = readAssignmentsBySlotIds_(slots.map(function (s) { return s.id; }));

  const people = readRelatedPeople_(assignments, availability);
  const withVirtual = appendStaffDefaultAvailability_(availability, people, date);

  return {
    date: date,
    slots: appendDefaultSlots_(slots, date),
    assignments: assignments,
    availability: withVirtual,
    people: people.map(function (p) { return toPublicPerson_(p, nameStyle, admin === true); }),
    // TODO(Phase 4): design.md 6.5 の整合性警告をここで組み立てる
    warnings: []
  };
}

/** 指定日の枠。場所の表示順 → 開始時刻の順に並べる */
function readSlotsByDate_(date) {
  const rows = readTable_(SHEET_DEFS.SLOTS, function (r) { return r.date === date; });
  const order = placeOrderMap_();

  rows.sort(function (a, b) {
    const ao = order[a.place_id] === undefined ? Number.MAX_SAFE_INTEGER : order[a.place_id];
    const bo = order[b.place_id] === undefined ? Number.MAX_SAFE_INTEGER : order[b.place_id];
    if (ao !== bo) return ao - bo;
    if (a.start_time !== b.start_time) return a.start_time < b.start_time ? -1 : 1;
    return a.end_time < b.end_time ? -1 : 1;
  });

  return rows.map(function (s) {
    return {
      id: s.id,
      date: s.date,
      place_id: s.place_id,
      start_time: s.start_time,
      end_time: s.end_time,
      required_count: s.required_count === null ? 0 : s.required_count,
      staff_required: s.staff_required === null ? 0 : s.staff_required,
      note: s.note,
      virtual: false
    };
  });
}

/**
 * 枠が1つも無い場所に、既定の枠を仮想的に補う（design.md 4.2.2）。
 *
 * **シートには書き込まない。** ここは読み取りのAPIであり、閲覧者が日付を送るたびに
 * 空の枠が実体として増えていくのは事故のもと。職員の既定勤務時間帯を仮想的に補う
 * `appendStaffDefaultAvailability_` と同じ考え方で、画面の上だけに存在させる。
 *
 * 人を入れた時点で `assignToNewSlot` が本物の枠を作る。そこで初めて行が生まれる。
 *
 * `default_slot_start` / `default_slot_end` のどちらかを空にすると、この補完は止まる。
 */
function appendDefaultSlots_(slots, date) {
  const start = getConfigValue_(CONFIG_KEY.DEFAULT_SLOT_START, '');
  const end = getConfigValue_(CONFIG_KEY.DEFAULT_SLOT_END, '');
  if (!isValidTimeStr_(start) || !isValidTimeStr_(end) || toMinutes_(start) >= toMinutes_(end)) {
    return slots;
  }
  const required = Number(getConfigValue_(CONFIG_KEY.DEFAULT_SLOT_REQUIRED, 1));

  // 既に枠のある場所には出さない。運用が始まっている場所に空の枠を割り込ませない
  const used = {};
  slots.forEach(function (s) { used[s.place_id] = true; });

  const out = slots.slice();
  readPlaces_().forEach(function (p) {
    if (!p.active || used[p.id]) return;
    out.push({
      id: 'virtual:' + p.id + ':' + date,
      date: date,
      place_id: p.id,
      start_time: start,
      end_time: end,
      required_count: isFinite(required) && required >= 0 ? required : 0,
      staff_required: 0,
      note: '',
      virtual: true
    });
  });
  return out;
}

/** place_id → 表示順（並べ替え用） */
function placeOrderMap_() {
  const map = {};
  readPlaces_().forEach(function (p, i) { map[p.id] = i; });
  return map;
}

/** 指定日の可用性 */
function readAvailabilityByDate_(date) {
  return readTable_(SHEET_DEFS.AVAILABILITY, function (r) { return r.date === date; })
    .map(function (a) {
      return {
        id: a.id,
        person_id: a.person_id,
        date: a.date,
        start_time: a.start_time,
        end_time: a.end_time,
        virtual: false
      };
    });
}

/** 指定した枠に対する割り当て */
function readAssignmentsBySlotIds_(slotIds) {
  if (slotIds.length === 0) return [];
  const target = new Set(slotIds);
  return readTable_(SHEET_DEFS.ASSIGNMENTS, function (r) { return target.has(r.slot_id); })
    .map(function (a) {
      return {
        id: a.id,
        slot_id: a.slot_id,
        person_id: a.person_id,
        assigned_by: a.assigned_by
      };
    });
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
function readRelatedPeople_(assignments, availability) {
  const all = readTable_(SHEET_DEFS.PEOPLE);
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
 * 職員の既定可用時間帯を仮想的に補う（design.md 3 availability の注記）。
 *
 * 職員は毎回の可用性入力を求めない運用のため、`availability` に行が無い職員には
 * `_config` の既定勤務時間帯を「その場で」可用とみなして足す。
 * **シートには書き込まない。** 書き込むと既定値を変えたときに過去分が食い違う。
 */
function appendStaffDefaultAvailability_(availability, people, date) {
  const start = getConfigValue_(CONFIG_KEY.STAFF_DEFAULT_START, '');
  const end = getConfigValue_(CONFIG_KEY.STAFF_DEFAULT_END, '');
  if (!isValidTimeStr_(start) || !isValidTimeStr_(end) || toMinutes_(start) >= toMinutes_(end)) {
    return availability;
  }

  const hasOwn = new Set(availability.map(function (a) { return a.person_id; }));
  const out = availability.slice();

  people.forEach(function (p) {
    if (p.type !== PERSON_TYPE.STAFF) return;
    if (trimStr_(p.merged_into)) return;
    if (hasOwn.has(p.id)) return; // 自分で申告している職員は、その申告を優先する
    out.push({
      id: 'virtual:' + p.id + ':' + date,
      person_id: p.id,
      date: date,
      start_time: start,
      end_time: end,
      virtual: true
    });
  });

  return out;
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
