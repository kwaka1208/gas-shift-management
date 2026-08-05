/**
 * setup.gs … 初回セットアップ
 *
 * スクリプトエディタから setup() を1回実行する。何度実行しても安全（冪等）。
 *
 *   1. 必要なシートを作り、ヘッダー行を書き込む
 *   2. `_config` に既定値を投入し、view_token を生成する
 *   3. 日付・時刻・連絡先の列を「書式なしテキスト」にする
 *   4. `_config` / `_log` を非表示にする
 *   5. 閲覧URLをログに出力する
 *
 * 認証は閲覧トークンだけで、管理者の合言葉は無い。
 * URLを配った相手は全員が枠を編集できる前提で運用すること。
 */
function setup() {
  requireOwner_();
  const messages = [];

  Object.keys(SHEET_DEFS).forEach(function (key) {
    const def = SHEET_DEFS[key];
    messages.push(ensureSheet_(def));
  });

  messages.push(seedConfigDefaults_());
  messages.push(reportRetiredConfigKeys_());

  const token = ensureViewToken_();
  applySheetVisibility_();

  console.log('--- セットアップ結果 ---');
  messages.forEach(function (m) { console.log(m); });
  console.log('');
  printUrls_(token);
  console.log('');
  console.log('※ このURLを知っている人は誰でも枠を編集できます。配布先にご注意ください。');
  console.log('   URLが漏れた場合は regenerateViewToken() で作り直せます（要・配り直し）。');
  console.log('※ `_config` / `_log` は非表示にしています。編集するときは');
  console.log('   シート下部のタブを右クリック →「非表示のシート」から表示してください。');

  return { ok: true, viewToken: token };
}

/**
 * シートを定義どおりに整える。
 * 既存シートのデータは壊さない。足りない列だけを右端に追加する。
 */
function ensureSheet_(def) {
  const spreadsheet = ss_();
  let sheet = spreadsheet.getSheetByName(def.name);
  let created = false;

  if (!sheet) {
    sheet = spreadsheet.insertSheet(def.name);
    created = true;
  }

  const wanted = def.columns.map(function (c) { return c.id; });
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(trimStr_)
    : [];

  const added = [];
  if (existing.filter(function (h) { return h; }).length === 0) {
    // 空のシート … ヘッダーをそのまま書く
    sheet.getRange(1, 1, 1, wanted.length).setValues([wanted]);
  } else {
    wanted.forEach(function (colId) {
      if (existing.indexOf(colId) === -1) {
        sheet.getRange(1, sheet.getLastColumn() + 1).setValue(colId);
        added.push(colId);
      }
    });
  }

  // ヘッダーの体裁
  const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
  headerRange.setFontWeight('bold');
  if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);

  applyTextFormat_(sheet, def);
  applyHeaderNotes_(sheet, def);

  const parts = [];
  if (created) parts.push('作成');
  if (added.length > 0) parts.push('列を追加: ' + added.join(', '));
  if (parts.length === 0) parts.push('変更なし');
  return '[' + def.name + '] ' + parts.join(' / ');
}

/**
 * 文字列・日付・時刻の列を「書式なしテキスト」にする。
 *
 * これを怠ると '2026-08-04' が日付型に、'09:00' が時刻型に、
 * '090-1234-5678' が日付に化ける。design.md 5.1 の前提はこの設定で担保される。
 */
function applyTextFormat_(sheet, def) {
  const colMap = getColumnMap_(sheet);
  const maxRows = sheet.getMaxRows();
  def.columns.forEach(function (col) {
    if (TEXT_TYPES_.indexOf(col.type) === -1) return;
    const i = colMap[col.id];
    if (i === undefined) return;
    sheet.getRange(1, i + 1, maxRows, 1).setNumberFormat('@');
  });
}

/**
 * ヘッダーのセルに日本語の説明をメモとして付ける（`note` を持つ列だけ）。
 *
 * 人が手で書き込むシート（`staff_import`）のためのもの。列名は英語のままにして
 * コード側の規約（ヘッダー名で列を引く）を崩さず、書き方の説明だけをシート上に置く。
 *
 * **メモは1回の setNotes でまとめて書く。** 定義に無い列のメモは消える点に注意。
 */
function applyHeaderNotes_(sheet, def) {
  const hasNote = def.columns.some(function (c) { return !!c.note; });
  if (!hasNote) return;

  const colMap = getColumnMap_(sheet);
  const width = sheet.getLastColumn();
  if (width < 1) return;

  const notes = new Array(width).fill('');
  def.columns.forEach(function (col) {
    const i = colMap[col.id];
    if (i === undefined || !col.note) return;
    notes[i] = col.note;
  });
  sheet.getRange(1, 1, 1, width).setNotes([notes]);
}

/** `_config` に既定値を投入する。既に値があるキーは上書きしない */
function seedConfigDefaults_() {
  const current = getConfig_();
  const toWrite = {};
  Object.keys(CONFIG_DEFAULTS).forEach(function (key) {
    if (current[key] === undefined) toWrite[key] = CONFIG_DEFAULTS[key];
  });
  const keys = Object.keys(toWrite);
  if (keys.length === 0) return '[_config] 既定値は投入済み';
  setConfigValues_(toWrite);
  return '[_config] 既定値を投入: ' + keys.join(', ');
}

