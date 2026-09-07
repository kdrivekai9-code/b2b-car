// 자동화가 남긴 시험 오더를 쓸어낸다.
//
// 왜 필요한가: 검사와 스펙은 모두 끝에 정리 코드를 갖고 있다. 그런데 그것만으로는 안 된다 —
// 프로세스가 중간에 죽으면 정리에 못 닿고, 정리 조건이 틀리면 불려도 아무것도 안 지운다.
// 실제로 둘 다 났다.
//
//   · 2026-08-29~30 동기화 순환 사고 기간에 스크립트들이 중간에 죽어 오더가 남았다.
//   · check-special-toll-settlement는 정리를 `oid LIKE 'MARK%'`로 했는데, createOrder가
//     oid를 'OID####'로 덮어쓰기 때문에(lib/orderCreate.js:165) 한 건도 못 지웠다.
//     성공한 실행에서도 매번 2건씩 남아 22건이 쌓였다.
//
// 그래서 정리를 두 겹으로 둔다. 각 검사가 자기 데이터를 지우는 것이 1겹이고, 이 쓸기가
// 2겹이다. 이걸 테스트 **시작 전에** 돌리는 것이 핵심이다 — 지난번 실행이 죽어서 남긴 것을
// 이번 실행이 걷어낸다. 끝에만 돌리면 죽은 실행은 영원히 자기 쓰레기를 안고 있다.
//
// 무엇을 표식으로 삼나: 주소의 '검사로'. 실제로 없는 도로명이라 실데이터와 겹치지 않는다.
// 운영 DB 전수 확인에서 이 표식에 걸린 25건 전부가 검사 잔해였고, 실제 오더는 모두 실제
// 도로명을 쓴다. 별도 표식 칸(마이그레이션)을 두지 않은 이유가 이것이다 — 이미 구분된다.
//
// 기본은 미리보기다. 지우려면 --apply를 준다. 운영 DB에 붙는 스크립트가 인자 없이 지우면,
// 무엇을 지우는지 보려고 한 번 돌린 사람이 이미 지운 상태가 된다.
require('dotenv').config();
const db = require('../db');

const MARKER = '검사로';
const APPLY = process.argv.includes('--apply');

// 오더를 참조하면서 CASCADE가 아닌 두 곳. 나머지 10곳은 CASCADE나 SET NULL이라 알아서 된다.
// 이 목록은 스키마에서 확인한 것이다(information_schema referential_constraints).
async function detachAndDelete(orderId) {
  await db.run('DELETE FROM order_status_history WHERE order_id = ?', [orderId]);
  // 대화는 지우지 않고 떼어낸다. 시험 오더에 붙은 세션도 시험용이지만, 대화를 지우는 것은
  // 되돌릴 수 없고 이 쓸기의 목적이 아니다.
  await db.run('UPDATE chat_sessions SET order_id = NULL WHERE order_id = ?', [orderId]);
  await db.run('DELETE FROM orders WHERE id = ?', [orderId]);
}

(async () => {
  const rows = await db.all(
    `SELECT id, oid, status, origin_address, destination_address,
            callmaner_conf_slip, callmaner_synced_at, substr(created_at, 1, 16) AS created_at
       FROM orders
      WHERE origin_address LIKE ? OR destination_address LIKE ?
      ORDER BY id`,
    [`%${MARKER}%`, `%${MARKER}%`]
  );

  if (!rows.length) {
    console.log('시험 오더 잔해가 없습니다.');
    process.exit(0);
  }

  // 표식이 붙은 오더가 콜마너에 올라가 있으면 그건 시험 데이터가 아니다 — 실제 배차가
  // 걸렸다는 뜻이다. 그런 건 손대지 않고 사람에게 알린다. 자동 정리가 실데이터를 지우는
  // 경로는 만들지 않는다.
  const dispatched = rows.filter((r) => r.callmaner_conf_slip || r.callmaner_synced_at);
  const targets = rows.filter((r) => !r.callmaner_conf_slip && !r.callmaner_synced_at);

  console.log(`표식('${MARKER}')이 붙은 오더 ${rows.length}건`);
  targets.forEach((r) => console.log(
    `  ${String(r.id).padStart(5)} ${r.oid} ${String(r.status).padEnd(6)} ${r.created_at}`
    + `  ${String(r.origin_address).slice(0, 22)} → ${String(r.destination_address).slice(0, 22)}`));

  if (dispatched.length) {
    console.log(`\n건드리지 않습니다 — 콜마너에 올라간 ${dispatched.length}건:`);
    dispatched.forEach((r) => console.log(`  ${r.id} ${r.oid} (접수번호 ${r.callmaner_conf_slip || '-'})`));
    console.log('시험 주소인데 실제로 배차됐다면 사람이 봐야 합니다.');
  }

  if (!APPLY) {
    console.log(`\n미리보기입니다. 지우려면: node scripts/clean-test-orders.js --apply`);
    process.exit(0);
  }

  let removed = 0;
  const failed = [];
  for (const r of targets) {
    try {
      await detachAndDelete(r.id);
      removed += 1;
    } catch (e) {
      // 한 건이 막혀도 나머지는 지운다. 막힌 건은 이름을 대서 다음에 볼 수 있게 한다.
      failed.push(`${r.id} ${r.oid}: ${e.code || e.message}`);
    }
  }

  console.log(`\n${removed}건 삭제`);
  if (failed.length) {
    console.log(`${failed.length}건 실패:`);
    failed.forEach((f) => console.log(`  ${f}`));
  }
  // 지우다 막힌 건이 있어도 실패로 끝내지 않는다. 이 쓸기는 테스트의 전제조건이지 검사가
  // 아니다 — 여기서 워크플로를 세우면 정작 봐야 할 테스트가 안 돈다.
  process.exit(0);
})().catch((e) => {
  console.error('시험 오더 쓸기 실패:', e.message);
  // 같은 이유로 여기서도 워크플로를 세우지 않는다.
  process.exit(0);
});
