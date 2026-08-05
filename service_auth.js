/**
 * service_auth.gs … 閲覧トークンの検証と、スクリプトエディタ専用関数のガード
 *
 * 【この仕組みで守れるもの・守れないもの】
 *
 * Google認証は使わない（利用者にGoogleアカウントを要求しないため）。
 * 保護は「URLに含まれる推測困難なトークン（?t=xxxx）」の1段階だけである。
 *
 *   守れる … URLを知らない第三者からのアクセス
 *   守れない … URLを知っている人による編集・削除
 *
 * **合言葉による管理者認証は廃止した。** 管理操作は「操作する人の名前」を記名して
 * 行い、`_log` に残す。認証ではなく記録による抑止という位置づけ。
 * URL（QRコード）を配った相手は全員が枠を編集できることを前提に運用すること。
 *
 * この判断のため、連絡先（people.contact）は誰に対しても画面へ返さない。
 * 連絡先が必要なときはスプレッドシートの people シートを直接参照する。
 */

// ---------------------------------------------------------------------------
// スクリプトエディタ専用関数のガード
// ---------------------------------------------------------------------------

/**
 * スクリプトエディタ（＝スプレッドシートの所有者）からの実行だけを許す。
 *
 * 【重要】末尾アンダースコアの無いグローバル関数は、すべて google.script.run から
 * 呼び出せてしまう。本アプリは「実行=自分 / アクセス=全員（匿名可）」でデプロイする
 * ため、ガードが無いと匿名の第三者が regenerateViewToken() を呼んで閲覧URLを
 * 差し替えられる。運用系の関数には必ずこれを最初に置くこと。
 *
 * 匿名アクセス時 getActiveUser().getEmail() は空文字を返す。
 * エディタから実行したときだけ、実行ユーザーと一致する。
 */
function requireOwner_() {
  let active = '';
  let effective = '';
  try {
    active = Session.getActiveUser().getEmail();
    effective = Session.getEffectiveUser().getEmail();
  } catch (e) {
    active = '';
  }
  if (!active || !effective || active !== effective) {
    throw new Error('この関数はスクリプトエディタからのみ実行できます。');
  }
}

// ---------------------------------------------------------------------------
// 閲覧トークン
// ---------------------------------------------------------------------------

/** 閲覧トークンが正しいか */
function verifyViewToken_(token) {
  const expected = getConfigValue_(CONFIG_KEY.VIEW_TOKEN, '');
  if (!expected) return false;
  return constantTimeEquals_(trimStr_(token), expected);
}

/**
 * 閲覧トークンを検証する。不正なら例外を投げる。
 * **公開関数はすべて（読み取りも書き込みも）これを通すこと。**
 */
function requireViewToken_(token) {
  if (!verifyViewToken_(token)) {
    throw new Error('URLが正しくありません。配布されたリンクを確認してください。');
  }
}

/**
 * 閲覧トークンを再発行する（漏えい時などにスクリプトエディタから実行する）。
 * 実行すると以前のURL・QRコードはすべて無効になる。配り直しが必要。
 */
