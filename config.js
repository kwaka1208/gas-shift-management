/**
 * config.gs … シート定義・定数
 *
 * 列の追加・変更はこのファイルだけを直す。setup() のシート生成、repo_sheet.gs の
 * 読み書き、書式設定はすべてこの定義から導出される。
 *
 * 列の型（type）の意味:
 *   'string' / 'date' / 'time' … シート上は「書式なしテキスト」。日付・時刻・電話番号が
 *                                 勝手に日付型へ変換される事故を防ぐ（design.md 5.1）
 *   'number'  … 数値
 *   'boolean' … TRUE / FALSE
 */

/** 書式なしテキストとして扱う型 */
const TEXT_TYPES_ = ['string', 'date', 'time'];

const SHEET_DEFS = {
  PLACES: {
    name: 'places',
    columns: [
      { id: 'id', type: 'string' },
      { id: 'name', type: 'string' },
      { id: 'sort_order', type: 'number' },
      { id: 'active', type: 'boolean' },
      // 配置表で行の背景に敷く色。空欄は「色なし」。PLACE_COLORS のキーだけを入れる
      { id: 'color', type: 'string' },
      { id: 'created_at', type: 'string' },
      { id: 'updated_at', type: 'string' }
    ]
  },

  PEOPLE: {
    name: 'people',
    columns: [
      { id: 'id', type: 'string' },
      { id: 'name', type: 'string' },
      { id: 'kana', type: 'string' },
      { id: 'gender', type: 'string' },
      { id: 'age', type: 'number' },
      { id: 'type', type: 'string' },
      { id: 'contact', type: 'string' },
      { id: 'is_recurring', type: 'boolean' },
      { id: 'merged_into', type: 'string' },
      { id: 'note', type: 'string' },
      { id: 'created_at', type: 'string' },
      { id: 'updated_at', type: 'string' }
    ]
  },

  AVAILABILITY: {
    name: 'availability',
    columns: [
      { id: 'id', type: 'string' },
      { id: 'person_id', type: 'string' },
      { id: 'date', type: 'date' },
      { id: 'start_time', type: 'time' },
      { id: 'end_time', type: 'time' },
      { id: 'created_at', type: 'string' },
      { id: 'updated_at', type: 'string' }
    ]
  },

  /**
   * 1行＝「この日・この場所・この時間に、この人が入る」。
   *
   * **かつては slots（枠）と assignments（割り当て）に分かれていた。**
   * 1つの枠に入るのは1人までという方針にした結果、両者は常に1対1になり、
   * 枠だけが存在する状態（＝まだ誰も入っていない枠）も表せなくなったため統合した。
   *
   * この統合により「必要だがまだ誰もいない」は**データとして持てない。**
   * 不足の可視化が要るなら、場所ごとの必要時間帯を別テーブルで持つところから設計し直すこと。
   */
  ASSIGNMENTS: {
    name: 'assignments',
    columns: [
      { id: 'id', type: 'string' },
      { id: 'date', type: 'date' },
      { id: 'place_id', type: 'string' },
      { id: 'start_time', type: 'time' },
      { id: 'end_time', type: 'time' },
      { id: 'person_id', type: 'string' },
      { id: 'note', type: 'string' },
      { id: 'assigned_by', type: 'string' },
      { id: 'created_at', type: 'string' },
      { id: 'updated_at', type: 'string' }
    ]
  },

  /**
   * 職員の一括登録用の入力シート（service_staff_import.js）。
   *
   * **人が手で書き込む唯一のシート。** ほかのシートと違い、記入するのは運用者なので
   *   - 列にはヘッダーのメモ（`note`）で日本語の説明を付ける
   *   - 未記入を許す列を多くし、既定値で補う
   * ようにしてある。
   *
   * `status` / `person_id` / `imported_at` は**取り込み結果の書き戻し用**で、
   * 人が書く列ではない。とくに `person_id` は再実行時の目印になっており、
   * ここが埋まっている行は「同じ人への追記」として扱う（消すと別人が作られる）。
   *
   * `age` は数値ではなく文字列として読む。数値列にすると `42歳` のような書き方が
   * 空欄と区別できなくなり、打ち間違いを黙って捨ててしまうため。
   *
   * 日付は**書かなくてよい。** 職員は既定の勤務時間帯で毎日候補に出るため
   * （`staff_default_*`）、日付を書くのは「その日だけ別の時間帯」を表すときだけ。
   */
  STAFF_IMPORT: {
    name: 'staff_import',
    columns: [
      { id: 'name', type: 'string', note: '氏名（必須）' },
      { id: 'kana', type: 'string', note: 'ふりがな（任意）' },
      {
        id: 'gender', type: 'string',
        note: '性別（任意）\nmale / female / other / undisclosed、または 男性 / 女性 / その他 / 回答しない\n未記入は「回答しない」として登録します'
      },
      { id: 'age', type: 'string', note: '年齢（任意）\n半角数字。未記入なら空のまま登録します' },
      {
        id: 'contact', type: 'string',
        note: '連絡先（任意）\n同じ氏名でも連絡先が違えば別の人として登録します。\n配置表の画面には一切表示しません'
      },
      {
        id: 'start_date', type: 'date',
        note: '勤務する日（任意）\n2026-08-10 の形式。\n\n未記入でかまいません。職員は _config の staff_default_start〜staff_default_end の時間帯で毎日候補に出ます。\n「この日は早番」など、特定の日だけ別の時間帯にするときに書きます（書いた日は既定より優先されます）'
      },
      {
        id: 'end_date', type: 'date',
        note: '連続して勤務する最終日（任意）\n未記入なら開始日の1日だけ登録します'
      },
      {
        id: 'start_time', type: 'time',
        note: '開始時刻（任意）\n10:00 の形式。未記入なら _config の entry_default_start を使います。\n※ start_date を書いた行にだけ意味があります'
      },
      {
        id: 'end_time', type: 'time',
        note: '終了時刻（任意）\n17:00 の形式。24時以降は 26:00 のように書きます（翌2時）。\n未記入なら _config の entry_default_end を使います。\n※ start_date を書いた行にだけ意味があります'
      },
      { id: 'note', type: 'string', note: 'メモ（任意）\n配置表の画面には表示しません' },
      { id: 'status', type: 'string', note: '【自動】取り込みの結果。消しても書き換えても構いません' },
      {
        id: 'person_id', type: 'string',
        note: '【自動】登録した人のID。\nこの列が埋まっている行は、次に実行しても同じ人に追記します。\n消すと別の人として登録されます'
      },
      { id: 'imported_at', type: 'string', note: '【自動】取り込んだ日時' }
    ]
  },

  CONFIG: {
    name: '_config',
    hidden: true,
    columns: [
      { id: 'key', type: 'string' },
      { id: 'value', type: 'string' }
    ]
  },

  LOG: {
    name: '_log',
    hidden: true,
    columns: [
      { id: 'timestamp', type: 'string' },
      { id: 'operator', type: 'string' },
      { id: 'action', type: 'string' },
      { id: 'target_id', type: 'string' },
      { id: 'detail', type: 'string' }
    ]
  }
};

