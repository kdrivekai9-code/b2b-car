// 오더 수정 이력에 **일어나지 않은 변경**이 기록되지 않는지.
//
// 왜 필요한가(실측 2026-09-07): OID2075의 수정 이력 세 건에 모두
// "업체요청사항: 판매 탁송 신청합니다… → (빈 값)"이 남아 있었다. 정작 DB의 그 칸은 그대로였다.
//
// 원인은 "폼이 안 보낸 칸"과 "폼이 비운 칸"을 같게 다룬 것이다. 오더 수정 화면은 여럿이고
// 상담관리 카드 폼(IntakeMiniForm)은 업체요청사항·기사 챗봇 전달사항을 아예 안 보낸다.
// 그 값이 null로 덮였고, 뒤이어 도는 재분류(splitClientMemo)가 다시 채워서 값 자체는
// 살아났다 — 그래서 눈에 안 띄고 이력에만 거짓이 쌓였다.
//
// 이력을 근거로 다투는 자리에서 거짓 변경은 사소하지 않다. "누가 지웠다"로 읽힌다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

(async () => {
  try {
    console.log('[안 보낸 칸 = 그대로 둔다]');
    // keepIfAbsent는 라우트 안의 지역 함수라 소스에서 규칙만 확인한다. 규칙이 뒤집히면
    // 아래 [남아 있는 거짓 이력] 검사가 곧 다시 걸린다.
    const src = fs.readFileSync(path.join(__dirname, '../routes/orders.js'), 'utf8');
    check('keepIfAbsent가 있다', /function keepIfAbsent\(/.test(src), true);
    // undefined(안 보냄)일 때만 기존 값을 쓴다 — 빈 문자열(비움)은 그대로 비워야 한다.
    check('undefined일 때만 기존 값을 쓴다', /value === undefined \?/.test(src), true);
    // 이력은 실제로 쓸 값과 비교해야 한다. 보낸 값으로 비교하면 안 보낸 칸이 매번 "비웠다"가 된다.
    check('이력이 실제 저장값과 비교한다',
      /describeTextChange\('업체요청사항', order\.memo_billing, nextMemoBilling\)/.test(src), true);
    check('UPDATE도 같은 값을 쓴다', /nextMemoBilling,/.test(src) && /nextMemoDriverChat,/.test(src), true);
    // 수정 라우트의 예전 표현이 남아 있으면 한쪽만 고친 것이다. 등록 라우트의
    // (memo_billing || null)은 그대로 둬야 한다 — 새로 만드는 오더에는 지킬 기존 값이 없다.
    check('수정 라우트에 예전 표현이 남아 있지 않다',
      /role === 'client' \? order\.memo_billing : \(memo_billing \|\| null\)/.test(src), false);

    console.log('[남아 있는 거짓 이력]');
    // 이력에 "→ (빈 값)"이 적혀 있는데 정작 그 칸에 값이 있으면 거짓이다. 앞으로 새로
    // 생기면 여기서 잡힌다.
    const ghosts = await db.all(`
      SELECT h.id, o.oid, h.created_at
        FROM order_status_history h JOIN orders o ON o.id = h.order_id
       WHERE h.note LIKE '%업체요청사항:%→ (빈 값)%'
         AND COALESCE(o.memo_billing, '') <> ''
       ORDER BY h.id`);
    if (ghosts.length) {
      ghosts.forEach((g) => console.log(`       #${g.id} ${g.oid} ${g.created_at}`));
    }
    check('업체요청사항 거짓 변경 이력', ghosts.length, 0);

    const ghostsChat = await db.all(`
      SELECT h.id, o.oid
        FROM order_status_history h JOIN orders o ON o.id = h.order_id
       WHERE h.note LIKE '%기사 챗봇 전달사항:%→ (빈 값)%'
         AND COALESCE(o.memo_driver_chat, '') <> ''`).catch(() => []);
    check('기사 챗봇 전달사항 거짓 변경 이력', ghostsChat.length, 0);
  } finally {
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
