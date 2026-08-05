/**
 * service_entry.gs … 可用性の登録受付（応募フォーム）
 *
 * **この処理だけは応募が集中する。Lock を外さないこと**（design.md 7 排他制御）。
 * 同じ瞬間に複数人が送信しても、人マスタが二重に作られないようにするため。
 *
 * 【人マスタの扱い】
 * 人マスタは使い捨て前提で運用する（CLAUDE.md）。重複・表記ゆれは許容し、
 * 名寄せは管理者が手動で行う。したがってここでは
 *   - 名前が同じでも、連絡先が違えば別人として登録する
 *   - どんな名前でも登録をブロックしない（同姓同名でも通す）
 * を守る。**登録できないことのほうが、重複よりも損害が大きい。**
 *
 * 【可用性の追加のしかた】
 * 同じ人が同じ日に何度送信しても、可用な時間は減らさない。
 * 既存の申告と今回の申告の和集合を取り、重なり・隣接は1本にまとめる（`mergeRanges_`）。
 *   例) 午前だけ申告 → あとから午後も申告 → 両方が残る
 *       09:00-12:00 を申告済みで 11:00-13:00 を追加 → 09:00-13:00 の1本になる
 * 重なった行を残すと Phase 3 の候補者計算で同じ人が二重に数えられる。
 */

/** 1日あたりに受け付ける時間帯の上限。誤操作や悪意ある大量送信を止める */
const MAX_RANGES_PER_SUBMIT = 20;

/** 1回の送信で受け付ける日数の上限 */
const MAX_DAYS_PER_SUBMIT = 31;

/**
 * 可用性を登録する。**複数日をまとめて受け取る。**
 *
 * 日ごとに送らせると、3日分の応募で3往復することになる。
 * 応募が集中する時間帯にそれをやると Lock の待ちが積み上がるため、
 * 1回の呼び出しで全部受ける（gas.md 3.2）。
 *
 * @param {Object} payload
 *   - name {string}     氏名（必須）
 *   - contact {string}  連絡先（任意）
 *   - gender {string}   性別（必須。GENDER_VALUES のいずれか）
 *   - age {number}      年齢（必須。AGE_MIN〜AGE_MAX）
 *   - type {string}     'volunteer' / 'staff'（既定は volunteer）
 *   - days {Array<{date: string, ranges: Array<{start, end}>}>} 日ごとの申告
 *   - operator {string} 代理入力した人の名前（本人入力なら空）
 * @return {{ personId, name, gender, age, type, days, isNewPerson }}
 */
function submitAvailabilityData_(payload) {
  const input = validateEntryInput_(payload || {});

  const person = findOrCreatePerson_(input);

  const days = input.days.map(function (day) {
    const result = addAvailability_(person.id, day.date, day.ranges);
    return {
      date: day.date,
      entries: result.entries,
      addedCount: result.addedCount,
      // 画面に入力した本数。まとまった場合に控えで知らせるために返す
      inputCount: day.ranges.length
    };
  });

  appendLog_(
    input.operator || '(本人)',
    'submit_availability',
    person.id,
    days.map(function (d) {
      return d.date + ' ' + d.entries.map(function (e) {
        return e.start_time + '-' + e.end_time;
      }).join(',');
    }).join(' / ')
  );

  return {
    personId: person.id,
    name: person.name,
    // 控えには「今しがた登録した値」を出す。既存の人でも上書き済みなので input と一致する
    gender: input.gender,
    age: input.age,
    type: person.type,
    days: days,
    isNewPerson: person.isNew
  };
}

// ---------------------------------------------------------------------------
// 入力の検証
// ---------------------------------------------------------------------------

/**
 * 応募フォームの入力を検証して整える。
 *
 * クライアント側でも同じ検証をするが、**サーバー側の検証が本体**（gas.md 5.3）。
 * 匿名アクセス可のデプロイであり、クライアントの検証は迂回できる。
 */
