// 웹챗 능동 통보의 DB 흐름을 실제 테이블로 확인한다 — 운행시작 사건, 웹 세션 전달,
// 접수 중 미루기, 지연 중 상태변화까지.
//
// 마이그레이션 20260814010000_add_drive_started_photos_odometer.sql을 적용한 뒤에 돌아간다
// (없으면 미루기 관련 검사만 자동으로 건너뛴다).
//
// 실제 발신은 하지 않는다 — 카카오 발신 함수와 브로드캐스트를 모두 주입해 가로챈다. 확인하려다
// 진짜 고객에게 메시지가 나가면 그게 바로 이 기능이 막으려던 사고다.
//
// 이 DB는 프로덕션과 같으므로, 만든 행만 정확히 지목해 지운다.
//
// 드물게 실패할 수 있다: 프로덕션 크론(매분)이 같은 큐를 훑다가 이 스크립트가 만든 통보를
// 먼저 집어갈 수 있다. 그 경우 가짜 세션 키로 발신이 실패해 'failed'로 남고, 여기서는
// "안 보냈다"로 보인다. 고객에게 나가지는 않는다(세션 키가 가짜라 실제 발신 대상이 없다).
// 실패하면 한 번 더 돌려보고, 반복해서 같은 항목이 실패할 때만 실제 결함으로 본다.
//
//   node scripts/check-order-notify-web-db.js
require('dotenv').config();
const db = require('../db');
const notify = require('../lib/kakaoOrderNotify');
const snapshot = require('./notifySnapshot');

const MARK = 'e2e-web-notify-check';

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

async function hasColumn(table, column) {
  const row = await db.get(
    'SELECT 1 AS ok FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
    [table, column]
  );
  return !!row;
}

