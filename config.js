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
 * `_config` の既定値。
 * setup() が投入する。既に値がある場合は上書きしない。
 * view_token はここに書かず、動的に生成する。
 */
const CONFIG_DEFAULTS = {
  day_start: '10:00',
  day_end: '17:00',
  slot_unit_minutes: '10',
  staff_default_start: '10:00',
  staff_default_end: '17:00',
  public_name_style: 'full',
  operators: ''
};

/** `_config` のキー名 */
const CONFIG_KEY = {
  VIEW_TOKEN: 'view_token',
  DAY_START: 'day_start',
  DAY_END: 'day_end',
  SLOT_UNIT_MINUTES: 'slot_unit_minutes',
  STAFF_DEFAULT_START: 'staff_default_start',
  STAFF_DEFAULT_END: 'staff_default_end',
  PUBLIC_NAME_STYLE: 'public_name_style',
  OPERATORS: 'operators'
};

/** LockService の待機時間（ミリ秒） */
const LOCK_TIMEOUT_MS = 10000;