/**
 * 場所（役割）の背景色として受け付けるキー。
 *
 * **色そのもの（`#fde8e8` など）は保存しない。** 実際の色は画面側の CSS が決める。
 *   - 濃さを直したいときに、保存済みのデータを触らずに済む
 *   - 文字が読めなくなる色を選べない（淡い色だけを用意する）
 * ため。空欄は「色なし」。
 *
 * 画面側の対応表は `common_script.html` の `PLACE_COLOR_OPTIONS`、
 * 実際の色は `style.html` の `--tint-*`。**値を足すときは3か所とも直す。**
 */
const PLACE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray', 'brown'];

/** 人の種別 */
const PERSON_TYPE = {
  VOLUNTEER: 'volunteer',
  STAFF: 'staff'
};

/**
 * 性別。`type` と揃えて英語コードで保存し、日本語への変換は画面側で行う
 * （クライアント側の対応表は common_script.html の GENDER_OPTIONS）。
 */
const GENDER = {
  MALE: 'male',
  FEMALE: 'female',
  OTHER: 'other',
  UNDISCLOSED: 'undisclosed'
};

/** 受け付ける性別の値。ここに無い値は登録時に弾く */
const GENDER_VALUES = [GENDER.MALE, GENDER.FEMALE, GENDER.OTHER, GENDER.UNDISCLOSED];

/**
 * 一括登録シートで受け付ける性別の書き方（`service_staff_import.js`）。
 *
 * **応募フォームには使わない。** あちらは画面が選択肢を出すので、コードだけを受ければよい。
 * こちらは人がシートに手で書くため、日本語の表記も通す。
 */
const GENDER_ALIASES = {
  '男性': GENDER.MALE, '男': GENDER.MALE, 'm': GENDER.MALE,
  '女性': GENDER.FEMALE, '女': GENDER.FEMALE, 'f': GENDER.FEMALE,
  'その他': GENDER.OTHER, '他': GENDER.OTHER,
  '回答しない': GENDER.UNDISCLOSED, '無回答': GENDER.UNDISCLOSED,
  '未回答': GENDER.UNDISCLOSED, '不明': GENDER.UNDISCLOSED
};