/**
 * 使わなくなったキーが `_config` に残っていたら知らせる。
 *
 * **自動では消さない。** 運用者が値を入れた行を、こちらの都合で黙って消すべきではない。
 * 残っていても動作には影響しないので、気づけるようにするだけでよい。
 */
function reportRetiredConfigKeys_() {
  const current = getConfig_();
  const found = CONFIG_RETIRED_KEYS.filter(function (key) {
    return current[key] !== undefined;
  });
  if (found.length === 0) return '[_config] 廃止キーなし';
  return '[_config] 使わなくなったキーが残っています（消して構いません）: ' + found.join(', ');
}

/** 閲覧トークンが無ければ発行する。既にあれば維持する（URLを変えない） */
function ensureViewToken_() {
  const current = getConfigValue_(CONFIG_KEY.VIEW_TOKEN, '');
  if (current) return current;
  const token = randomToken_();
  setConfigValue_(CONFIG_KEY.VIEW_TOKEN, token);
  return token;
}

/** システム用シートを非表示にする */
function applySheetVisibility_() {
  Object.keys(SHEET_DEFS).forEach(function (key) {
    const def = SHEET_DEFS[key];
    if (!def.hidden) return;
    const sheet = ss_().getSheetByName(def.name);
    if (sheet && !sheet.isSheetHidden()) sheet.hideSheet();
  });
}

/** 現在のURLをログに出す（QRコードを作り直すときに使う） */
function showViewUrl() {
  requireOwner_(); // 閲覧トークンが漏れるため、匿名からは呼ばせない
  const token = getConfigValue_(CONFIG_KEY.VIEW_TOKEN, '');
  if (!token) {
    console.log('閲覧トークンが未設定です。setup() を実行してください。');
    return '';
  }
  printUrls_(token);
  return buildViewUrl_(token);
}

/**
 * 配布用のウェブアプリURL（`/exec`）を登録する。
 *
 * ふだんは doGet が自動で控えるため、実行する必要は無い。
 * デプロイを作り直してURLが変わったときと、一度も公開URLで開いていないうちに
 * URLを知りたいときだけ、デプロイ画面のURLをそのまま渡して実行する。
 *
 *   setWebAppUrl('https://script.google.com/macros/s/AKfycb.../exec')
 */
function setWebAppUrl(url) {
  requireOwner_();
  // ドメイン限定の形（/a/example.com/macros/...）で渡されても匿名で開ける形に直す
  const clean = normalizeWebAppUrl_(trimStr_(url).replace(/[?#].*$/, ''));
  if (!isDeployedUrl_(clean)) {
    console.log('末尾が /exec のURLを渡してください。渡された値: ' + trimStr_(url));
    console.log('スクリプトエディタの「デプロイ」→「デプロイを管理」に出ている');
    console.log('ウェブアプリのURLです（/dev で終わるものは開発用で、配布できません）。');
    return '';
  }
  setConfigValue_(CONFIG_KEY.WEB_APP_URL, clean);
  console.log('配布用URLを登録しました: ' + clean);
  console.log('');
  const token = getConfigValue_(CONFIG_KEY.VIEW_TOKEN, '');
  if (token) printUrls_(token);
  return clean;
}

/**
 * 用途ごとのURLを並べて出す。
 * どれを誰に配るのかを取り違えると事故になるため、必ずセットで表示する。
 */
function printUrls_(token) {
  console.log('配置表・閲覧用（見るだけ）: ' + buildViewUrl_(token));
  console.log('配置表・管理用（枠と割り当てを編集できる）: ' + buildViewUrl_(token, '&view=admin'));
  console.log('応募フォーム（QRコードにするのはこれ）: ' + buildViewUrl_(token, '&view=entry'));
  console.log('代理入力（管理者だけが使う）: ' + buildViewUrl_(token, '&view=entry&proxy=1'));
  console.log('閲覧トークン: ' + token);
  console.log('※ 管理用URLは view=admin を足しただけです。閲覧用URLを知っている人は');
  console.log('   管理用URLも作れます。**保護ではなく、誤操作を防ぐための画面の分離です。**');
  warnIfNotDeployedUrl_();
}

/**
 * 上に出したURLが配布できないもの（`/dev`）だったら警告する。
 *
 * エディタから実行すると `/dev`（開発用テストURL）しか取れない。これは
 * **Googleアカウントでのログインが必須**で、ボランティアには配れない。
 */
function warnIfNotDeployedUrl_() {
  const url = webAppUrl_();
  if (isDeployedUrl_(url)) return;
  console.log('');
  console.log('⚠ 上のURLは配布できません。' + (url ? '（' + url + '）' : ''));
  if (/\/dev$/.test(url)) {
    console.log('  /dev は開発用のテストURLで、開くとGoogleへのログインを求められます。');
  } else {
    console.log('  ウェブアプリとしてデプロイされていない可能性があります。');
  }
  console.log('  対処: デプロイ画面のウェブアプリURL（/exec で終わるもの）をコピーし、');
  console.log('        setWebAppUrl(\'https://script.google.com/macros/s/.../exec\') を実行してください。');
  console.log('  ※ 一度その公開URLでアプリを開けば、以降は自動で控えます。');
}