function validateEntryInput_(payload) {
  const errors = [];

  const name = trimStr_(payload.name);
  if (!name) errors.push('お名前を入力してください。');
  if (name.length > 50) errors.push('お名前が長すぎます。');

  const contact = trimStr_(payload.contact);
  if (contact.length > 100) errors.push('連絡先が長すぎます。');

  // 性別・年齢は必須。ただし性別には「回答しない」があり、答えたくない人も先へ進める
  const gender = trimStr_(payload.gender);
  if (GENDER_VALUES.indexOf(gender) === -1) errors.push('性別を選んでください。');

  const age = parseAge_(payload.age, errors);

  const type = trimStr_(payload.type) === PERSON_TYPE.STAFF
    ? PERSON_TYPE.STAFF
    : PERSON_TYPE.VOLUNTEER;

  const rawDays = Array.isArray(payload.days) ? payload.days : [];
  if (rawDays.length === 0) errors.push('入れる日を1つ以上入力してください。');
  if (rawDays.length > MAX_DAYS_PER_SUBMIT) {
    errors.push('一度に登録できる日は' + MAX_DAYS_PER_SUBMIT + '日までです。');
  }

  const unit = Number(getConfigValue_(CONFIG_KEY.SLOT_UNIT_MINUTES, 10)) || 10;
  const byDate = {};
  const days = [];

  rawDays.slice(0, MAX_DAYS_PER_SUBMIT).forEach(function (d) {
    const date = trimStr_(d && d.date);
    if (!isValidDateStr_(date)) {
      errors.push('日付を選んでください。');
      return;
    }
    // 同じ日を2ブロック書かれても、まとめて1日として扱う（申告を取りこぼさない）
    if (byDate[date]) {
      byDate[date].ranges = byDate[date].ranges.concat(
        parseRanges_(d.ranges, date, unit, errors));
      return;
    }
    const day = { date: date, ranges: parseRanges_(d.ranges, date, unit, errors) };
    byDate[date] = day;
    days.push(day);
  });

  days.forEach(function (day) {
    if (day.ranges.length === 0) {
      errors.push(day.date + ': 入れる時間帯を1つ以上入力してください。');
    }
  });

  if (errors.length > 0) throw new Error(errors.join('\n'));

  // 日付順に整える。控えとログが読みやすくなる
  days.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  return {
    name: name,
    contact: contact,
    gender: gender,
    age: age,
    type: type,
    days: days,
    operator: trimStr_(payload.operator)
  };
}

/**
 * 年齢を検証して数値に直す。不正なら errors に積んで null を返す。
 *
 * 小数や全角は受けない。**「32歳」のような書き方も弾く。**
 * 数値列に文字が混ざると、シート上で並べ替えたときに静かに壊れるため。
 */
function parseAge_(raw, errors) {
  const s = trimStr_(raw);
  if (s === '') {
    errors.push('年齢を入力してください。');
    return null;
  }
  if (!/^[0-9]+$/.test(s)) {
    errors.push('年齢は半角数字で入力してください。');
    return null;
  }
  const n = Number(s);
  if (n < AGE_MIN || n > AGE_MAX) {
    errors.push('年齢は' + AGE_MIN + '〜' + AGE_MAX + 'の間で入力してください。');
    return null;
  }
  return n;
}

/**
 * 1日分の時間帯を検証して分単位に直す。
 * 不正な行は errors に積んで捨てる（その日の他の行は活かす）。
 */
function parseRanges_(rawRanges, date, unit, errors) {
  const list = Array.isArray(rawRanges) ? rawRanges : [];
  if (list.length > MAX_RANGES_PER_SUBMIT) {
    errors.push(date + ': 1日に登録できる時間帯は' + MAX_RANGES_PER_SUBMIT + '件までです。');
  }

  const ranges = [];
  list.slice(0, MAX_RANGES_PER_SUBMIT).forEach(function (r, i) {
    const label = date + ' の' + (i + 1) + 'つ目の時間帯';
    const start = trimStr_(r && r.start);
    const end = trimStr_(r && r.end);
    if (!isValidTimeStr_(start) || !isValidTimeStr_(end)) {
      errors.push(label + ': 時刻を入力してください。');
      return;
    }
    if (toMinutes_(start) >= toMinutes_(end)) {
      errors.push(label + ': 終了時刻は開始時刻より後にしてください。');
      return;
    }
    if (!isOnUnit_(start, unit) || !isOnUnit_(end, unit)) {
      errors.push(label + ': 時刻は' + unit + '分単位で入力してください。');
      return;
    }
    ranges.push({ start: toMinutes_(start), end: toMinutes_(end) });
  });
  return ranges;
}

