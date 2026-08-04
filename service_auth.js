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
 */
function webAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
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
