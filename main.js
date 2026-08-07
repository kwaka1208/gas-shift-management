/**
 * main.gs … doGet のみ。ルーティングは薄く保つ。
 *
 * URL:
 *   ?t=<token>&view=board&d=YYYY-MM-DD … 配置表（既定。閲覧のみ）
 *   ?t=<token>&view=admin&d=YYYY-MM-DD … 配置表（枠の作成・割り当てができる）
 *   ?t=<token>&view=entry              … 可用性登録フォーム
 *   ?t=<token>&view=print&d=YYYY-MM-DD … 印刷用配置表（A3横。PDF保存もここから）
 *
 * board と admin は同じ画面（index.html）で、boot.admin の真偽だけが違う。
 * 配置表には「役割ごと」と「人ごと」の両方が縦に並ぶ（design.md 4.1）。
 *
 * **これは保護ではない。** トークンは共通なので、閲覧URLを知っていれば管理URLも作れる。
 * 誤操作を防ぐための画面の分離であり、認証ではない（design.md 2）。
 */

/** 既定の画面 */
const DEFAULT_VIEW = 'board';

/** 実装済みの画面（Phase の進行に合わせて増やす） */
const KNOWN_VIEWS = ['board', 'admin', 'entry', 'print'];

/** ビュー → HTMLファイル名。ここに無いビューは「準備中」を返す */
const VIEW_TEMPLATES = {
  board: 'index',
  admin: 'index',
  entry: 'entry',
  print: 'print'
};

function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const token = trimStr_(params.t);
  const view = trimStr_(params.view) || DEFAULT_VIEW;

  // 配布用URL（/exec）を控える。**トークン検証より前に置くこと。**
  // 正しい /exec を取れるのは doGet の中だけで（service_auth.js webAppUrl_）、
  // ここに置けば「デプロイ画面のURLを素で開く」だけで記録できる。検証の後ろに
  // 置くと ?t=… 付きの正しいURLを既に持っている人しか記録できず、意味を成さない。
  // 書き込むのは未設定のとき1回だけ。URLパラメータなど外部の入力は一切保存しない
  rememberWebAppUrl_();

  // setup() 未実行だとシートが無く、トークン検証の中で例外になる。
  // 生のエラー画面を見せず、何をすればよいかを伝える
  let valid = false;
  try {
    valid = verifyViewToken_(token);
  } catch (err) {
    console.error('doGet: ' + err);
    return renderMessage_(
      '準備ができていません',
      'セットアップが完了していません。スプレッドシートのスクリプトエディタから setup() を実行してください。'
    );
  }

  if (!valid) {
    return renderMessage_(
      'このURLでは開けません',
      '配布されたリンクまたはQRコードをもう一度お確かめください。'
    );
  }

  if (KNOWN_VIEWS.indexOf(view) === -1) {
    return renderMessage_('画面が見つかりません', '指定された画面（' + view + '）はありません。');
  }

  const file = VIEW_TEMPLATES[view];
  if (!file) {
    return renderMessage_('準備中です', 'この画面（' + view + '）はまだ公開していません。');
  }

  const date = isValidDateStr_(trimStr_(params.d)) ? trimStr_(params.d) : todayStr_();

  const template = HtmlService.createTemplateFromFile(file);
  // クライアントの初期値。ここに業務データは載せない（描画はサーバー呼び出しの結果で行う）
  template.boot = {
    token: token,
    view: view,
    date: date,
    // 管理画面かどうか。セキュリティ境界ではなく、画面を出し分けるためのフラグ
    admin: view === 'admin',
    // 画面から画面へのリンクの土台。**相対URLは使えない**（iframe の中で動くため）
    baseUrl: webAppUrl_(),
    // 代理入力モード。セキュリティ境界ではなく、画面を出し分けるためのフラグ
    proxy: trimStr_(params.proxy) === '1'
  };

  return template.evaluate()
    .setTitle('ボランティアシフト配置')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * HTMLファイルを差し込む（style.html / script.html の分割用）。
 * `<?!= include('style') ?>` の形で使う。
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * サーバー側で JSON をスクリプトタグに埋め込むための文字列化。
 * `</script>` で閉じられる事故を防ぐため、`<` をエスケープする。
 */
function toJsonLiteral_(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

/**
 * 1画面ぶんの簡易メッセージを返す。
 * エラー時の表示にも使うため、依存を持たせない。
 */
function renderMessage_(title, body) {
  const html =
    '<div class="wrap">' +
    '<h1>' + escapeHtml_(title) + '</h1>' +
    '<p>' + escapeHtml_(body) + '</p>' +
    '</div>' +
    '<style>' +
    'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;' +
    'background:#f7f7f8;color:#222;line-height:1.7}' +
    '.wrap{max-width:32rem;margin:0 auto;padding:2rem 1.25rem}' +
    'h1{font-size:1.25rem;margin:0 0 .75rem}' +
    'p{margin:0;color:#555}' +
    '</style>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('ボランティアシフト配置')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
