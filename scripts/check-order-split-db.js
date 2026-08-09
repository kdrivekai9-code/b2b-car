// 접수 분리가 실제로 오더 여러 건이 되는지 확인한다 — 규칙(check-order-split.js) 다음 단계다.
//
// 여기서 보는 것은 배관이다: 나뉜 건마다 오더가 생기는지, 각 건의 출발·도착·날짜가 맞는지,
// 같은 요청에서 나온 건들이 묶여 있는지. 틀리면 고객이 요청한 것과 다른 오더가 등록된다.
//
// 콜마너로는 내보내지 않는다 — callmaner_enabled가 꺼진 지사를 쓴다(실오더가 나가면 사고다).
// 만든 오더는 끝에서 지운다.
//
//   node scripts/check-order-split-db.js
require('dotenv').config();
const db = require('../db');
const { createOrdersFromIntake } = require('../lib/kakaoIntakeService');

const MARK = 'e2e-order-split-check';

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

// 폼 파서가 만드는 모양 그대로 — createOrdersFromIntake가 이 형태를 받는다.
function makeParsed(overrides = {}) {
  return {
    matched: true,
    complete: true,
    missing: [],
    origin: { address: '서울 강서구 양천로53길 30', contact: '010-1111-2222' },
    destination: { address: '부산 해운대구 우동 1413', contact: '010-3333-4444' },
    when: { immediate: false, date: '2026-08-20', time: '14:00', dateRolled: false, raw: '2026-08-20 14:00' },
    vehicles: [{ plate: '12가3456', type: '토레스' }],
    waypoints: [],
    roundTrip: false,
    returnWhen: { date: null, time: null },
    options: {},
    memo: MARK,
    raw: MARK,
    ...overrides,
  };
}

