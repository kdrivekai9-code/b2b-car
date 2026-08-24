// 붙여 쓴 주소도 좌표를 찾는지, 그리고 못 찾으면 접수를 막는지 확인한다.
//
// 실사용 대화:
//   고객: 내일오후3시에 사당역탐앤탐스에서 강남역5번출구로 탁송예약
//   AI  : · 도착 강남역5번출구 (주소 확인 필요)   ← 좌표를 못 찾았다
//
// 카카오 로컬 검색은 띄어쓰기 한 칸에 결과가 갈린다(실측): "강남역5번출구"는 못 찾고
// "강남역 5번출구"는 찾는다. 고객은 붙여 쓰는 쪽이 흔하다.
//
// 못 찾으면 왜 위험한가: 콜마너 접수 payload는 도착지 좌표·행정구역이 없으면 도착지 블록(arr)을
// 통째로 빼고 보낸다(lib/callmaner.js buildOrderPayload). 즉 "도착지 없는 오더"가 등록되고
// 기사는 어디로 가야 할지 알 수 없다. 주소 후보 되묻기도 후보가 2건 이상일 때만 도는 구조라
// (needsDisambiguation) 0건인 경우는 아무 관문 없이 통과했다.
//
// 변형 생성은 순수 함수라 네트워크 없이 보고, 실제 좌표 조회는 카카오 로컬 API를 부른다
// (KAKAO_REST_API_KEY 없으면 그 구간만 건너뛴다). DB는 쓰지 않는다.
//
//   node scripts/check-address-spacing-geocode.js
require('dotenv').config();
const { buildQueryVariants, geocodeAddress, isCallmanerReady } = require('../lib/geocode');
const { FAILURE_MESSAGES } = require('../lib/kakaoIntakeParser');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
}

console.log('[변형 생성 — 붙여 쓴 자리를 띄운 후보가 들어간다]');
{
  const v1 = buildQueryVariants('강남역5번출구');
  check('"강남역 5번출구"를 후보로 넣는다', v1.includes('강남역 5번출구'), JSON.stringify(v1));
  // 출구를 뗀 것도 마지막 수단으로 넣는다 — 출구가 달라도 좌표 차이는 백 미터 안이다.
  check('"강남역"도 마지막 후보로 넣는다', v1.includes('강남역'), JSON.stringify(v1));

  const v2 = buildQueryVariants('사당역탐앤탐스');
  check('"사당역 탐앤탐스"를 후보로 넣는다', v2.includes('사당역 탐앤탐스'), JSON.stringify(v2));

  // 역으로 시작하는 지명을 쪼개면 엉뚱한 곳을 찾는다.
  const v3 = buildQueryVariants('역삼동 123-4');
  check('"역삼동"은 쪼개지 않는다', !v3.some((q) => /^역\s/.test(q)), JSON.stringify(v3));

  // 기존 주소 형태는 후보 구성이 달라지지 않아야 한다(회귀).
  const v4 = buildQueryVariants('서울 양천로 53길 30, 서서울모터리움');
  check('도로명 주소는 첫 후보가 원문 그대로', v4[0] === '서울 양천로 53길 30, 서서울모터리움', JSON.stringify(v4));
}

console.log('\n[실패 안내 문구]');
check('도착지 실패 사유에 문구가 있다', !!FAILURE_MESSAGES.destination_geocode_failed, JSON.stringify(Object.keys(FAILURE_MESSAGES)));
check('고객이 다시 알려주도록 청한다', /다시 알려주세요/.test(FAILURE_MESSAGES.destination_geocode_failed || ''));

(async () => {
  if (!process.env.KAKAO_REST_API_KEY) {
    console.log('\n[실제 좌표 조회] 건너뜀 — KAKAO_REST_API_KEY 없음');
  } else {
    console.log('\n[실제 좌표 조회]');
    const cases = [
      ['강남역5번출구', true],
      ['사당역탐앤탐스', true],
      ['강남역 5번출구', true],
      ['서울 양천로 53길 30, 서서울모터리움', true],
      ['경기도 군포시 농심로59번길 4', true],
    ];
    for (const [q, want] of cases) {
      const r = await geocodeAddress(q, new Map()).catch(() => null);
      const ok = !!r === want && (!r || isCallmanerReady(r));
      if (!ok) failures += 1;
      console.log(`  ${ok ? 'OK  ' : '실패'} ${q.padEnd(28)} → ${r ? `${r.sido} ${r.sigugun} (${r.matchedQuery})` : '(못 찾음)'}`);
    }
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