/**
 * 受け付ける年齢の範囲。
 * 打ち間違い（西暦を入れた、桁を余分に打った）を弾くための上限で、
 * 参加できる年齢の制限ではない。運用上の可否は人が判断する。
 */
const AGE_MIN = 0;
const AGE_MAX = 120;

/**
 * `_config` の既定値。
 * setup() が投入する。既に値がある場合は上書きしない。
 * view_token / web_app_url はここに書かず、動的に決まる。
 */
const CONFIG_DEFAULTS = {
  // 一日の全体の時間範囲。配置表の横軸はこの範囲で描く。
  // 24時以降は翌日を表すので、深夜までの日は day_end に '26:00' のように書く
  day_start: '10:00',
  day_end: '17:00',
  slot_unit_minutes: '10',
  // 登録画面（応募フォーム）に最初から入っている時間帯
  entry_default_start: '10:00',
  entry_default_end: '17:00',
  // 職員の既定の勤務時間帯。申告が無い日の職員は、この時間帯にいるものとして候補に出す
  // （service_board.js `appendStaffDefaultAvailability_`）
  staff_default_start: '10:00',
  staff_default_end: '17:00',
  public_name_style: 'full'
};

/** `_config` のキー名 */
const CONFIG_KEY = {
  VIEW_TOKEN: 'view_token',
  WEB_APP_URL: 'web_app_url',
  DAY_START: 'day_start',
  DAY_END: 'day_end',
  SLOT_UNIT_MINUTES: 'slot_unit_minutes',
  ENTRY_DEFAULT_START: 'entry_default_start',
  ENTRY_DEFAULT_END: 'entry_default_end',
  STAFF_DEFAULT_START: 'staff_default_start',
  STAFF_DEFAULT_END: 'staff_default_end',
  PUBLIC_NAME_STYLE: 'public_name_style'
};

/**
 * 使わなくなった `_config` のキー。
 *
 * `seedConfigDefaults_` は行を消さないため、既存のシートには残り続ける。
 * **消さずに一覧で持っておく**ことで、`setup()` が「もう使っていない」と知らせられる。
 * 残っていても動作には影響しない。
 *
 *   default_slot_*   … 枠が無い場所に破線で出していた「既定の枠」。機能ごと廃止
 *
 * **`staff_default_start` / `staff_default_end` は一度ここに入れたが、復活させた。**
 * 職員を毎日候補に出す仕組みを戻したため（CONFIG_DEFAULTS 参照）。
 * 以前この設定を使っていたシートでは、残っていた古い値がそのまま効く。
 */
const CONFIG_RETIRED_KEYS = [
  'default_slot_start',
  'default_slot_end',
  'default_slot_required'
];

/**
 * 枠の廃止にともなって使わなくなったシート。
 * **自動では消さない。** 移行後も中身を見返せるよう、`migrateSlots()` が
 * 名前を変えて残す（`slots_old_...`）。
 */
const RETIRED_SHEET_NAMES = ['slots', 'slot_templates'];

/**
 * 一括登録シートから一度に取り込む行数の上限。
 * 実行時間の上限（6分）に当たって中途半端に書き込まれるのを防ぐための歯止め。
 */
const STAFF_IMPORT_MAX_ROWS = 500;

/**
 * 1行で指定できる勤務日数の上限（開始日〜終了日）。
 * 終了日の打ち間違い（年を間違える等）で可用性が大量に作られるのを防ぐ。
 */
const STAFF_IMPORT_MAX_DAYS = 62;

/** LockService の待機時間（ミリ秒） */
const LOCK_TIMEOUT_MS = 10000;

/**
 * 応募受付（submitAvailability）だけの待機時間（ミリ秒）。
 *
 * ここは応募が集中する唯一の処理で、**待たされることより登録できないことのほうが
 * 損害が大きい**（service_entry.js 冒頭）。管理操作は実質1人ずつなので
 * 待たせる必要がなく、上の10秒のままにしてある。
 */
const LOCK_TIMEOUT_ENTRY_MS = 30000;

/**
 * `_log` に残す操作者名。
 *
 * **記名は行わない**（design.md 2）。管理URLを開けば誰でも操作できるため、
 * 誰が操作したかは記録できない。列を空にすると「記録し忘れ」と区別が付かないので、
 * 記名していないことが分かる固定値を入れる。
 */
const LOG_OPERATOR = '(管理画面)';
