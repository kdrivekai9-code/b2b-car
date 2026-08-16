// 법인별 설정의 "법인 → 지사" 폴백 검사.
//
// 왜 필요한가: 요금표·고객통보를 지사별에서 법인별로 옮기면서, 법인에 값이 없으면 지사 값을
// 그대로 쓰기로 했다(정책). 이 폴백이 깨지면 증상이 조용하다 — 요금이 "요금표 없음"으로
// 떨어져 수동 입력으로 되돌아가거나, 통보가 코드 기본 문구로 나간다. 화면상으로는 아무 오류도
// 안 보이므로 여기서 못박는다.
//
// 프로덕션 DB를 쓴다. 검사용 지사·법인을 새로 만들고 끝나면 반드시 지운다 — 기존 행은 건드리지
// 않는다(실사용 설정을 지웠던 사고가 있었다).
require('dotenv').config();
const db = require('../db');
const branchPolicy = require('../lib/branchPolicy');
const kakaoOrderNotify = require('../lib/kakaoOrderNotify');

const MARK = 'e2e-group-fallback';
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

(async () => {
  const branch = await db.get(
    `INSERT INTO branches (name, code, status) VALUES (?, ?, 'active') RETURNING id`,
    [`${MARK}-지사`, `${MARK}-${Date.now().toString().slice(-6)}`]
  );
  const branchId = Number(branch.id);
  const group = await db.get(
    `INSERT INTO groups_tbl (name, branch_id) VALUES (?, ?) RETURNING id`, [`${MARK}-법인`, branchId]
  );
  const groupId = Number(group.id);

  try {
    // ---- 지사에만 요금표가 있는 상태 ----
    await db.run(
      `INSERT INTO fare_extra_settings (branch_id, fare_table_enabled, fare_visible_to_client)
       VALUES (?, 1, 1)`, [branchId]
    );
    await db.run(
      `INSERT INTO fare_rules (branch_id, tier_seq, base_distance_km, base_fare, surcharge_unit_km, surcharge_fare, round_unit, round_method)
       VALUES (?, 1, 10, 50000, 1, 1000, 1000, 'round')`, [branchId]
    );

    console.log('[탁송 요금 — 법인 표가 없으면 지사 표]');
    let fare = await branchPolicy.calculateFare(branchId, 20, { groupId });
    check('지사 표로 계산된다', fare.fareSource, 'branch');
    check('금액은 지사 구간표 기준', fare.fare, 60000); // 50000 + (20-10)*1000

    console.log('[탁송 요금 — 법인 표가 있으면 법인 표]');
    await db.run(
      `INSERT INTO group_fare_extra_settings (group_id, fare_table_enabled, fare_visible_to_client)
       VALUES (?, 1, 1)`, [groupId]
    );
    await db.run(
      `INSERT INTO group_fare_rules (group_id, tier_seq, base_distance_km, base_fare, surcharge_unit_km, surcharge_fare, round_unit, round_method)
       VALUES (?, 1, 10, 30000, 1, 500, 1000, 'round')`, [groupId]
    );
    fare = await branchPolicy.calculateFare(branchId, 20, { groupId });
    check('법인 표로 계산된다', fare.fareSource, 'group');
    check('금액은 법인 구간표 기준', fare.fare, 35000); // 30000 + (20-10)*500

    console.log('[탁송 요금 — 법인 표를 꺼두면 다시 지사 표]');
    // "이 요금표 사용"을 끈 것은 표가 없는 것과 같게 다뤄야 한다. 안 그러면 빈/꺼진 법인 표가
    // 지사 표를 가려 요금이 통째로 사라진다.
    await db.run('UPDATE group_fare_extra_settings SET fare_table_enabled = 0 WHERE group_id = ?', [groupId]);
    fare = await branchPolicy.calculateFare(branchId, 20, { groupId });
    check('지사 표로 되돌아간다', fare.fareSource, 'branch');
    await db.run('UPDATE group_fare_extra_settings SET fare_table_enabled = 1 WHERE group_id = ?', [groupId]);

    console.log('[탁송 요금 — 법인을 모르면(groupId 없음) 지사 표]');
    fare = await branchPolicy.calculateFare(branchId, 20, {});
    check('지사 표로 계산된다', fare.fareSource, 'branch');

    // ---- 일일기사(시간 구간) ----
    console.log('[일일기사 요금 — 법인 → 지사]');
    await db.run(
      `INSERT INTO premium_fare_rules (branch_id, tier_seq, base_hours, fare_amount, extra_per_hour)
       VALUES (?, 1, 4, 100000, 20000)`, [branchId]
    );
    let dd = await branchPolicy.calculatePremiumFare(branchId, 6, { groupId });
    check('법인 표가 없으면 지사 표', dd.fareSource, 'branch');
    check('금액은 지사 기준', dd.fare, 140000); // 100000 + 2h*20000

    await db.run(
      `INSERT INTO group_daily_driver_fare_rules (group_id, tier_seq, base_hours, fare_amount, extra_per_hour)
       VALUES (?, 1, 4, 80000, 10000)`, [groupId]
    );
    dd = await branchPolicy.calculatePremiumFare(branchId, 6, { groupId });
    check('법인 표가 있으면 법인 표', dd.fareSource, 'group');
    check('금액은 법인 기준', dd.fare, 100000); // 80000 + 2h*10000

    // ---- 고객 통보 ----
    console.log('[고객 통보 — 법인 → 지사 → 코드 기본값]');
    const base = await kakaoOrderNotify.loadEventSetting(branchId, 'completed', groupId);
    check('둘 다 없으면 코드 기본 문구', base.template, kakaoOrderNotify.DEFAULT_EVENT_SETTINGS.completed.template);

    await db.run(
      `INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template)
       VALUES (?, 'completed', true, 3, ?)`, [branchId, '지사 문구입니다']
    );
    let setting = await kakaoOrderNotify.loadEventSetting(branchId, 'completed', groupId);
    check('법인 설정이 없으면 지사 문구', setting.template, '지사 문구입니다');
    check('지연도 지사 값', setting.delayMinutes, 3);

    await db.run(
      `INSERT INTO group_customer_notifications (group_id, event_type, enabled, delay_minutes, message_template)
       VALUES (?, 'completed', true, 7, ?)`, [groupId, '법인 문구입니다']
    );
    setting = await kakaoOrderNotify.loadEventSetting(branchId, 'completed', groupId);
    check('법인 설정이 있으면 법인 문구', setting.template, '법인 문구입니다');
    check('지연도 법인 값', setting.delayMinutes, 7);

    // 법인이 한 사건만 저장했으면 나머지 사건은 여전히 지사를 따라야 한다 — 사건 단위로 갈린다.
    const other = await kakaoOrderNotify.loadEventSetting(branchId, 'started', groupId);
    check('저장 안 한 사건은 지사/기본값 그대로', other.template, kakaoOrderNotify.DEFAULT_EVENT_SETTINGS.started.template);
  } finally {
    // 만든 것만 지운다. group_*는 FK가 on delete cascade라 법인/지사를 지우면 함께 사라진다.
    await db.run('DELETE FROM group_customer_notifications WHERE group_id = ?', [groupId]).catch(() => {});
    await db.run('DELETE FROM group_daily_driver_fare_rules WHERE group_id = ?', [groupId]).catch(() => {});
    await db.run('DELETE FROM group_fare_rules WHERE group_id = ?', [groupId]).catch(() => {});
    await db.run('DELETE FROM group_fare_extra_settings WHERE group_id = ?', [groupId]).catch(() => {});
    await db.run('DELETE FROM branch_customer_notifications WHERE branch_id = ?', [branchId]).catch(() => {});
    await db.run('DELETE FROM premium_fare_rules WHERE branch_id = ?', [branchId]).catch(() => {});
    await db.run('DELETE FROM fare_rules WHERE branch_id = ?', [branchId]).catch(() => {});
    await db.run('DELETE FROM fare_extra_settings WHERE branch_id = ?', [branchId]).catch(() => {});
    await db.run('DELETE FROM groups_tbl WHERE id = ?', [groupId]).catch(() => {});
    await db.run('DELETE FROM branches WHERE id = ?', [branchId]).catch(() => {});
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('검사 실패:', e);
  process.exit(1);
});