function regenerateViewToken() {
  requireOwner_();
  const token = randomToken_();
  setConfigValue_(CONFIG_KEY.VIEW_TOKEN, token);
  appendLog_('(system)', 'regenerate_view_token', '', '');
  console.log('新しい閲覧トークン: ' + token);
  console.log('新しい閲覧URL: ' + buildViewUrl_(token));
  console.log('※ 以前のURL・QRコードは使えなくなりました。配り直してください。');
  warnIfNotDeployedUrl_();
  return token;
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/**
 * 推測困難なトークンを作る（128ビット相当）。
 * Utilities.getUuid() は暗号論的に安全な乱数を使う。Math.random() は使わない。
 */
function randomToken_() {
  return Utilities.getUuid().replace(/-/g, '');
}

/** 文字列比較。長さが同じ場合に処理時間が内容に依存しないようにする */
function constantTimeEquals_(a, b) {
  const sa = String(a === null || a === undefined ? '' : a);
  const sb = String(b === null || b === undefined ? '' : b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Webアプリの絶対URL。取得できなければ空文字。
 *
 * **画面から画面へのリンクは、必ずこの絶対URLで組み立てること。**
 * HtmlService の画面は iframe（サンドボックス）の中で動くため、`?t=...` のような
 * 相対URLは googleusercontent.com のサンドボックスURLに対して解決されてしまい、
 * アプリのURLにならない。
 *
 * 【なぜ `_config` を先に見るのか】
 * `ScriptApp.getService().getUrl()` が返すURLは、呼ばれた文脈で変わる。
 *   Webアプリのリクエスト中（doGet）… `/exec`（デプロイURL。匿名で開ける）
 *   スクリプトエディタからの実行     … `/dev` （開発用テストURL。**Googleログイン必須**）
 * `/dev` と `/exec` はIDそのものが違う（前者はスクリプトID、後者はデプロイID）ため、
 * 文字列を置換して `/exec` を作ることはできない。そこで doGet で得た `/exec` を
 * `_config.web_app_url` に控えておき、エディタからでも配布用URLを組み立てられるようにする。
 */
function webAppUrl_() {
  const saved = getConfigValue_(CONFIG_KEY.WEB_APP_URL, '');
  // 保存済みの値も通す。ドメイン付きで控えてしまった `_config` を書き換えずに直せる
  if (saved) return normalizeWebAppUrl_(saved);
  return serviceUrl_();
}

/** `ScriptApp.getService().getUrl()` の値。取得できなければ空文字 */
function serviceUrl_() {
  try {
    return normalizeWebAppUrl_(ScriptApp.getService().getUrl() || '');
  } catch (e) {
    return '';
  }
}

/**
 * ウェブアプリURLを、匿名で開ける形に直す。
 *
 * 【なぜ必要か】
 * Google Workspace のアカウントでスクリプトを所有していると、
 * `ScriptApp.getService().getUrl()` は**ドメイン限定の形**を返す。
 *
 *   https://script.google.com/a/example.com/macros/s/<ID>/exec
 *   https://script.google.com/a/macros/example.com/s/<ID>/exec  ← 古い形
 *
 * これは「そのドメインのアカウントでログイン済み」であることを前提としたURLで、
 * 未ログインで開くとGoogle側のアカウント判定に入り、**`?t=` が doGet まで届かない**。
 * その結果「このURLでは開けません」になる。ドメイン部分を落とした
 *
 *   https://script.google.com/macros/s/<ID>/exec
 *
 * であれば匿名で開ける。デプロイID（`/s/<ID>/`）は同じものなので、組み替えて良い。
 */
function normalizeWebAppUrl_(url) {
  const clean = trimStr_(url);
  if (!clean) return '';
  // ドメインが入る位置は形式によって違うため、`/s/<ID>/exec|dev` だけを取り出して組み直す
  const m = clean.match(/^https:\/\/script\.google\.com\/.*\/s\/([^/?#]+)\/(exec|dev)\b/);
  if (!m) return clean;
  return 'https://script.google.com/macros/s/' + m[1] + '/' + m[2];
}

/** 配布して良いURL（`/exec`）か。`/dev` は編集権限が要るので配れない */
function isDeployedUrl_(url) {
  return /\/exec$/.test(trimStr_(url));
}

/**
 * doGet の中から呼ぶ。デプロイURL（`/exec`）を控えていなければ控える。
 *
 * 未設定のときだけ書き込む。デプロイを作り直してURLが変わったときは
 * setWebAppUrl() で明示的に入れ替える（アクセスのたびに書き換わると、
 * 古いデプロイを開いた人が新しいURLを巻き戻してしまうため）。
 */
function rememberWebAppUrl_() {
  try {
    if (getConfigValue_(CONFIG_KEY.WEB_APP_URL, '')) return;
    const url = serviceUrl_();
    if (!isDeployedUrl_(url)) return;
    setConfigValue_(CONFIG_KEY.WEB_APP_URL, url);
  } catch (e) {
    // URLを控えられなくても画面の表示は続ける
    console.error('rememberWebAppUrl_: ' + e);
  }
}

/**
 * 各画面のURLを組み立てる。デプロイ前は URL を取得できないため、その旨を返す。
 * @param {string} token 閲覧トークン
 * @param {string=} query 追加のクエリ（例: '&view=entry'）
 */
function buildViewUrl_(token, query) {
  const base = webAppUrl_();
  if (!base) return '(未デプロイのためURLを取得できません)';
  return base + '?t=' + encodeURIComponent(token) + (query || '');
}