// 상태를 바꾸고 이력까지 남긴다(폴링/관리자 변경이 하는 것과 같은 형태).
async function transition(orderId, from, to) {
  await db.run('UPDATE orders SET status = ? WHERE id = ?', [to, orderId]);
  await db.run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note)
     VALUES (?, NULL, ?, ?, ?)`,
    [orderId, from, to, MARK]
  );
}

async function main() {
  const created = { sessionId: null, orderId: null };
  // 프로덕션 상태를 건드리는 값들 — finally에서 반드시 되돌린다. try 안에서 원복하면 그 앞의
  // 검사가 하나만 실패해도 지사 설정과 커서가 바뀐 채로 남는다.
  let savedSettings = [];
  let savedBranchId = null;
  let savedCursor = null;
  const supportsDefer = await hasColumn('kakao_order_notifications', 'defer_count');
  if (!supportsDefer) console.log('(defer_count 컬럼이 없어 미루기 검사는 건너뜁니다 — 마이그레이션 20260814010000 필요)\n');

  try {
    // 웹 세션 — 카카오 발신 키가 없다. 예전에는 이것 때문에 통보 대상에서 아예 빠졌다.
    const session = await db.get(
      `INSERT INTO chat_sessions (user_id, status, channel) VALUES (NULL, 'bot', 'web') RETURNING id`
    );
    created.sessionId = session.id;

    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    const order = await db.get(
      `INSERT INTO orders (oid, branch_id, status, chat_session_id, order_type,
                           callmaner_driver_name, callmaner_driver_phone, memo_customer,
                           origin_address, origin_address_detail, destination_address, destination_address_detail,
                           reserved_date, reserved_time)
       VALUES (?, ?, '접수', ?, 'dispatch', '홍길동', '050-7111-2222', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        `${MARK}-oid`, branch.id, created.sessionId, MARK,
        '서울 강서구 양천로53길 30', '3층', '경기 성남시 분당구 판교역로 160', 'B동 로비',
        '2026-08-20', '14:00',
      ]
    );
    created.orderId = order.id;

    // 지사 설정이 이 사건을 껐을 수 있으니 검사 동안은 확실히 켜둔다(원래 값은 finally에서 복원한다).
    savedSettings = await snapshot.snapshotSettings(branch.id);
    savedBranchId = branch.id;
    for (const t of ['dispatched', 'started', 'completed']) {
      await db.run(
        `INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template)
         VALUES (?, ?, true, 0, ?)
         ON CONFLICT (branch_id, event_type) DO UPDATE SET enabled = true, delay_minutes = 0`,
        [branch.id, t, notify.DEFAULT_EVENT_SETTINGS[t].template]
      ).catch(() => {});
    }

    // 커서는 프로덕션 상태다 — 손대기 전 값을 떠두고 finally에서 되돌린다
    // (이유는 scripts/notifySnapshot.js 주석).
    savedCursor = await snapshot.advanceCursorToNow();

    const kakaoSent = [];
    const broadcasts = [];
    // 이 큐는 전역이다 — 범위를 안 좁히면 마침 대기 중이던 진짜 고객 통보까지 가짜 발신으로
    // 삼켜 "보냈다"고 기록해버린다(실제로 겪은 사고). 이 스크립트가 만든 오더만 처리한다.
    const baseOpts = {
      send: async (_s, text) => { kakaoSent.push(text); return { ok: true }; },
      broadcast: async (sessionId, message) => { broadcasts.push({ sessionId, message }); },
    };
    const opts = () => ({
      ...baseOpts,
      onlyOrderIds: [created.orderId, created.orderId2, created.orderId3, created.orderId4, created.orderId5].filter(Boolean),
    });
    const countMessages = async () => {
      const row = await db.get(
        `SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND sender = 'system'`,
        [created.sessionId]
      );
      return Number(row.n);
    };

    console.log('[웹 세션에 배차 통보]');
    await transition(created.orderId, '접수', '기사배정');
    let out = await notify.runKakaoOrderNotifications(opts());
    check('통보 1건 발송', out.delivered.sent, 1);
    check('웹 채널로 집계', out.delivered.byChannel.web, 1);
    check('카카오 발신은 0회(웹 세션이므로)', kakaoSent.length, 0);
    check('상담 이력 1건', await countMessages(), 1);
    check('브로드캐스트 1회', broadcasts.length, 1);
    const firstText = broadcasts[0] && broadcasts[0].message && broadcasts[0].message.message;
    check('문구에 오더종류가 들어간다', /요청하신 탁송건이 기사님 배차되었습니다/.test(firstText || ''), true);
    check('상세주소가 한 번만 나온다', (String(firstText || '').match(/3층/g) || []).length, 1);
    check('기사 안심번호가 들어간다', /050-7111-2222/.test(firstText || ''), true);

    console.log('[운행시작 통보]');
    await transition(created.orderId, '기사배정', '운행시작');
    out = await notify.runKakaoOrderNotifications(opts());
    check('운행시작 1건 발송', out.delivered.sent, 1);
    const startedText = broadcasts[broadcasts.length - 1].message.message;
    check('운행시작 문구', /요청하신 탁송건이 운행시작 되었습니다/.test(startedText), true);

    console.log('[콜마너 흔들림 — 운행시작 → 기사배정]');
    // 콜마너는 운행 중에도 status='배차'를 계속 준다. 이 전이로 배차 통보가 다시 나가면
    // 고객에게 같은 안내가 매분 반복된다.
    const before = await countMessages();
    await transition(created.orderId, '운행시작', '기사배정');
    out = await notify.runKakaoOrderNotifications(opts());
    check('배차 통보가 다시 나가지 않는다', out.delivered.sent, 0);
    check('상담 이력이 늘지 않는다', await countMessages(), before);

    console.log('[접수 대화 중이면 미룬다]');
    if (supportsDefer) {
      // 같은 오더·같은 기사면 중복 방지(order_id, event_type, dedupe_key)가 두 번째 예약을
      // 막는다 — 그게 정상 동작이라, 미루기를 보려면 아직 통보를 안 보낸 새 오더가 필요하다.
      //
      // 사건은 운행완료를 쓴다. 배차·운행시작은 늦으면 가치가 없어 아예 미루지 않는 사건이라
      // (NEVER_DEFER_EVENTS) 미루기를 관측할 수 없다.
      const busyOrder = await db.get(
        `INSERT INTO orders (oid, branch_id, status, chat_session_id, order_type, memo_customer,
                             origin_address, destination_address, reserved_date, reserved_time)
         VALUES (?, ?, '기사배정', ?, 'dispatch', ?, ?, ?, ?, ?) RETURNING id`,
        [`${MARK}-oid3`, branch.id, created.sessionId, MARK, '대전', '대구', '2026-08-22', '10:00']
      );
      created.orderId3 = busyOrder.id;
      await transition(created.orderId3, '기사배정', '완료');
      await db.run(
        `UPDATE chat_sessions SET draft_json = '{"phase":"collecting","pendingField":"origin_address"}' WHERE id = ?`,
        [created.sessionId]
      );
      // 표시만으로는 부족하다 — 봇이 질문을 던져놓고 답을 기다리는 중이어야 실제 대화 중이다.
      // (표시는 고객이 답하지 않으면 영원히 남아서, 그것만 보면 몇 시간 전 대화가 통보를 계속
      // 미룬다. OID1237이 그 사례였다.)
      await db.run(
        `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'bot', ?)`,
        [created.sessionId, `${MARK} 출발지가 어디인가요?`]
      );
      const busyBefore = await countMessages();
      out = await notify.runKakaoOrderNotifications(opts());
      check('발송하지 않고 미룬다', out.delivered.deferred, 1);
      check('상담 이력이 늘지 않는다', await countMessages(), busyBefore);
      const queued = await db.get(
        `SELECT status, defer_count FROM kakao_order_notifications
         WHERE order_id = ? AND event_type = 'completed' ORDER BY id DESC LIMIT 1`,
        [created.orderId3]
      );
      check('큐에 pending으로 남아 있다', queued.status, 'pending');
      check('미룬 횟수가 1', Number(queued.defer_count), 1);

      // 고객이 답하면(마지막 메시지가 고객) 더는 기다리는 상태가 아니라 발송된다.
      // scheduled_at을 앞으로 당겨 2분을 기다리지 않는다.
      await db.run(
        `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'user', ?)`,
        [created.sessionId, `${MARK} 대전이요`]
      );
      await db.run(
        `UPDATE kakao_order_notifications SET scheduled_at = now() - interval '1 minute'
         WHERE order_id = ? AND event_type = 'completed' AND status = 'pending'`,
        [created.orderId3]
      );
      out = await notify.runKakaoOrderNotifications(opts());
      check('고객이 답하면 발송된다', out.delivered.sent, 1);
    } else {
      console.log('  (건너뜀)');
    }

    console.log('[사진첨부가 켜져 있으면 첨부가 실제로 붙는다]');
    if (supportsDefer) {
      // loadNotifyPhotos가 예외를 던져도 catch가 빈 배열로 삼켜 "첨부 없이 발송"이 되고,
      // 통보 행은 성공으로 남아 조용히 묻힌다(실제로 MAX_NOTIFY_PHOTOS 상수를 지웠다가
      // 버튼 없이 나간 적이 있다). 첨부가 실제로 실렸는지 눈으로 확인한다.
      const photoOrder = await db.get(
        `INSERT INTO orders (oid, branch_id, status, chat_session_id, order_type, memo_customer,
                             origin_address, destination_address, reserved_date, reserved_time)
         VALUES (?, ?, '기사배정', ?, 'dispatch', ?, ?, ?, ?, ?) RETURNING id`,
        [`${MARK}-oid5`, branch.id, created.sessionId, MARK, '울산', '창원', '2026-08-24', '13:00']
      );
      created.orderId5 = photoOrder.id;
      for (let seq = 1; seq <= 3; seq += 1) {
        await db.run(
          `INSERT INTO order_callmaner_photos (order_id, phase, seq, url) VALUES (?, 'start', ?, ?)`,
          [created.orderId5, seq, `https://example.invalid/${MARK}_1_${seq}.jpg`]
        ).catch(() => {});
      }
      await db.run(
        `INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template, attach_photos)
         VALUES (?, 'started', true, 0, ?, true)
         ON CONFLICT (branch_id, event_type) DO UPDATE SET attach_photos = true, enabled = true, delay_minutes = 0`,
        [branch.id, notify.DEFAULT_EVENT_SETTINGS.started.template]
      ).catch(() => {});
      await db.run('UPDATE branch_photo_settings SET client_can_view = 1 WHERE branch_id = ?', [branch.id]).catch(() => {});

      await transition(created.orderId5, '기사배정', '운행시작');
      out = await notify.runKakaoOrderNotifications(opts());
      check('첨부 켜진 통보가 발송된다', out.delivered.sent, 1);
      const withAtt = await db.get(
        `SELECT attachments_json FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
        [created.sessionId]
      );
      let parsed = null;
      try { parsed = JSON.parse(withAtt.attachments_json || 'null'); } catch (e) { parsed = null; }
      check('첨부가 실제로 실렸다', Array.isArray(parsed) && parsed.length, 3);
      check('첨부에 캡션이 붙는다', !!(parsed && parsed[0] && /운행전/.test(parsed[0].caption)), true);
      // 웹은 썸네일이 붙으므로 본문에 링크를 덧붙이지 않는다(카카오만 덧붙인다).
      const webBody = await db.get(
        `SELECT message FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1`,
        [created.sessionId]
      );
      check('웹 본문에는 링크 줄을 덧붙이지 않는다', /사진 보기: http/.test(webBody.message || ''), false);
    } else {
      console.log('  (건너뜀)');
    }

    console.log('[배차·운행시작은 대화 중이어도 미루지 않는다]');
    if (supportsDefer) {
      // 늦게 도착한 "기사님 배차되었습니다"는 안내로서 가치가 없다 — 봇이 답을 기다리는
      // 중이어도 그대로 보낸다(사용자 확정).
      const urgentOrder = await db.get(
        `INSERT INTO orders (oid, branch_id, status, chat_session_id, order_type, memo_customer,
                             origin_address, destination_address, reserved_date, reserved_time)
         VALUES (?, ?, '접수', ?, 'dispatch', ?, ?, ?, ?, ?) RETURNING id`,
        [`${MARK}-oid4`, branch.id, created.sessionId, MARK, '광주', '전주', '2026-08-23', '11:00']
      );
      created.orderId4 = urgentOrder.id;
      // 봇이 질문을 던져놓고 답을 기다리는 상태를 만든다(위 운행완료는 이 상태에서 미뤄졌다).
      await db.run(
        `UPDATE chat_sessions SET draft_json = '{"phase":"collecting","pendingField":"origin_address"}' WHERE id = ?`,
        [created.sessionId]
      );
      await db.run(
        `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'bot', ?)`,
        [created.sessionId, `${MARK} 도착지가 어디인가요?`]
      );
      await transition(created.orderId4, '접수', '기사배정');
      await notify.collectFromHistory();
      await db.run(
        `UPDATE kakao_order_notifications SET scheduled_at = now() - interval '1 minute'
         WHERE order_id = ? AND status = 'pending'`,
        [created.orderId4]
      );
      const urgentBefore = await countMessages();
      out = await notify.sendDue(opts());
      check('대화 중이어도 배차 통보는 미루지 않는다', out.deferred, 0);
      check('그대로 발송된다', out.sent, 1);
      check('상담 이력이 늘었다', (await countMessages()) > urgentBefore, true);
      await db.run('UPDATE chat_sessions SET draft_json = NULL WHERE id = ?', [created.sessionId]);
    } else {
      console.log('  (건너뜀)');
    }

    console.log('[지연 중 상태가 운행시작으로 바뀌어도 배차 통보는 나간다]');
    // 배차 통보는 2분 뒤에 나가는데 그 사이 기사가 출발할 수 있다. 여기서 막히면 고객은
    // 배차 사실을 영영 못 듣는다.
    const order2 = await db.get(
      `INSERT INTO orders (oid, branch_id, status, chat_session_id, order_type, memo_customer,
                           origin_address, destination_address, reserved_date, reserved_time)
       VALUES (?, ?, '접수', ?, 'dispatch', ?, ?, ?, ?, ?) RETURNING id`,
      [`${MARK}-oid2`, branch.id, created.sessionId, MARK, '서울', '부산', '2026-08-21', '09:00']
    );
    created.orderId2 = order2.id;
    await transition(created.orderId2, '접수', '기사배정');
    // 감지만 하고(예약 생성) 발송 전에 상태를 바꾼다.
    await notify.collectFromHistory();
    await db.run('UPDATE orders SET status = ? WHERE id = ?', ['운행시작', created.orderId2]);
    await db.run(
      `UPDATE kakao_order_notifications SET scheduled_at = now() - interval '1 minute'
       WHERE order_id = ? AND status = 'pending'`,
      [created.orderId2]
    );
    const beforeDelayed = await countMessages();
    out = await notify.sendDue(opts());
    check('배차 통보가 그대로 발송된다', out.sent >= 1, true);
    check('상담 이력이 늘었다', (await countMessages()) > beforeDelayed, true);

  } finally {
    // 지사 설정 원복 — 손대기 전 상태로 통째로 되돌린다(attach_photos까지).
    await snapshot.restoreSettings(savedBranchId, savedSettings);
    // 만든 행만 지운다.
    for (const id of [created.orderId, created.orderId2, created.orderId3, created.orderId4, created.orderId5].filter(Boolean)) {
      await db.run('DELETE FROM order_callmaner_photos WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM kakao_order_notifications WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM order_status_history WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ?', [id]).catch(() => {});
    }
    if (created.sessionId) {
      await db.run('DELETE FROM chat_messages WHERE session_id = ?', [created.sessionId]).catch(() => {});
      await db.run('DELETE FROM chat_sessions WHERE id = ?', [created.sessionId]).catch(() => {});
    }
    // 커서 복원은 검사용 이력 행을 지운 뒤에 한다.
    await snapshot.restoreCursor(savedCursor);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
