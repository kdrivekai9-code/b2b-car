// 접수 필드 정의가 한 벌인지 검사 — 웹 위젯 폴백(public/js/ai-intake.js REQUIRED_FIELDS)과
// 서버 정의(lib/intakeFields.js DISPATCH_FIELDS)가 어긋나면 실패한다.
//
// 왜 필요한가: 브라우저는 서버 정의를 fetch로 받아 쓰지만, 그 요청이 실패했을 때 쓰는 폴백이
// 파일 안에 남아 있다. 폴백이 낡으면 "네트워크가 느린 사용자만 다른 질문을 받는" 상태가 되는데,
// 그건 재현이 어려워 발견도 늦다. 두 정의가 같은지 여기서 못박는다.
//
//   node scripts/check-intake-fields-shared.js
const fs = require('fs');
const path = require('path');
const { DISPATCH_FIELDS, shortLabelsFor, exampleFor, nextMissingField } = require('../lib/intakeFields');

const BROWSER_FILE = path.join(__dirname, '..', 'public', 'js', 'ai-intake.js');

// 브라우저 파일에서 폴백 배열만 떼어내 평가한다(파일 전체는 DOM에 의존해 실행할 수 없다).
function readBrowserFallback() {
  const src = fs.readFileSync(BROWSER_FILE, 'utf8');
  const start = src.indexOf('var REQUIRED_FIELDS = [');
  if (start === -1) throw new Error('REQUIRED_FIELDS 폴백을 찾지 못했습니다.');
  const end = src.indexOf('];', start);
  const literal = src.slice(src.indexOf('[', start), end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('return ' + literal + ';')();
}

function main() {
  const browser = readBrowserFallback();
  const server = DISPATCH_FIELDS;

  const checks = [];
  checks.push(['필드 개수 일치', browser.length === server.length, `브라우저 ${browser.length} / 서버 ${server.length}`]);
  checks.push(['순서·id 일치',
    browser.map((f) => f.id).join(',') === server.map((f) => f.id).join(','),
    browser.map((f) => f.id).join(',')]);

  server.forEach((sf, i) => {
    const bf = browser[i] || {};
    ['label', 'question', 'type', 'kind'].forEach((key) => {
      const same = (bf[key] || null) === (sf[key] || null);
      if (!same) checks.push([`${sf.id}.${key} 일치`, false, `브라우저="${bf[key] || ''}" 서버="${sf[key] || ''}"`]);
    });
  });

  // 되묻기 라벨과 다음 질문 결정도 함께 확인한다 — 카카오가 쓰는 경로다.
  // 차량번호 라벨은 "차종 / 차량번호"다 — 차종을 함께 청해야 도선료 계산에서 다시 묻지 않는다.
  checks.push(['되묻기 라벨 생성', shortLabelsFor(['origin_address', 'vehicle_number']).join(' + ') === '출발지 주소 + 차종 / 차량번호',
    shortLabelsFor(['origin_address', 'vehicle_number']).join(' + ')]);
  checks.push(['차량번호 예시 제공', exampleFor('vehicle_number') === '그랜저 12가 1234', String(exampleFor('vehicle_number'))]);
  const next = nextMissingField({ reserved_date: '2026-08-20', origin_address: '서울역' });
  checks.push(['다음 미입력 필드 = 출발지 연락처', next && next.id === 'origin_contact', next ? next.id : '없음']);
  const done = nextMissingField({
    reserved_date: 'x', origin_address: 'x', origin_contact: 'x',
    vehicle_number: 'x', destination_address: 'x', destination_contact: 'x',
  });
  checks.push(['전부 채우면 null', done === null, String(done && done.id)]);
  const skipped = nextMissingField({ reserved_date: 'x', origin_address: 'x', origin_contact: 'x' }, { skip: ['vehicle_number'] });
  checks.push(['skip 반영(차량번호 건너뛰기)', skipped && skipped.id === 'destination_address', skipped ? skipped.id : '없음']);

  let ok = true;
  checks.forEach(([label, pass, detail]) => {
    if (!pass) ok = false;
    console.log((pass ? '  OK   ' : '  실패 ') + label + (pass ? '' : ` — ${detail}`));
  });
  console.log(ok ? '\n웹 위젯과 카카오가 같은 필드 정의를 쓴다' : '\n정의가 갈라져 있습니다');
  process.exitCode = ok ? 0 : 1;
}

main();
