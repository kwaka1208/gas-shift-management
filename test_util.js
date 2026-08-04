/**
 * test_util.gs … util.gs の単体確認
 *
 * util.gs の区間判定は配置表全体の土台であり、ここのバグは画面を静かに壊す。
 * util.gs を触ったら必ず runUtilTests() を実行すること（スクリプトエディタから実行）。
 *
 * ここはテスト専用。本番コードから呼ばない。
 *
 * 本関数は requireOwner_() でガードしていない。副作用もデータ露出も無く、
 * ローカル（Node）からも同じコードを実行して検証できるようにするため。
 * シートやトークンに触れる処理をここに足す場合は、必ずガードを追加すること。
 */
function runUtilTests() {
  const t = newTestRunner_();

  // --- toMinutes_ / toHHMM_ -------------------------------------------------
  t.eq(toMinutes_('00:00'), 0, 'toMinutes_ 00:00');
  t.eq(toMinutes_('09:30'), 570, 'toMinutes_ 09:30');
  t.eq(toMinutes_('23:59'), 1439, 'toMinutes_ 23:59');
  t.eq(toHHMM_(0), '00:00', 'toHHMM_ 0');
  t.eq(toHHMM_(570), '09:30', 'toHHMM_ 570');
  t.eq(toHHMM_(1439), '23:59', 'toHHMM_ 1439');
  t.eq(toHHMM_(toMinutes_('08:10')), '08:10', '往復変換で戻る');
  t.throws(function () { toMinutes_('9:30'); }, 'ゼロ埋めなしは不正');
  t.throws(function () { toMinutes_('24:00'); }, '24:00 は不正');
  t.throws(function () { toMinutes_(''); }, '空文字は不正');

  // --- isValidTimeStr_ / isOnUnit_ -----------------------------------------
  t.ok(isValidTimeStr_('00:00'), '00:00 は妥当');
  t.ok(!isValidTimeStr_('25:00'), '25:00 は不正');
  t.ok(!isValidTimeStr_('10:60'), '10:60 は不正');
  t.ok(isOnUnit_('10:10', 10), '10分刻みに乗る');
  t.ok(!isOnUnit_('10:15', 10), '10:15 は10分刻みに乗らない');
  t.ok(isOnUnit_('10:15', 5), '5分刻みには乗る');

  // --- overlaps_（受け入れ条件の中核） -------------------------------------
  const a1 = toMinutes_('10:00'), a2 = toMinutes_('11:00');
  const b1 = toMinutes_('11:00'), b2 = toMinutes_('12:00');
  t.ok(!overlaps_(a1, a2, b1, b2), '★ 10:00-11:00 と 11:00-12:00 は重ならない');
  t.ok(!overlaps_(b1, b2, a1, a2), '★ 逆順でも重ならない');

  t.ok(overlaps_(600, 660, 630, 690), '一部が重なる');
  t.ok(overlaps_(600, 660, 590, 610), '前側で重なる');
  t.ok(overlaps_(600, 660, 610, 620), '内側に完全に含まれる');
  t.ok(overlaps_(610, 620, 600, 660), '外側に完全に含まれる');
  t.ok(overlaps_(600, 660, 600, 660), '完全一致は重なる');
  t.ok(!overlaps_(600, 660, 700, 760), '離れていれば重ならない');
  t.ok(!overlaps_(600, 600, 600, 660), '長さ0の区間は重ならない');

  // --- covers_ --------------------------------------------------------------
  t.ok(covers_(540, 720, 600, 660), '可用性が枠を完全に含む');
  t.ok(covers_(600, 660, 600, 660), '完全一致も「含む」');
  t.ok(!covers_(610, 660, 600, 660), '開始が遅いと含まない');
  t.ok(!covers_(600, 650, 600, 660), '終了が早いと含まない');
  t.ok(!covers_(700, 760, 600, 660), '離れていれば含まない');

  // --- durationMinutes_ -----------------------------------------------------
  t.eq(durationMinutes_(600, 660), 60, '長さ60分');
  t.eq(durationMinutes_(660, 600), 0, '負にはならない');

  // --- mergeRanges_（可用性の登録で使う） -----------------------------------
  const fmt = function (ranges) {
    return ranges.map(function (r) { return toHHMM_(r.start) + '-' + toHHMM_(r.end); }).join(',');
  };
  const mk = function (pairs) {
    return pairs.map(function (p) { return { start: toMinutes_(p[0]), end: toMinutes_(p[1]) }; });
  };

  t.eq(fmt(mergeRanges_(mk([]))), '', '空は空');
  t.eq(fmt(mergeRanges_(mk([['09:00', '12:00']]))), '09:00-12:00', '1本はそのまま');
  t.eq(fmt(mergeRanges_(mk([['09:00', '12:00'], ['13:00', '15:00']]))),
    '09:00-12:00,13:00-15:00', '離れていれば2本のまま');
  t.eq(fmt(mergeRanges_(mk([['09:00', '12:00'], ['11:00', '13:00']]))),
    '09:00-13:00', '★ 重なりは1本にまとまる');
  t.eq(fmt(mergeRanges_(mk([['09:00', '12:00'], ['12:00', '15:00']]))),
    '09:00-15:00', '★ 隣接も1本にまとまる');
  t.eq(fmt(mergeRanges_(mk([['09:00', '18:00'], ['10:00', '11:00']]))),
    '09:00-18:00', '内側に含まれる区間は吸収される');
  t.eq(fmt(mergeRanges_(mk([['13:00', '15:00'], ['09:00', '12:00']]))),
    '09:00-12:00,13:00-15:00', '順不同でも開始順に並ぶ');
  t.eq(fmt(mergeRanges_(mk([['09:00', '12:00'], ['09:00', '12:00']]))),
    '09:00-12:00', '完全な重複は1本になる');
  t.eq(fmt(mergeRanges_(mk([['09:00', '09:00']]))), '', '長さ0は捨てる');
  t.eq(fmt(mergeRanges_(mk([['12:00', '09:00']]))), '', '逆転した区間は捨てる');
  t.eq(fmt(mergeRanges_(mk([['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00']]))),
    '09:00-12:00', '連続する3本が1本になる');
  const original = mk([['13:00', '15:00'], ['09:00', '12:00']]);
  mergeRanges_(original);
  t.eq(toHHMM_(original[0].start), '13:00', '引数の配列を並べ替えない');

  // --- 日付 -----------------------------------------------------------------
  t.ok(isValidDateStr_('2026-08-04'), '妥当な日付');
  t.ok(isValidDateStr_('2024-02-29'), 'うるう年の2/29は妥当');
  t.ok(!isValidDateStr_('2026-02-29'), '平年の2/29は不正');
  t.ok(!isValidDateStr_('2026-13-01'), '13月は不正');
  t.ok(!isValidDateStr_('2026-8-4'), 'ゼロ埋めなしは不正');
  t.ok(!isValidDateStr_(''), '空文字は不正');

  t.eq(addDays_('2026-08-04', 1), '2026-08-05', '翌日');
  t.eq(addDays_('2026-08-04', -1), '2026-08-03', '前日');
  t.eq(addDays_('2026-08-04', 7), '2026-08-11', '翌週');
  t.eq(addDays_('2026-08-31', 1), '2026-09-01', '月をまたぐ');
  t.eq(addDays_('2026-12-31', 1), '2027-01-01', '年をまたぐ');
  t.eq(addDays_('2024-02-28', 1), '2024-02-29', 'うるう日');
  t.eq(addDays_('2026-03-29', 1), '2026-03-30', '夏時間相当の時期でもずれない');

  t.eq(dayOfWeek_('2026-08-02'), 0, '日曜は0');
  t.eq(dayOfWeek_('2026-08-04'), 2, '火曜は2');
  t.eq(dayOfWeek_('2026-08-08'), 6, '土曜は6');

  t.eq(diffDays_('2026-08-04', '2026-08-11'), 7, '日数の差');
  t.eq(diffDays_('2026-08-11', '2026-08-04'), -7, '逆順は負');
  t.eq(dateRange_('2026-08-04', '2026-08-06').join(','),
    '2026-08-04,2026-08-05,2026-08-06', '両端を含む日付列');
  t.eq(dateRange_('2026-08-04', '2026-08-04').length, 1, '同日は1件');
  t.eq(dateRange_('2026-08-06', '2026-08-04').length, 0, '逆順は空');

  // --- 汎用 -----------------------------------------------------------------
  t.eq(pad2_(3), '03', 'pad2_');
  t.eq(pad2_(12), '12', 'pad2_ 2桁');
  t.eq(trimStr_(null), '', 'trimStr_ null');
  t.eq(trimStr_('  あ  '), 'あ', 'trimStr_ 前後の空白');
  t.eq(escapeHtml_('<b>"x"&\'y\'</b>'),
    '&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;', 'escapeHtml_');
  t.eq(groupBy_([{ k: 'a' }, { k: 'b' }, { k: 'a' }], function (r) { return r.k; }).get('a').length,
    2, 'groupBy_');

  return t.report();
}

/** ごく小さなテストランナー */
function newTestRunner_() {
  const failures = [];
  let passed = 0;

  function record(isOk, label, detail) {
    if (isOk) {
      passed++;
    } else {
      failures.push(label + (detail ? ' … ' + detail : ''));
    }
  }

  return {
    ok: function (value, label) {
      record(value === true, label, '期待: true / 実際: ' + value);
    },
    eq: function (actual, expected, label) {
      record(actual === expected, label, '期待: ' + expected + ' / 実際: ' + actual);
    },
    throws: function (fn, label) {
      let threw = false;
      try { fn(); } catch (e) { threw = true; }
      record(threw, label, '例外が投げられませんでした');
    },
    report: function () {
      const total = passed + failures.length;
      if (failures.length === 0) {
        console.log('全 ' + total + ' 件のテストに合格しました。');
        return { ok: true, passed: passed, failed: 0 };
      }
      console.error(failures.length + ' / ' + total + ' 件が失敗しました:');
      failures.forEach(function (f) { console.error('  × ' + f); });
      return { ok: false, passed: passed, failed: failures.length, failures: failures };
    }
  };
}
