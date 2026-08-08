// 주소 후보 선택 판정이 웹 위젯과 서버에서 같은지 대조한다.
//
// 브라우저(public/js/ai-intake-flow.js matchCandidateChoice)는 그대로 두고 서버에 같은 규칙을
// 뒀다 — 브라우저 코드는 화면·SDK에 묶여 있어 서버에서 require할 수 없기 때문이다. 두 벌이
// 존재하는 한 규칙이 갈라질 수 있으므로, 같은 입력을 양쪽에 넣어 결과가 같은지 여기서 못박는다.
//
// 실제 주소검색(카카오 API)도 함께 확인한다 — 후보가 여럿일 때 물어보는 판정이 의도대로
// 동작하는지는 실제 응답으로만 알 수 있다.
//
//   node scripts/check-address-candidates.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const server = require('../lib/addressCandidates');

const FLOW_FILE = path.join(__dirname, '..', 'public', 'js', 'ai-intake-flow.js');

// 브라우저 파일에서 matchCandidateChoice만 떼어내 실행한다(파일 전체는 window에 의존).
function loadBrowserMatcher() {
  const src = fs.readFileSync(FLOW_FILE, 'utf8');
  const start = src.indexOf('function matchCandidateChoice(');
  if (start === -1) throw new Error('브라우저 matchCandidateChoice를 찾지 못했습니다.');
  const end = src.indexOf('\n  }', start) + 4;
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}; return matchCandidateChoice;`)();
}

const CANDIDATES = [
  { label: '사당역 신분당선 (서울 동작구 남부순환로 2089)' },
  { label: '사당역 4호선 (서울 서초구 방배동 1-1)' },
];

const CASES = ['1', '1번', '1.', '첫번째', '2', '2번', '둘째', '두번째', '사당역 4호선', '방배동', '없는말', '', '3'];

function main() {
  const browserMatch = loadBrowserMatcher();
  let ok = true;

  console.log('[선택 판정 대조]');
  CASES.forEach((input) => {
    const b = browserMatch(input, CANDIDATES);
    const s = server.matchCandidateChoice(input, CANDIDATES);
    const same = (b ? b.label : null) === (s ? s.label : null);
    // 3번은 서버에만 있는 확장이다(후보 3개까지 지원) — 후보가 2개인 이 케이스에서는 양쪽 모두
    // null이어야 하므로 그대로 비교한다.
    if (!same) ok = false;
    console.log(`  ${same ? 'OK  ' : '불일치'} "${input}" → 브라우저=${b ? b.label.slice(0, 12) : 'null'} / 서버=${s ? s.label.slice(0, 12) : 'null'}`);
  });

  console.log('\n[물어볼지 판정]');
  const disambigCases = [
    ['사당역', CANDIDATES, true, '짧은 지명 + 후보 2개 → 물어본다'],
    ['서울 동작구 남부순환로 2089', CANDIDATES, false, '전체 주소면 첫 결과를 쓴다'],
    ['사당역', [CANDIDATES[0]], false, '후보가 하나면 물어볼 게 없다'],
    ['사당역', [], false, '후보가 없으면 기존 경로로'],
  ];
  disambigCases.forEach(([q, list, expected, why]) => {
    const got = server.needsDisambiguation(q, list);
    if (got !== expected) ok = false;
    console.log(`  ${got === expected ? 'OK  ' : '실패'} ${why} (${got})`);
  });

  console.log('\n[후보 목록 문구]');
  console.log(server.buildCandidateListText('출발지', CANDIDATES).split('\n').map((l) => '  ' + l).join('\n'));

  return ok;
}

async function liveSearch() {
  if (!process.env.KAKAO_REST_API_KEY) {
    console.log('\n[실제 검색] KAKAO_REST_API_KEY 없음 — 건너뜀');
    return true;
  }
  console.log('\n[실제 주소검색]');
  const samples = ['사당역', '판교역', '경기도 군포시 농심로59번길 4'];
  let ok = true;
  for (const q of samples) {
    const list = await server.searchAddressCandidates(q);
    const ask = server.needsDisambiguation(q, list);
    console.log(`  "${q}" → 후보 ${list.length}개, 물어봄=${ask}`);
    list.forEach((c) => console.log(`      · ${c.label} [${c.sido || '-'} ${c.sigugun || '-'} ${c.dong || '-'}]`));
    // 후보가 나왔으면 행정구역이 채워져 있어야 콜마너 접수에 쓸 수 있다.
    if (list.length && !list[0].sido) { ok = false; console.log('      실패: 행정구역이 비어 있음'); }
  }
  return ok;
}

(async () => {
  const a = main();
  const b = await liveSearch();
  console.log(a && b ? '\n웹 위젯과 서버가 같은 선택 규칙을 쓴다' : '\n불일치가 있습니다');
  process.exitCode = a && b ? 0 : 1;
})().finally(() => setTimeout(() => process.exit(), 200));