// ---------------------------------------------------------------------------
// 人マスタ
// ---------------------------------------------------------------------------

/**
 * 人を探す。見つからなければ作る。
 *
 * 同一人物とみなすのは **氏名と連絡先の両方が完全に一致** したときだけ。
 * 連絡先が空なら常に新規作成する（同姓同名の別人を勝手に統合しないため）。
 * 表記ゆれの吸収は狙わない。名寄せは管理者が手動で行う（CLAUDE.md）。
 *
 * 既存の人が見つかったときは、性別・年齢を**今回の申告で上書きする。**
 * 年をまたげば年齢は変わるし、打ち間違いを直す手段が応募フォームしか無いため。
 * 氏名・連絡先・種別は照合の鍵や運用上の設定なので触らない。
 */
function findOrCreatePerson_(input) {
  if (input.contact) {
    const people = readTable_(SHEET_DEFS.PEOPLE);
    const byId = indexById_(people);
    const matched = people.filter(function (p) {
      return trimStr_(p.name) === input.name && trimStr_(p.contact) === input.contact;
    });
    if (matched.length > 0) {
      // 名寄せ済みなら統合先へ読み替える
      const id = resolvePersonId_(matched[0].id, byId);
      const person = byId.get(id) || matched[0];
      if (trimStr_(person.gender) !== input.gender || person.age !== input.age) {
        updateRowsById_(SHEET_DEFS.PEOPLE, [{
          id: person.id, gender: input.gender, age: input.age
        }]);
      }
      return { id: person.id, name: person.name, type: person.type, isNew: false };
    }
  }

  const created = insertRows_(SHEET_DEFS.PEOPLE, [{
    name: input.name,
    kana: '',
    gender: input.gender,
    age: input.age,
    type: input.type,
    contact: input.contact,
    is_recurring: input.type === PERSON_TYPE.STAFF, // 職員は毎回候補に出す
    merged_into: '',
    note: ''
  }])[0];

  return { id: created.id, name: created.name, type: created.type, isNew: true };
}

// ---------------------------------------------------------------------------
// 可用性
// ---------------------------------------------------------------------------

/**
 * 可用性を追加する。既存の申告と和集合を取る。
 *
 * **可用な時間が減ることはない。** 既存の行が新しい行に吸収される場合だけ削除し、
 * 表現としての行を整理する（例: 09:00-12:00 と 11:00-13:00 → 09:00-13:00 の1行）。
 */
function addAvailability_(personId, date, newRanges) {
  const existing = readTable_(SHEET_DEFS.AVAILABILITY, function (r) {
    return r.person_id === personId && r.date === date;
  });

  const existingRanges = [];
  existing.forEach(function (r) {
    if (!isValidTimeStr_(r.start_time) || !isValidTimeStr_(r.end_time)) return;
    existingRanges.push({ start: toMinutes_(r.start_time), end: toMinutes_(r.end_time) });
  });

  const merged = mergeRanges_(existingRanges.concat(newRanges));

  // 既存行のうち、統合後の姿と一致するものはそのまま残す（無駄な書き換えをしない）
  const mergedKeys = {};
  merged.forEach(function (m) { mergedKeys[m.start + '-' + m.end] = true; });

  const keepKeys = {};
  const removeIds = [];
  existing.forEach(function (r) {
    const key = toMinutes_(r.start_time) + '-' + toMinutes_(r.end_time);
    if (mergedKeys[key] && !keepKeys[key]) {
      keepKeys[key] = true;
    } else {
      removeIds.push(r.id); // 統合で吸収された行、または重複行
    }
  });

  const inserts = merged
    .filter(function (m) { return !keepKeys[m.start + '-' + m.end]; })
    .map(function (m) {
      return {
        person_id: personId,
        date: date,
        start_time: toHHMM_(m.start),
        end_time: toHHMM_(m.end)
      };
    });

  if (removeIds.length > 0) deleteRowsById_(SHEET_DEFS.AVAILABILITY, removeIds);
  if (inserts.length > 0) insertRows_(SHEET_DEFS.AVAILABILITY, inserts);

  return {
    entries: merged.map(function (m) {
      return { start_time: toHHMM_(m.start), end_time: toHHMM_(m.end) };
    }),
    addedCount: inserts.length
  };
}
