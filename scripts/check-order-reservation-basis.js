// "즉시"로 접수한 건이 콜마너에 예약으로 넘어가지 않는지 본다.
//
// 왜 필요한가(사용자 지시 2026-09-14): 콜마너 오더접수 전문은 reservation_time이 실려 있으면
// 그 시각의 예약 건으로 잡는다. 그런데 우리는 즉시여도 reserved_date/reserved_time에 "지금
// 시각"을 채워 저장한다 — 폼의 즉시 라디오가 현재 시각을 넣고 칸을 잠그기 때문이다. 그래서
// 그 칸이 늘 채워져 나갔고, 즉시 배차돼야 할 건이 지금 시각 예약으로 잡혔다.
//
// 고치려면 "이 오더가 즉시였다"를 **등록이 끝난 뒤에도** 알아야 하는데, 예약 기준은 화면에만
// 있고 저장되지 않았다(즉시와 픽업은 둘 다 reserved_date/time만 남긴다). orders.reservation_basis
// 컬럼과, 그 값을 실어 보내는 폼 셋이 이 검사가 지키는 범위다.
//
// 특히 두 가지는 되돌리면 조용히 크게 망가지는 자리라 따로 본다:
//
//   · **INSERT에 새 컬럼을 끼우지 않는다.** lib/orderCreate.js는 42703이 나면 최소 컬럼으로
//     재시도하는 구조라, 마이그레이션 적용 전 DB에서 차종·좌표·정산메모까지 한꺼번에 날아간다
//     (이 저장소가 실제로 겪은 사고다 — memo_driver_brief 주석 참고).
//   · **기준을 모르면(null) 예전처럼 예약으로 보낸다.** 모르는 것을 즉시로 단정하면 반대로
//     예약 건이 지금 배차돼버린다. 덜 위험한 쪽으로 둬야 한다.
//
// 파일을 읽어 확인만 한다 — DB도 콜마너도 안 부르므로 CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const create = read('lib/orderCreate.js');
const callmaner = read('lib/callmaner.js');
const orders = read('routes/orders.js');
const nextForm = read('src/app/orders/new/OrderForm.js');
const miniForm = read('src/app/chat/sessions/IntakeMiniForm.js');
const ejsForm = read('views/orders/form.ejs');

async function checkCallmanerPayload() {
  console.log('\n[콜마너로 나갈 때 — 이 검사의 본론]');
  // 정규식으로 보지 않고 **실제로 전문을 만들어 본다.** 경유지가 없으면 네트워크에 안 닿는다.
  const { buildOrderPayload } = require('../lib/callmaner.js');
  const BASE_ORDER = {
    origin_lat: 37.4, origin_lon: 127.1,
    origin_sido: '경기', origin_sigugun: '성남시', origin_dong: '삼평동',
    origin_address: '판교역로 166', destination_address: '테헤란로 152',
    reserved_date: '2026-09-14', reserved_time: '11:20',
  };
  const payloadFor = (basis) => buildOrderPayload(
    basis === undefined ? { ...BASE_ORDER } : { ...BASE_ORDER, reservation_basis: basis }, null, []
  );


    const immediate = await payloadFor('immediate');
    const pickup = await payloadFor('pickup');
    const unknown = await payloadFor(undefined);

    check('즉시면 예약시각을 싣지 않는다', immediate.reservation_time === undefined,
      `실제 값: ${immediate.reservation_time}`);
    check('픽업 기준은 예전처럼 싣는다', pickup.reservation_time === '20260914112000',
      `실제 값: ${pickup.reservation_time}`);
    // 이 컬럼이 생기기 전 오더와, 기준을 안 보내는 접수 경로(카카오 상담톡 등)가 여기 해당한다.
    // 모르는 것을 즉시로 단정하면 반대로 예약 건이 지금 배차된다.
    check('기준을 모르면(null) 예전처럼 싣는다', unknown.reservation_time === '20260914112000',
      `실제 값: ${unknown.reservation_time}`);
}

async function main() {
  console.log('[컬럼]');
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
  const migration = migrations.find((f) => /reservation_basis/.test(f));
  check('마이그레이션이 있다', !!migration, 'supabase/migrations에 reservation_basis 추가본이 없다');
  check('IF NOT EXISTS로 추가한다', !!migration
    && /ADD COLUMN IF NOT EXISTS reservation_basis/.test(read('supabase/migrations/' + migration)));

    await checkCallmanerPayload();

  console.log('\n[저장 — INSERT를 퇴화시키지 않는다]');
  const insertBlock = create.slice(create.indexOf('INSERT INTO orders'), create.indexOf('RETURNING id'));
  check('INSERT에 끼우지 않는다', !/reservation_basis/.test(insertBlock),
    '선택 컬럼이 하나라도 없으면 INSERT 전체가 최소 컬럼으로 퇴화한다');
  check('삽입 후 따로 쓴다',
    /UPDATE orders SET reservation_basis = \? WHERE id = \?/.test(create));
  check('컬럼이 없어도 접수는 진행한다', /42703[\s\S]{0,120}?예약 기준 저장 실패/.test(create)
    || /예약 기준 저장 실패[\s\S]{0,120}?42703/.test(create)
    || /if \(row\.reservationBasis\)[\s\S]{0,400}?42703/.test(create));
  check('값은 세 가지만 받는다', /RESERVATION_BASES = new Set\(\['immediate', 'pickup', 'delivery'\]\)/.test(create));

  console.log('\n[접수·수정 경로]');
  check('등록 시 요청 본문에서 읽는다', /requestedReservationBasis/.test(orders));
  // 나뉜 건(구간 릴레이)은 각 구간의 출발 시각이 따로 정해진다 — 즉시로 표시하면 그 시각이
  // 콜마너로 안 넘어가 지금 배차 대상이 된다.
  //
  // **part.reservedDate로 가르면 안 된다.** splitIntake는 나뉘지 않은 건도 parts:[{...data}]로
  // 돌려줘서 그 칸이 항상 채워져 있고, 그러면 기준이 늘 null이 되어 이 기능 전체가 죽는다.
  // 처음에 그렇게 짰다가 실제 등록(OID2216)에서 잡았다 — 이 검사는 그때 통과했으므로,
  // 정규식만으로는 못 잡는 종류라는 뜻이기도 하다.
  check('나뉜 건에는 붙이지 않는다',
    /reservationBasis: splitPlan\.parts\.length === 1 \? requestedReservationBasis : null/.test(orders));
  check('part.reservedDate로 가르지 않는다',
    !/reservationBasis: part\.reservedDate/.test(orders),
    '나뉘지 않은 건도 그 칸이 채워져 있어 기준이 늘 null이 된다');
  // 상담관리 카드 폼처럼 이 칸을 안 보내는 화면이 있다 — 안 온 것을 빈 값으로 덮으면 접수 때
  // 확인한 기준이 수정 한 번에 사라진다.
  check('수정 시 안 보낸 값은 건드리지 않는다',
    /req\.body\.reservation_basis !== undefined/.test(orders));

  console.log('\n[폼 셋이 모두 보낸다]');
  check('Next 오더 폼', /params\.set\('reservation_basis', state\.reservation_basis\)/.test(nextForm));
  check('상담관리 카드 폼', /params\.set\('reservation_basis', state\.reservation_basis\)/.test(miniForm));
  check('EJS 폼(기존)', /name="reservation_basis"[^>]*value="immediate"/.test(ejsForm));
  finish();
}

function finish() {
  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('검사 실패:', e.message); process.exit(1); });
