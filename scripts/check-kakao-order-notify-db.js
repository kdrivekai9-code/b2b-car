// 카카오 능동 통보의 DB 흐름을 실제 테이블로 확인한다 — 감지 → 1분 지연 → 발송 직전 재확인 →
// 중복 방지까지.
//
// 마이그레이션(20260809010000_add_kakao_order_notifications.sql)을 적용한 뒤에 돌아간다.
//
// 실제 발신은 하지 않는다. sendDue에 가짜 발신 함수를 주입한다 — 확인하려다 진짜 고객에게
// 메시지가 나가면 그게 바로 이 기능이 막으려던 사고다.
//
// 이 DB는 프로덕션과 같으므로, 만든 행만 정확히 지목해 지운다. "마지막 행"류의 정리는 하지 않는다.
//
//   node scripts/check-kakao-order-notify-db.js
require('dotenv').config();
const db = require('../db');
const notify = require('../lib/kakaoOrderNotify');

const MARK = 'e2e-kakao-notify-check';

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

async function main() {
  const created = { sessionId: null, orderId: null };

  try {
    // 카카오 세션처럼 보이는 세션을 만든다 — 발신 키가 있어야 통보 대상이 된다.
    const session = await db.get(
      `INSERT INTO chat_sessions (user_id, status, channel, kakao_service_key, kakao_user_key)
       VALUES (NULL, 'bot', 'kakao', ?, ?) RETURNING id`,
      [`${MARK}-service`, `${MARK}-user`]
    );
    created.sessionId = session.id;

    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    const order = await db.get(
      `INSERT INTO orders (oid, branch_id, status, chat_session_id, callmaner_driver_name, callmaner_driver_phone, memo_customer)
       VALUES (?, ?, '접수', ?, '홍길동', '010-1111-2222', ?) RETURNING id`,
      [`${MARK}-oid`, branch.id, created.sessionId, MARK]
    );
    created.orderId = order.id;

    // 커서를 지금 지점으로 맞춰두고 시작한다 — 과거 이력을 훑지 않게.
    const maxHistory = await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM order_status_history');
    await db.run('UPDATE kakao_notification_cursor SET last_history_id = ? WHERE id = 1', [maxHistory.id]);

    const sentTexts = [];
    const fakeSend = async (_session, text) => { sentTexts.push(text); return { ok: true }; };

    console.log('[배차 통보]');
    await db.run('UPDATE orders SET status = ? WHERE id = ?', ['기사배정', created.orderId]);
    await db.run(
      `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, '접수', '기사배정', ?)`,
      [created.orderId, MARK]
    );

    const first = await notify.runKakaoOrderNotifications({ send: fakeSend });
    check('전이를 잡아 통보를 예약한다', first.collected.scheduled, 1);
    check('1분이 지나기 전에는 보내지 않는다', first.delivered.sent, 0);

    // 예약 시각을 앞당겨 1분이 지난 상황을 만든다.
    await db.run(
      `UPDATE kakao_order_notifications SET scheduled_at = now() - interval '1 second' WHERE order_id = ? AND status = 'pending'`,
      [created.orderId]
    );
    const second = await notify.sendDue({ send: fakeSend });
    check('1분이 지나면 보낸다', second.sent, 1);
    check('문구에 기사 정보가 들어간다', sentTexts[0].includes('홍길동') && sentTexts[0].includes('배차가 완료'), true);

    const third = await notify.sendDue({ send: fakeSend });
    check('같은 통보가 두 번 나가지 않는다', third.sent, 0);

    console.log('\n[1분 사이에 취소되면 보내지 않는다]');
    // 같은 오더에 다른 기사로 재배차 — dedupe_key가 달라 새 통보가 예약돼야 한다.
    await db.run(
      `UPDATE orders SET status = '기사배정', callmaner_driver_name = '김철수', callmaner_driver_phone = '010-3333-4444' WHERE id = ?`,
      [created.orderId]
    );
    await db.run(
      `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, '접수', '기사배정', ?)`,
      [created.orderId, MARK]
    );
    const fourth = await notify.collectFromHistory();
    check('기사가 바뀌면 새 통보를 예약한다', fourth.scheduled, 1);

    // 보내기 전에 배차가 풀린 상황.
    await db.run('UPDATE orders SET status = ? WHERE id = ?', ['접수', created.orderId]);
    await db.run(
      `UPDATE kakao_order_notifications SET scheduled_at = now() - interval '1 second' WHERE order_id = ? AND status = 'pending'`,
      [created.orderId]
    );
    const fifth = await notify.sendDue({ send: fakeSend });
    check('발송 직전 상태가 바뀌었으면 보내지 않는다', fifth.sent, 0);
    check('보내지 않은 건은 skipped로 남는다', fifth.skipped, 1);

    console.log('\n[배차 취소 안내]');
    await db.run(
      `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, NULL, '기사배정', '접수', ?)`,
      [created.orderId, MARK]
    );
    const sixth = await notify.runKakaoOrderNotifications({ send: fakeSend });
    check('배차 취소는 미루지 않고 곧바로 보낸다', sixth.delivered.sent, 1);
    check(
      '문구는 다시 배차 중임을 알린다',
      sentTexts[sentTexts.length - 1].includes('다른 기사님께 배차 진행중'),
      true
    );

    console.log('\n[상담 이력]');
    const logged = await db.all(
      `SELECT message FROM chat_messages WHERE session_id = ? ORDER BY id ASC`,
      [created.sessionId]
    );
    check('고객에게 나간 말이 상담 이력에도 남는다', logged.length, sentTexts.length);
  } finally {
    // 만든 것만 지운다.
    if (created.orderId) {
      await db.run('DELETE FROM kakao_order_notifications WHERE order_id = ?', [created.orderId]);
      await db.run('DELETE FROM order_status_history WHERE order_id = ? AND note = ?', [created.orderId, MARK]);
      await db.run('DELETE FROM orders WHERE id = ? AND memo_customer = ?', [created.orderId, MARK]);
    }
    if (created.sessionId) {
      await db.run('DELETE FROM chat_messages WHERE session_id = ?', [created.sessionId]);
      await db.run('DELETE FROM chat_sessions WHERE id = ? AND kakao_user_key = ?', [created.sessionId, `${MARK}-user`]);
    }
    console.log(`\n정리: order=${created.orderId ?? '-'}, session=${created.sessionId ?? '-'}`);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error('\n확인 중 오류:', e.message);
  process.exit(1);
});