async function main() {
  const createdOrderIds = [];

  try {
    // 콜마너로 나가지 않는 지사를 쓴다 — 검증 때문에 실오더가 접수되면 안 된다.
    const branch = await db.get('SELECT id FROM branches WHERE callmaner_enabled = false ORDER BY id LIMIT 1');
    if (!branch) {
      console.log('콜마너 미사용 지사가 없어 확인을 건너뜁니다 — 실오더가 나갈 수 있어 진행하지 않습니다.');
      return;
    }
    const user = await db.get("SELECT id FROM users WHERE status = 'active' ORDER BY id LIMIT 1");
    const account = {
      user_id: user.id, branch_id: branch.id, requester_group_id: null,
      payment_method_id: null, auto_register: true,
    };
    const session = { id: null };

    const run = async (parsed) => {
      const result = await createOrdersFromIntake({ session, account, parsed });
      (result.created || []).forEach((c) => createdOrderIds.push(c.orderId));
      return result;
    };

    console.log('[나누지 않는 접수]');
    {
      const result = await run(makeParsed());
      check('한 건만 만든다', result.created.length, 1);
      check('묶음 표시 없음', result.split, null);
      const row = await db.get('SELECT split_group_id, split_seq FROM orders WHERE id = ?', [result.created[0].orderId]);
      // 대부분의 오더가 여기 해당한다 — 묶음 값이 들어가면 목록·상세가 괜히 "1/1건"을 보여준다.
      check('묶음 컬럼은 비어 있다', [row.split_group_id, row.split_seq], [null, null]);
    }

    console.log('\n[경유지 날짜가 다르면 2건]');
    {
      const result = await run(makeParsed({
        waypoints: [{ address: '대전 중구 중앙로 101', contact: '010-5555-6666', reservedDate: '2026-08-22', reservedTime: '10:00' }],
      }));
      check('2건을 만든다', result.created.length, 2);
      check('분리 이유를 돌려준다', result.split && result.split.reason, 'waypoint');

      const rows = await db.all(
        'SELECT id, origin_address, destination_address, reserved_date, reserved_time, split_group_id, split_seq, split_total FROM orders WHERE id = ANY(?) ORDER BY split_seq',
        [result.created.map((c) => c.orderId)]
      );
      check('1건: 출발지 → 경유지', [rows[0].origin_address, rows[0].destination_address], ['서울 강서구 양천로53길 30', '대전 중구 중앙로 101']);
      check('2건: 경유지 → 도착지', [rows[1].origin_address, rows[1].destination_address], ['대전 중구 중앙로 101', '부산 해운대구 우동 1413']);
      check('1건 일시', [rows[0].reserved_date, rows[0].reserved_time], ['2026-08-20', '14:00']);
      // 경유지에 적힌 날짜로 접수돼야 한다 — 여기가 틀리면 기사가 엉뚱한 날 간다.
      check('2건 일시', [rows[1].reserved_date, rows[1].reserved_time], ['2026-08-22', '10:00']);

      check('같은 묶음', rows[0].split_group_id === rows[1].split_group_id, true);
      check('묶음이 비어 있지 않다', !!rows[0].split_group_id, true);
      check('순번', [rows[0].split_seq, rows[1].split_seq], [1, 2]);
      check('총건수', [rows[0].split_total, rows[1].split_total], [2, 2]);
      check('확인 문구가 이유를 밝힌다', result.message.includes('경유지 분리'), true);
    }

    console.log('\n[왕복 복귀일이 다르면 2건]');
    {
      const result = await run(makeParsed({
        roundTrip: true,
        returnWhen: { date: '2026-08-21', time: '09:00' },
      }));
      check('2건을 만든다', result.created.length, 2);
      const rows = await db.all(
        'SELECT origin_address, destination_address, reserved_date FROM orders WHERE id = ANY(?) ORDER BY split_seq',
        [result.created.map((c) => c.orderId)]
      );
      // 오는 편이 뒤집히지 않으면 기사가 반대로 간다.
      check('가는 편', [rows[0].origin_address, rows[0].destination_address], ['서울 강서구 양천로53길 30', '부산 해운대구 우동 1413']);
      check('오는 편', [rows[1].origin_address, rows[1].destination_address], ['부산 해운대구 우동 1413', '서울 강서구 양천로53길 30']);
      check('복귀 날짜', rows[1].reserved_date, '2026-08-21');
    }

    console.log('\n[시각을 모르면 등록하지 않는다]');
    {
      // 날짜만 갈렸을 뿐 시각은 아무도 말해주지 않은 경우 — 임의로 채우면 잘못된 시각이 접수된다.
      const result = await createOrdersFromIntake({
        session, account,
        parsed: makeParsed({ waypoints: [{ address: '대전 중구 중앙로 101', reservedDate: '2026-08-22' }] }),
      });
      check('등록하지 않는다', result.ok, false);
      check('이유를 밝힌다', result.reason, 'split_schedule_missing');
      check('어느 건을 물어야 하는지 알려준다', result.detail.missingSchedule, [2]);
    }

    console.log('\n[같은 날 경유는 여전히 자동 등록 대상이 아니다]');
    {
      // 나뉘지 않으면 경유지가 한 건에 남는데, 접수 서비스가 경유지를 저장하지 못한다.
      const result = await createOrdersFromIntake({
        session, account,
        parsed: makeParsed({ waypoints: [{ address: '대전 중구 중앙로 101' }] }),
      });
      check('등록하지 않는다', result.ok, false);
      check('이유를 밝힌다', result.reason, 'waypoint_unsupported');
    }
  } finally {
    if (createdOrderIds.length) {
      await db.run(`DELETE FROM order_legs WHERE order_id = ANY(?)`, [createdOrderIds]).catch(() => {});
      await db.run(`DELETE FROM order_status_history WHERE order_id = ANY(?)`, [createdOrderIds]).catch(() => {});
      await db.run(`DELETE FROM orders WHERE id = ANY(?) AND memo_customer LIKE ?`, [createdOrderIds, `%${MARK}%`]).catch(() => {});
    }
    const left = await db.all('SELECT id FROM orders WHERE memo_customer LIKE ?', [`%${MARK}%`]).catch(() => []);
    console.log(`\n정리: 만든 오더 ${createdOrderIds.length}건, 남은 행 ${left.length}`);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error('\n확인 중 오류:', e.message);
  process.exit(1);
});
