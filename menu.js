/**
 * menu.gs … スプレッドシートのメニュー
 *
 * `onOpen` は単純トリガーで、スプレッドシートを開くと自動で走る（設定は不要）。
 * **単純トリガーは実行できることが限られる**ので、ここには「メニューを組み立てる」以外を
 * 書かないこと。重い処理・シートの書き換えは、メニューから呼ぶ関数の中で行う。
 *
 * 【なぜ運用の入口をメニューにするのか】
 * 一括登録は「シートに書いて取り込む」作業で、スクリプトエディタを開く必然性が無い。
 * 記入した画面のまま実行できるほうが間違いが少ない（setup() など初回だけの操作は
 * これまでどおりエディタから実行する）。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('シフト管理')
    .addItem('職員を一括登録する', 'menuImportStaff')
    .addItem('一括登録シートを開く（無ければ作る）', 'menuPrepareStaffImportSheet')
    .addToUi();
}

/**
 * メニューから一括登録を実行する。
 *
 * 例外はダイアログで見せる。**メニューから実行したときの既定のエラー表示は消えやすく、
 * 何が悪かったのか運用者に届かない。**
 */
function menuImportStaff() {
  const ui = SpreadsheetApp.getUi();  // ウェブアプリ経由では例外になる（＝匿名からは到達しない）
  try {
    requireOwner_();  // api.js の規約。呼び先でも確認しているが、入口でも明示する
    const result = importStaff();
    ui.alert('職員の一括登録', formatStaffImportResult_(result), ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('職員の一括登録',
      '取り込めませんでした。\n\n' + ((e && e.message) ? e.message : String(e)),
      ui.ButtonSet.OK);
  }
}

/** メニューから一括登録シートを用意して開く */
function menuPrepareStaffImportSheet() {
  const ui = SpreadsheetApp.getUi();
  try {
    requireOwner_();
    const message = prepareStaffImportSheet();
    ui.alert('一括登録シート',
      message + '\n\n各列の書き方は、1行目の見出しに付いているメモに書いてあります。',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('一括登録シート',
      '用意できませんでした。\n\n' + ((e && e.message) ? e.message : String(e)),
      ui.ButtonSet.OK);
  }
}
