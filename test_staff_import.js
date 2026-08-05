/**
 * test_staff_import.gs … 一括登録の入力検証と可用性計算の単体確認
 *
 * `service_staff_import.js` を触ったら runStaffImportTests() を実行すること
 * （スクリプトエディタから実行）。
 *
 * **ここで検証するのはシートに触らない部分だけ。** 取り込み本体（importStaffData_）は
 * 実データを書き換えるため、テストからは呼ばない。可用性の計算は
 * `planAvailabilityBatch_`（純粋関数）として切り出してあるので、そちらを検証する。
 *
 * test_util.js と同じく requireOwner_() でガードしていない（副作用もデータ露出も無い）。
 */
function runStaffImportTests() {
  const t = newTestRunner_();

  // --- 性別 -----------------------------------------------------------------
  // 未記入は空文字。新規なら undisclosed、既存なら「触らない」の意味になる
  t.eq(parseImportGender_('', []), '', '性別の未記入は空文字');
  t.eq(parseImportGender_('male', []), GENDER.MALE, 'コードはそのまま');
  t.eq(parseImportGender_('FEMALE', []), GENDER.FEMALE, '大文字でも通る');
  t.eq(parseImportGender_('男性', []), GENDER.MALE, '★ 日本語も受ける');
  t.eq(parseImportGender_('女', []), GENDER.FEMALE, '1文字の日本語も受ける');
  t.eq(parseImportGender_('回答しない', []), GENDER.UNDISCLOSED, '回答しない');
  t.eq(errorCount_(function (errs) { return parseImportGender_('だんせい', errs); }), 1,
    '知らない書き方はエラーになる');

  // --- 年齢 -----------------------------------------------------------------
  // 応募フォームと違い、一括登録では任意（管理者が代理で入れるため）
  t.eq(parseImportAge_('', []), null, '★ 年齢の未記入は null（任意）');
  t.eq(parseImportAge_('42', []), 42, '半角数字は数値になる');
  t.eq(errorCount_(function (errs) { return parseImportAge_('４２', errs); }), 1,
    '全角数字はエラー');
  t.eq(errorCount_(function (errs) { return parseImportAge_('42歳', errs); }), 1,
    '★ 単位付きはエラー（数値列が静かに壊れるのを防ぐ）');
  t.eq(errorCount_(function (errs) { return parseImportAge_('999', errs); }), 1,
    '範囲外はエラー');

  // --- 勤務する日 -----------------------------------------------------------
  t.eq(parseImportDates_({ start_date: '2026-08-10', end_date: '' }, []).length, 1,
    '終了日が空なら1日だけ');
  t.eq(parseImportDates_({ start_date: '2026-08-10', end_date: '2026-08-12' }, []).length, 3,
    '★ 開始日〜終了日は両端を含む（3日）');
  t.eq(parseImportDates_({ start_date: '2026-08-10', end_date: '2026-08-10' }, [])[0],
    '2026-08-10', '同じ日を指定しても1日');
  // 開始日は任意。書かない行は「毎日、既定の時間帯で候補に出る職員」になる
  t.eq(parseImportDates_({ start_date: '', end_date: '' }, []).length, 0,
    '★ 開始日が無い行は勤務日なし（人だけ登録する）');
  t.eq(errorCount_(function (errs) {
    return parseImportDates_({ start_date: '', end_date: '' }, errs);
  }), 0, '★ 開始日が無くてもエラーにしない');
  t.eq(errorCount_(function (errs) {
    return parseImportDates_({ start_date: '', start_time: '13:00' }, errs);
  }), 1, '★ 時刻だけ書いてある行はエラー（開始日の書き忘れを黙って流さない）');
  t.eq(errorCount_(function (errs) {
    return parseImportDates_({ start_date: '', end_date: '2026-08-12' }, errs);
  }), 1, '終了日だけ書いてある行はエラー');
  t.eq(errorCount_(function (errs) {
    return parseImportDates_({ start_date: '2026/08/10', end_date: '' }, errs);
  }), 1, 'スラッシュ区切りはエラー');
  t.eq(errorCount_(function (errs) {
    return parseImportDates_({ start_date: '2026-08-12', end_date: '2026-08-10' }, errs);
  }), 1, '終了日が開始日より前ならエラー');
  t.eq(errorCount_(function (errs) {
    return parseImportDates_({ start_date: '2026-08-10', end_date: '2027-08-10' }, errs);
  }), 1, '★ 日数の上限を超えたらエラー（年の打ち間違い対策）');

  // --- 勤務する時間帯 -------------------------------------------------------
  const defaults = { start: '10:00', end: '17:00', unit: 10 };

  const filled = parseImportTimes_({ start_time: '09:00', end_time: '12:30' }, defaults, []);
  t.eq(filled.start, 540, '開始時刻が分になる');
  t.eq(filled.end, 750, '終了時刻が分になる');

  const blank = parseImportTimes_({ start_time: '', end_time: '' }, defaults, []);
  t.eq(blank.start, 600, '★ 未記入なら _config の既定値（10:00）');
  t.eq(blank.end, 1020, '★ 未記入なら _config の既定値（17:00）');

  const overnight = parseImportTimes_({ start_time: '22:00', end_time: '26:00' }, defaults, []);
  t.eq(overnight.end, 1560, '★ 26:00 は翌2時として通る');

  t.eq(errorCount_(function (errs) {
    return parseImportTimes_({ start_time: '12:00', end_time: '10:00' }, defaults, errs);
  }), 1, '終了が開始より前ならエラー');
  t.eq(errorCount_(function (errs) {
    return parseImportTimes_({ start_time: '10:05', end_time: '17:00' }, defaults, errs);
  }), 1, '刻み幅に乗らない時刻はエラー');
  t.eq(errorCount_(function (errs) {
    return parseImportTimes_({ start_time: '9:00', end_time: '17:00' }, defaults, errs);
  }), 1, 'ゼロ埋めなしはエラー');

  // --- 可用性の一括計算 -----------------------------------------------------
  // 既存の申告が無い人に1件足す
  const fresh = planAvailabilityBatch_([], [
    { personId: 'p1', date: '2026-08-10', start: 600, end: 1020 }
  ]);
  t.eq(fresh.inserts.length, 1, '新しい人には1行足す');
  t.eq(fresh.removeIds.length, 0, '消す行は無い');
  t.eq(fresh.inserts[0].start_time, '10:00', '分から HH:mm に戻る');

  // 既存とまったく同じ申告 … 何も書き換えない（＝再実行しても増えない）
  const same = planAvailabilityBatch_(
    [{ id: 'a1', person_id: 'p1', date: '2026-08-10', start_time: '10:00', end_time: '17:00' }],
    [{ personId: 'p1', date: '2026-08-10', start: 600, end: 1020 }]);
  t.eq(same.inserts.length, 0, '★ 同じ内容を取り込み直しても足さない');
  t.eq(same.removeIds.length, 0, '★ 同じ内容を取り込み直しても消さない');

  // 重なる申告 … 1本にまとまる（可用な時間は減らない）
  const overlap = planAvailabilityBatch_(
    [{ id: 'a1', person_id: 'p1', date: '2026-08-10', start_time: '09:00', end_time: '12:00' }],
    [{ personId: 'p1', date: '2026-08-10', start: 660, end: 780 }]);  // 11:00-13:00
  t.eq(overlap.inserts.length, 1, '重なりは1本にまとまる');
  t.eq(overlap.inserts[0].start_time, '09:00', '★ 早いほうの開始が残る');
  t.eq(overlap.inserts[0].end_time, '13:00', '★ 遅いほうの終了が残る');
  t.eq(overlap.removeIds.length, 1, '吸収された行は消す');
  t.eq(overlap.removeIds[0], 'a1', '消すのは吸収された既存行');

  // 離れた申告 … 別の行として残る
  const apart = planAvailabilityBatch_(
    [{ id: 'a1', person_id: 'p1', date: '2026-08-10', start_time: '09:00', end_time: '12:00' }],
    [{ personId: 'p1', date: '2026-08-10', start: 780, end: 900 }]);  // 13:00-15:00
  t.eq(apart.inserts.length, 1, '離れた区間は足すだけ');
  t.eq(apart.removeIds.length, 0, '★ 既存の申告は消さない（可用な時間は減らない）');

  // 同じ人・同じ日に複数行 … 1つにまとめてから突き合わせる
  const twoRows = planAvailabilityBatch_([], [
    { personId: 'p1', date: '2026-08-10', start: 600, end: 720 },   // 10:00-12:00
    { personId: 'p1', date: '2026-08-10', start: 780, end: 1020 }   // 13:00-17:00
  ]);
  t.eq(twoRows.inserts.length, 2, '★ 1人の複数時間帯は行を分けて書ける');

  // 別の人・別の日は混ざらない
  const separate = planAvailabilityBatch_(
    [{ id: 'a1', person_id: 'p1', date: '2026-08-10', start_time: '10:00', end_time: '17:00' }],
    [{ personId: 'p2', date: '2026-08-10', start: 600, end: 1020 },
     { personId: 'p1', date: '2026-08-11', start: 600, end: 1020 }]);
  t.eq(separate.inserts.length, 2, '人と日ごとに別々に足す');
  t.eq(separate.removeIds.length, 0, '★ 他人の申告に触らない');

  // 時刻が壊れている既存行は触らない
  const broken = planAvailabilityBatch_(
    [{ id: 'a1', person_id: 'p1', date: '2026-08-10', start_time: '', end_time: '' }],
    [{ personId: 'p1', date: '2026-08-10', start: 600, end: 1020 }]);
  t.eq(broken.removeIds.length, 0, '★ 壊れた行は消さない（申告を失わない）');

  // --- 職員の既定勤務時間帯（service_board.js） -----------------------------
  // 時刻そのものは `_config` の値次第なので、**誰に足すか**だけを確かめる。
  // （この関数はシートを読むだけで、書き込みはしない）
  const staff = { id: 's1', type: PERSON_TYPE.STAFF, is_recurring: true, merged_into: '' };
  const volunteer = { id: 'v1', type: PERSON_TYPE.VOLUNTEER, is_recurring: true, merged_into: '' };
  const retired = { id: 's2', type: PERSON_TYPE.STAFF, is_recurring: false, merged_into: '' };
  const merged = { id: 's3', type: PERSON_TYPE.STAFF, is_recurring: true, merged_into: 's1' };
  const day = '2026-08-10';

  t.eq(appendStaffDefaultAvailability_([], [staff], day).length, 1,
    '★ 申告の無い職員には既定を足す');
  t.eq(appendStaffDefaultAvailability_([], [staff], day)[0].virtual, true,
    '足した行には virtual が付く（シートには無い行）');
  t.eq(appendStaffDefaultAvailability_([], [volunteer], day).length, 0,
    'ボランティアには足さない');
  t.eq(appendStaffDefaultAvailability_([], [retired], day).length, 0,
    '★ is_recurring が FALSE の職員には足さない（候補から外す手段）');
  t.eq(appendStaffDefaultAvailability_([], [merged], day).length, 0,
    '名寄せ済みの行には足さない');

  const declared = [{ id: 'a1', person_id: 's1', date: day, start_time: '13:00', end_time: '17:00' }];
  t.eq(appendStaffDefaultAvailability_(declared, [staff], day).length, 1,
    '★ その日に申告がある職員には足さない（申告が優先）');

  const carried = [{
    id: 'a2', person_id: 's1', date: day,
    start_time: '00:00', end_time: '02:00', carried_from: '2026-08-09'
  }];
  t.eq(appendStaffDefaultAvailability_(carried, [staff], day).length, 2,
    '★ 前日から繰り越した行は「その日の申告」と数えない');

  return t.report();
}

/** fn を実行して、積まれたエラーの件数を返す（テスト用） */
function errorCount_(fn) {
  const errors = [];
  fn(errors);
  return errors.length;
}
