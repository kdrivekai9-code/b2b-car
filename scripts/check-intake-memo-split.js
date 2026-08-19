// 접수 요청사항을 기사 몫/업체 몫으로 나누고, 기사 몫을 적요1(100Byte)에 맞게 줄이는지 본다.
//
// 왜 필요한가: 콜마너 적요1은 기사 앱의 `기사메모`로 그대로 노출되고 적요2는 기사에게 보이지
// 않는다. 지금까지는 요청사항을 통째로 적요1에 실어서, 기사가 볼 이유가 없는 배차·정산 요청이
// 100Byte를 잡아먹고 정작 필요한 키 위치·서류 안내를 밀어냈다. 상담 로그 1,412건 재생에서
// 기사 메모의 24.4%가 예산을 넘겼다.
//
// 표본 문장은 핸들모빌리티 상담 로그에서 그대로 가져왔다(개인정보 없는 문장만 옮겼다).
// Gemini를 실제로 부른다 — 나누는 판단 자체가 확인 대상이라 흉내 낼 수 없다. DB는 쓰지 않는다.
//
//   node scripts/check-intake-memo-split.js
require('dotenv').config();
const split = require('../lib/intakeMemoSplit');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
}

const B = split.byteLength;

// [요청사항, 기사 쪽에 남아야 하는 말, 업체 쪽으로 가야 하는 말]
const CASES = [
  [
    '군포광역센터에 도착하셔서 아래연락처로 연락주시면 됩니다. 이외 시간은 경비실에 키 맡겨주시면 됩니다. 그리고 군포에 도착하셔서 차량 이상유무관련하여 꼭 피드백 부탁드립니다.',
    ['경비실'], [],
  ],
  [
    '성능장앞 주차(차키차안, 서류 사무실내 서류함)',
    ['주차'], [],
  ],
  [
    '고객님께서 고령자셔서 도착후 간단한 기능설명이 가능한 기사님으로 배정해주시면 감사하겠습니다.',
    [], ['배정'],
  ],
  [
    '주차장 주차하시고 차키는 경비실에 전달 부탁드립니다. 그리고 이번 건은 매입 탁송으로 정산 구분해주세요.',
    ['경비실'], ['정산'],
  ],
];

async function main() {
  console.log('[자유 문장 분리 — 기사 / 업체]');
  const results = [];
  for (const [memo, wantDriver, wantCompany] of CASES) {
    const r = await split.splitIntakeMemo({ options: {}, memo, vehicles: [{ number: '335모6328' }] });
    results.push({ memo, r });
    const driver = r.driver || '';
    const company = r.company || '';
    const head = memo.slice(0, 34) + (memo.length > 34 ? '…' : '');
    console.log(`\n  · "${head}"`);
    console.log(`      기사: ${driver || '(없음)'}`);
    console.log(`      업체: ${company || '(없음)'}`);
    console.log(`      요약: ${r.driverBrief || '(없음)'}  [${B(r.driverBrief)}B / 예산 ${r.budget}B]`);
    for (const w of wantDriver) check(`기사 쪽에 "${w}"가 남는다`, driver.includes(w), `기사: ${driver}`);
    for (const w of wantCompany) check(`업체 쪽으로 "${w}"가 간다`, company.includes(w), `업체: ${company}`);
    check('요약이 예산 안에 든다', B(r.driverBrief) <= r.budget, `${B(r.driverBrief)}B > ${r.budget}B`);
  }

  console.log('\n[옵션은 규칙으로 나눈다 — 모델을 타지 않는다]');
  {
    const o = { insurance: true, releaseDate: '2026-08-20', documents: '인감, 등록증', refuel: { fuel: '경유', amount: 20000 }, fuelGauge: 3 };
    const r = await split.splitIntakeMemo({ options: o, memo: '' });
    check('주유는 기사 쪽', (r.driver || '').includes('주유'), r.driver);
    check('서류는 기사 쪽', (r.driver || '').includes('인감'), r.driver);
    check('연료 잔량은 기사 쪽', (r.driver || '').includes('연료 3칸'), r.driver);
    // 기사가 할 일이 없는 것들 — 100Byte를 잡아먹으면 안 된다.
    check('책임보험은 업체 쪽', (r.company || '').includes('책임보험'), r.company);
    check('출고일은 업체 쪽', (r.company || '').includes('출고일'), r.company);
    check('책임보험이 기사 메모에 안 들어간다', !(r.driver || '').includes('책임보험'), r.driver);
  }

  console.log('\n[모델이 실패해도 접수를 막지 않는다]');
  {
    // 놓쳐서 기사가 못 보는 손해가, 섞여서 생기는 손해보다 크다 → 전부 기사 쪽으로.
    const r = await split.splitIntakeMemo(
      { options: {}, memo: '경비실에 키 전달 부탁드립니다' },
      { classify: async () => { throw new Error('모의 실패'); } }
    );
    check('요청사항이 사라지지 않는다', (r.driver || '').includes('경비실'), r.driver);
    check('업체 쪽은 비운다', !r.company, r.company);
  }

  console.log('\n[예산 초과 시 자르는 방식]');
  {
    // 조각 단위로 버린다 — 문장 중간에서 끊기면 무슨 말인지 알 수 없다.
    const long = '경비실에 키 전달 / 성능장앞 주차 / 서류는 사무실 서류함 / 도착 후 담당자 연락 / 차량 이상유무 피드백';
    const cut = split.fitToBudget(long, 40);
    check('예산을 넘기지 않는다', B(cut) <= 40, `${B(cut)}B: ${cut}`);
    check('조각 단위로 남는다', !cut.endsWith(' /') && long.startsWith(cut), cut);
    console.log(`      → "${cut}" (${B(cut)}B)`);
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
