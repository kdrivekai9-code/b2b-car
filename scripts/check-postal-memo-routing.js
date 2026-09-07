// 우편발송(등기) 요청이 어느 칸으로 가는지.
//
// 두 가지를 못 박는다.
//
//   1) 인수증 업로드 링크는 콜마너 적요1에 싣지 않는다. 적요1은 100Byte인데 링크가 38Byte라,
//      정작 기사가 봐야 할 서류·키 위치 안내가 그만큼 밀려 잘려나갔다. 예산 계산은 차량번호만
//      빼고 있어서(briefBudgetBytes) "들어간다"고 판단한 뒤 실제로는 잘렸다.
//      링크는 길이 제한이 없는 기사 챗봇 전달사항(memo_driver_chat)에 남는다.
//
//   2) "출발지 주소로 우편발송"은 **기사가 하는 일**이다. LLM 분류에 맡기면 갈린다 — 실제로
//      OID2075(2026-09-07)에서 업체 전달사항으로 갔다. 그러면 기사는 인수증을 어디로 보내야
//      하는지 모르고 고객은 등기를 못 받는다. 요약에서도 빠지고 있었다.
//
// 둘 다 화면을 봐서는 안 보인다 — 적요1은 콜마너 쪽에서 잘리고, 분류는 매번 달라진다.
require('dotenv').config();
const db = require('../db');
const { splitIntakeMemo, byteLength, MEMO1_MAX_BYTES } = require('../lib/intakeMemoSplit');
const { isPostalRequested, RECEIPT_MEMO_LABEL } = require('../lib/postalReceipt');
// "등기·우편 이야기가 남아 있나"는 mentionsPostal로 본다 — isPostalRequested는 "발송 요청인가"를
// 보는 함수라 동사가 없는 요약 문구('출발지 등기')에는 안 걸린다.
const { mentionsPostal } = require('../lib/intakeMemoSplit');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

// 실제 접수문(2026-09-07). "우편발송판매"처럼 낱말이 붙어 오는 것까지 그대로 둔다 —
// 이 붙음이 분류를 흔든 원인이라, 다듬은 문장으로 검사하면 그 상황을 못 본다.
const MEMO = '※ 회수서류 : 차량 인수증과 성능점검기록부에 고객 서명 받은 후 회수 및 출발지 주소로 우편발송판매 탁송 신청합니다.';
const PLATE = '150두8774';
const MARK = 'zzq등기분류검사';

