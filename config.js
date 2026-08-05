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
      { id: 'created_at', type: 'string' },
      { id: 'updated_at', type: 'string' }
    ]
  },

  SLOT_TEMPLATES: {
    name: 'slot_templates',
    columns: [
      { id: 'id', type: 'string' },
      { id: 'template_name', type: 'string' },
      { id: 'day_of_week', type: 'number' },
      { id: 'place_id', type: 'string' },
      { id: 'start_time', type: 'time' },
      { id: 'end_time', type: 'time' },
      { id: 'required_count', type: 'number' },
      { id: 'staff_required', type: 'number' },
      { id: 'created_at', type: 'string' },
      { id: 'updated_at', type: 'string' }
    ]
  },

  SLOTS: {
    name: 'slots',
    columns: [
      { id: 'id', type: 'string' },
      { id: 'date', type: 'date' },
      { id: 'place_id', type: 'string' },
      { id: 'start_time', type: 'time' },
      { id: 'end_time', type: 'time' },
      { id: 'required_count', type: 'number' },
      { id: 'staff_required', type: 'number' },
      { id: 'note', type: 'string' },
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

  ASSIGNMENTS: {
    name: 'assignments',
    columns: [
      { id: 'id', type: 'string' },
      { id: 'slot_id', type: 'string' },
      { id: 'person_id', type: 'string' },
      { id: 'assigned_by', type: 'string' },
      { id: 'created_at', type: 'string' },
      { id: 'updated_at', type: 'string' }
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
  day_start: '10:00',
  day_end: '17:00',
  slot_unit_minutes: '10',
  staff_default_start: '10:00',
  staff_default_end: '17:00',
  // 枠が1つも無い場所に、この時間帯の枠を仮想的に表示する（シートには書かない）。
  // 開始か終了を空にすると表示しなくなる
  default_slot_start: '10:00',
  default_slot_end: '17:00',
  default_slot_required: '1',
  public_name_style: 'full'
};

/** `_config` のキー名 */
const CONFIG_KEY = {
  VIEW_TOKEN: 'view_token',
  WEB_APP_URL: 'web_app_url',
  DAY_START: 'day_start',
  DAY_END: 'day_end',
  SLOT_UNIT_MINUTES: 'slot_unit_minutes',
  STAFF_DEFAULT_START: 'staff_default_start',
  STAFF_DEFAULT_END: 'staff_default_end',
  DEFAULT_SLOT_START: 'default_slot_start',
  DEFAULT_SLOT_END: 'default_slot_end',
  DEFAULT_SLOT_REQUIRED: 'default_slot_required',
  PUBLIC_NAME_STYLE: 'public_name_style'
};

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
