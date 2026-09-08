// 접수 폼으로 넣은 건도 통보를 받는지, 그리고 엉뚱한 사람에게 가지 않는지 본다.
//
// 무엇을 고쳤나(실측 2026-09-08): 통보 대상 판정이 첫 줄에서 이랬다.
//
//     if (!order || !order.chat_session_id) return null;
//
// 오더가 상담 세션에 붙어 있어야 통보한다는 뜻이다. 그런데 오더 49건 중 세션이 붙은 것은
// 10건뿐이었다(카카오 8, 웹챗 2). 나머지 39건 — 법인 고객이 화면 접수 폼으로 넣은 대부분 —
// 은 배차·운행시작·완료·취소 무엇도 안내받지 못했다. 실제로 나간 통보 9건이 전부 카카오였다.
//
// 고칠 때 지켜야 하는 것 셋:
//
//   1. orders.chat_session_id를 덮어쓰지 않는다. 그 칸은 "이 오더가 어느 대화에서 접수됐나"
//      라는 뜻이고 다른 코드가 그렇게 읽는다(routes/kakaoConsult.js가 그 값으로 사진 요청의
//      대상 오더를 찾고, routes/chat.js가 세션의 지사를 유도한다). 통보 통로를 거기 적으면
//      두 뜻이 섞인다.
//   2. 카카오로 보내지 않는다. 상담톡 발신은 그 사람의 카카오 사용자 키가 필요한데 접수 폼에는
//      없다. 법인에 걸린 채널 매핑으로 보내면 **다른 사람에게 갈 수 있다** — 안 보내는 것보다
//      나쁘다.
//   3. 직원이 대신 넣은 건을 직원 상담창에 꽂지 않는다. 고객 계정이 접수한 것만 통보한다.
//
// DB에 붙지만 **쓰지는 않는다** — 읽기와 판정만 본다. 그래서 CI 목록에는 넣지 않는다.
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'db'));
const { loadNotifiableOrder } = require(path.join(ROOT, 'lib/kakaoOrderNotify'));

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

(async () => {
  console.log('[코드가 지켜야 할 것]');
  const src = fs.readFileSync(path.join(ROOT, 'lib/kakaoOrderNotify.js'), 'utf8');
  // 세션이 없다고 곧바로 물러나면 접수 폼 건은 영원히 통보를 못 받는다.
  check('세션이 없어도 대상을 찾아본다', /notifyTargetForRequester\(order\)/.test(src));
  check('고객 계정만 통보한다', /role = 'client'/.test(src));
  check('기존 상담창을 재사용한다', /channel = 'web'\s*\n\s*ORDER BY id DESC LIMIT 1/.test(src));
  // 이 두 줄이 들어가면 접수 출처가 덮인다.
  check('orders.chat_session_id를 덮어쓰지 않는다',
    !/UPDATE orders SET chat_session_id/.test(src));
  // 카카오 발신은 같은 세션에서 온 건에만. 접수 폼 건을 카카오로 보내면 남에게 갈 수 있다.
  check('접수 폼 건을 카카오로 보내지 않는다',
    /return \{ order, session, channel: 'web' \};\s*\n\}/.test(src));

  console.log('\n[실제 오더로 판정]');
  // 고객 계정이 접수 폼으로 넣은 건 — 세션이 없다.
  const formOrder = await db.get(
    `SELECT o.id, o.oid FROM orders o JOIN users u ON u.id = o.created_by
      WHERE o.chat_session_id IS NULL AND u.role = 'client' ORDER BY o.id DESC LIMIT 1`, []);
  if (!formOrder) {
    check('고객이 접수 폼으로 넣은 건이 있다 (건너뜀 — 표본 없음)', true);
  } else {
    const before = await db.get("SELECT COUNT(*)::int AS n FROM chat_sessions WHERE channel = 'web'", []);
    const target = await loadNotifiableOrder(formOrder.id);
    const after = await db.get("SELECT COUNT(*)::int AS n FROM chat_sessions WHERE channel = 'web'", []);
    check(`${formOrder.oid}이 통보 대상이 된다`, !!target, '대상 아님');
    check('웹으로 보낸다', !!target && target.channel === 'web', target ? target.channel : '-');
    // 통보마다 새 창이 생기면 고객은 어디를 봐야 할지 모르고 세션 목록이 껍데기로 찬다.
    check('상담창을 새로 만들지 않는다(이미 있으면)', after.n === before.n, `${before.n} → ${after.n}`);
  }

  // 직원이 대신 넣은 건.
  const staffOrder = await db.get(
    `SELECT o.id, o.oid FROM orders o JOIN users u ON u.id = o.created_by
      WHERE o.chat_session_id IS NULL AND u.role <> 'client' ORDER BY o.id DESC LIMIT 1`, []);
  if (!staffOrder) {
    check('직원이 넣은 건이 있다 (건너뜀 — 표본 없음)', true);
  } else {
    const t = await loadNotifiableOrder(staffOrder.id);
    check(`직원 접수 ${staffOrder.oid}은 통보 대상이 아니다`, t === null, t ? `channel=${t.channel}` : '-');
  }

  // 카카오에서 온 건은 예전대로 카카오로 가야 한다 — 이 수정이 기존 경로를 바꾸면 안 된다.
  const kakaoOrder = await db.get(
    `SELECT o.id, o.oid FROM orders o JOIN chat_sessions s ON s.id = o.chat_session_id
      WHERE s.channel = 'kakao' ORDER BY o.id DESC LIMIT 1`, []);
  if (!kakaoOrder) {
    check('카카오 접수 건이 있다 (건너뜀 — 표본 없음)', true);
  } else {
    const t = await loadNotifiableOrder(kakaoOrder.id);
    check(`카카오 접수 ${kakaoOrder.oid}은 그대로 카카오로 간다`,
      !!t && t.channel === 'kakao', t ? t.channel : '대상 아님');
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('검사 실패:', e.message);
  process.exit(1);
});
