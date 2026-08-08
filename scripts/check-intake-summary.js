// 접수 요약 문구가 웹 화면의 폴백과 서버에서 같은지 대조한다.
//
// 웹 접수 화면은 이제 서버(lib/intakeSummary.js)에 요약을 요청한다 — 카카오 상담톡의 등록 후
// 통보, 상담원 초안과 같은 모듈이다. 다만 네트워크가 느리거나 실패해도 접수가 멈추면 안 되므로
// 브라우저 안에 같은 문구를 만드는 폴백(buildSummaryTextLocal)이 남아 있다. 폴백이 서버와
// 다른 문구를 내면 "가끔 요약이 달라지는" 형태로 드러나고, 그건 재현도 어렵다. 여기서 못박는다.
//
// 브라우저 함수는 DOM(val, document)에 의존해서 그대로 실행할 수 없다 — 필요한 것만 흉내 낸다.
//
//   node scripts/check-intake-summary.js
const fs = require('fs');
const path = require('path');
const { buildSummaryText } = require('../lib/intakeSummary');

const BROWSER_FILE = path.join(__dirname, '..', 'public', 'js', 'ai-intake.js');

const VALUES = {
  reserved_date: '2026-08-20',
  reserved_time: '14:00',
  origin_address: '경기 성남시 분당구 판교역로 160',
  origin_detail_address: '3층',
  origin_contact: '010-1111-2222',
  vehicle_number: '12가3456',
  vehicle_type: '토레스',
  destination_address: '서울 동작구 남부순환로 2089',
  destination_detail_address: '지하 1층',
  destination_contact: '010-3333-4444',
  memo_customer: '도착 후 연락주세요',
  memo_billing: '정산 담당자 확인',
};

const WAYPOINTS = [
  { address: '경기 성남시 중원구 성남대로 1', contact: '010-5555-6666', vehicleNumber: '34나5678' },
];

// 브라우저 폴백(buildSummaryTextLocal)만 떼어내 DOM 없이 실행한다.
function runBrowserSummary() {
  const src = fs.readFileSync(BROWSER_FILE, 'utf8');
  const start = src.indexOf('function buildSummaryTextLocal() {');
  if (start === -1) throw new Error('브라우저 buildSummaryTextLocal을 찾지 못했습니다.');
  const end = src.indexOf('\n  }', start) + 4;
  const body = src.slice(start, end);

  const fakeDocument = {
    querySelectorAll() {
      return WAYPOINTS.map((w, i) => ({ dataset: { slot: `wp${i}` } }));
    },
  };
  const val = (id) => {
    const wp = id.match(/^wp(\d+)_(.+)$/);
    if (wp) {
      const w = WAYPOINTS[Number(wp[1])] || {};
      if (wp[2] === 'address') return w.address || '';
      if (wp[2] === 'contact') return w.contact || '';
      if (wp[2] === 'vehicle_number') return w.vehicleNumber || '';
      return '';
    }
    return VALUES[id] || '';
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('val', 'document', `${body}; return buildSummaryTextLocal();`);
  return fn(val, fakeDocument);
}

function runServerSummary() {
  return buildSummaryText({
    reservedDate: VALUES.reserved_date,
    reservedTime: VALUES.reserved_time,
    origin: { address: VALUES.origin_address, detail: VALUES.origin_detail_address, contact: VALUES.origin_contact },
    destination: { address: VALUES.destination_address, detail: VALUES.destination_detail_address, contact: VALUES.destination_contact },
    waypoints: WAYPOINTS,
    vehicles: [{ type: VALUES.vehicle_type, number: VALUES.vehicle_number }],
    memoCustomer: VALUES.memo_customer,
    memoBilling: VALUES.memo_billing,
  }, { bullet: '▪' });
}

function main() {
  const browser = runBrowserSummary();
  const server = runServerSummary();

  console.log('[브라우저]');
  console.log(browser.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('\n[서버]');
  console.log(server.split('\n').map((l) => '  ' + l).join('\n'));

  // 줄 단위로 비교한다 — 순서까지 같아야 고객이 두 채널에서 같은 순서로 읽는다.
  const b = browser.split('\n');
  const s = server.split('\n');
  let ok = true;
  const max = Math.max(b.length, s.length);
  console.log('\n[대조]');
  for (let i = 0; i < max; i += 1) {
    const same = b[i] === s[i];
    if (!same) ok = false;
    if (!same) console.log(`  불일치 줄 ${i + 1}\n    브라우저: ${b[i] || '(없음)'}\n    서버    : ${s[i] || '(없음)'}`);
  }
  if (ok) console.log('  모든 줄 일치');
  console.log(ok ? '\n브라우저 폴백과 서버가 같은 요약을 만든다' : '\n요약이 갈라져 있습니다');
  process.exitCode = ok ? 0 : 1;
}

main();