(async () => {
  const made = [];
  try {
    console.log('[적요1 — 영수증 링크를 싣지 않는다]');
    const fs = require('fs');
    const cmSrc = fs.readFileSync(require('path').join(__dirname, '../lib/callmaner.js'), 'utf8');
    check('memoWithVehicle이 링크를 안 붙인다', /receiptMemoLine/.test(cmSrc), false);

    const cm = require('../lib/callmaner');
    // 차량 표시는 저장할 때 붙는다(2026-09-07) — 전송은 저장값을 그대로 보낸다.
    const storedBrief = `토레스 ${PLATE} / 차량 인수증 회수 / 출발지로 등기발송`;
    const memo1 = cm.memoWithVehicle({
      vehicle_number: PLATE, vehicle_type: '토레스', memo_driver_brief: storedBrief,
      postal_requested: true, receipt_upload_token: 'tok',
    });
    check('적요1에 업로드 문구가 없다', memo1.includes(RECEIPT_MEMO_LABEL), false);
    check('차량 표시가 맨 앞에 남는다', memo1.startsWith(`토레스 ${PLATE}`), true);
    check('저장값을 그대로 보낸다', memo1, storedBrief);

    console.log('[분류 — 우편발송은 기사 쪽]');
    // LLM을 태우지 않고 "업체로 잘못 보낸" 상황을 만들어 규칙이 되돌리는지 본다.
    const wrong = await splitIntakeMemo({ memo: MEMO, options: {} }, {
      plate: PLATE, vehicleType: '토레스',
      classify: async () => ({
        driver: '회수서류 : 인수증',
        company: '판매 탁송 신청합니다. / 출발지 주소로 우편발송',
        driverBrief: '회수서류: 인수증',
      }),
    });
    check('기사 쪽으로 되돌린다', mentionsPostal(wrong.driver), true);
    // 양쪽에 두면 상담원이 "누가 하는 일인지"를 다시 묻는다.
    check('업체 쪽에서 뗀다', mentionsPostal(wrong.company), false);
    check('업체 쪽 나머지는 남는다', wrong.company, '판매 탁송 신청합니다.');
    // 적요1이 기사 앱에 보이는 유일한 칸이라, 요약에서 빠지면 기사는 못 본다.
    check('요약에도 남긴다', mentionsPostal(wrong.driverBrief), true);

    // LLM이 제대로 나눈 경우에도 요약에서 빠지지 않아야 한다(고치기 전에는 빠졌다).
    const right = await splitIntakeMemo({ memo: MEMO, options: {} }, {
      plate: PLATE, vehicleType: '토레스',
      classify: async () => ({
        driver: '회수서류 : 차량 인수증과 성능점검기록부에 고객 서명 받은 후 회수 및 출발지 주소로 우편발송',
        company: '판매 탁송 신청합니다.',
        driverBrief: '회수서류: 인수증, 성능점검기록부 서명',
      }),
    });
    check('제대로 나뉜 경우에도 요약에 남는다', mentionsPostal(right.driverBrief), true);
    // 요약에는 차량 표시가 이미 붙어 있고 그 값이 그대로 적요1이 된다 — 100Byte 기준으로 본다.
    // budget은 차량 표시를 뺀 나머지 자리라 직접 비교하면 안 된다.
    check('요약이 100Byte 안', byteLength(right.driverBrief) <= MEMO1_MAX_BYTES, true);
    check('요약 맨 앞이 차량 표시', right.driverBrief.startsWith(`토레스 ${PLATE}`), true);

    // 우편발송 요청이 아닌 건에는 아무것도 덧붙이지 않는다.
    const plain = await splitIntakeMemo({ memo: '차키는 경비실에 맡겨주세요', options: {} }, {
      plate: PLATE, vehicleType: '토레스',
      classify: async () => ({ driver: '차키는 경비실에 맡겨주세요', company: '', driverBrief: '차키 경비실' }),
    });
    check('등기 요청이 아니면 안 붙인다', /우편|등기/.test(String(plain.driver)), false);

    console.log('[접수 — 링크가 기사 챗봇 전달사항에 남는다]');
    const donor = await db.get(
      `SELECT branch_id, requester_group_id, created_by FROM orders
        WHERE branch_id IS NOT NULL ORDER BY id DESC LIMIT 1`);
    if (!donor) { console.log('  건너뜀 — 오더가 없다'); }
    else {
      const { createOrder } = require('../lib/orderCreate');
      const created = await createOrder({
        branchId: donor.branch_id, requesterGroupId: donor.requester_group_id,
        originAddress: '서울 강서구 양천로53길 30', originContact: '010-1111-2222',
        destinationAddress: '경기 성남시 분당구 판교역로 160', destinationContact: '010-3333-4444',
        reservedDate: '2019-12-24', reservedTime: '10:00',
        vehicleNumber: PLATE, fareAmount: 0,
        memoCustomer: '회수서류 인수증 받아 출발지 주소로 등기발송 부탁드립니다',
        createdBy: donor.created_by,
      }).catch((e) => { console.log('  건너뜀 — 오더 생성 실패:', e.message); return null; });
      if (created) {
        made.push(created.orderId);
        const o = await db.get('SELECT postal_requested, receipt_upload_token, memo_driver_chat FROM orders WHERE id = ?', [created.orderId]);
        check('등기 요청으로 표시된다', !!o.postal_requested, true);
        check('업로드 토큰이 생긴다', !!o.receipt_upload_token, true);
        // 이 칸이 기사 화면·상담원 화면에 그대로 보인다. 링크가 여기 없으면 적요1에서도
        // 뺐으니 기사는 인수증을 올릴 길이 없다.
        check('기사 챗봇 전달사항에 링크가 있다', String(o.memo_driver_chat || '').includes(RECEIPT_MEMO_LABEL), true);
        check('토큰이 그 링크에 들어간다', String(o.memo_driver_chat || '').includes(o.receipt_upload_token), true);
      }
    }
  } finally {
    for (const id of made) {
      await db.run('DELETE FROM order_extra_charges WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM order_legs WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM order_waypoints WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM order_status_history WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ?', [id]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
