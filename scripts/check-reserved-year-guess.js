// 연도를 안 적은 예약일을 우리가 어떻게 추정하고, 그 추정을 사람에게 알리는지.
//
// 고객은 연도를 안 적는다(카카오 접수 로그 전수에서 연도 표기 0건). 그래서 파서가 올해로
// 채우고, 그 날짜가 이미 지났으면 **내년으로 넘긴다**(lib/kakaoIntakeParser.js parseFormDate).
// 연말에 "1/3"이 들어오는 경우를 위한 처리다.
//
// 이 규칙은 멀쩡한 날짜도 1년 뒤로 민다. 9월에 "07/27"이 오면 2027-07-27이 된다 — 실제로
// 그렇게 접수돼 콜마너까지 등록됐다(OID2075, 2026-09-07). 확인 문구에는 결과만 찍혀서
// 읽는 사람은 그게 고객이 말한 값인지 우리가 민 값인지 알 수 없었다.
//
// 밀린 결과가 상식 범위를 넘으면 이제 되묻는다(lib/reservationReask.js,
// scripts/check-reserved-date-reask.js). 그래서 이 표시가 남는 경우는 **그냥 쓰는** 쪽 —
// 12월 말의 "1/3"처럼 며칠 뒤로 밀린 건이다. 그것도 우리가 연도를 정한 것이니 밝힌다.
// 그 노출이 사라지면 추정을 확인 없이 등록하는 상태로 되돌아가므로 여기서 못 박는다.
require('dotenv').config();
const { parseKakaoIntake } = require('../lib/kakaoIntakeParser');
const summary = require('../lib/intakeSummary');
const { kstNow, toDateStr } = require('../lib/period');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

// 오늘을 기준으로 "이미 지난 날짜"와 "아직 안 온 날짜"를 만든다 — 달력에 고정하면
// 이 검사가 연말에만 통과하거나 연중에만 통과한다.
const now = kstNow();
const past = new Date(now.getTime() - 40 * 86400000);
const future = new Date(now.getTime() + 40 * 86400000);
const md = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

function form(dateText) {
  return `[출발지]\n일시 : ${dateText} 18시 30분 도착\n차량번호 : 토레스 150두8774\n`
    + `주소 : 서울 양천로 53길 30\n연락처 : 010-8116-1240\n\n`
    + `[도착지]\n주소 : 경기 화성시 병점구 진안동 922-1\n연락처 : 010-3094-3523`;
}

(async () => {
  console.log('[파서 — 지난 날짜는 내년으로 넘긴다]');
  const rolled = parseKakaoIntake(form(md(past))).when;
  check('내년으로 넘어간다', rolled.date.slice(0, 4), String(now.getUTCFullYear() + 1));
  // 이 플래그가 없으면 확인 문구가 추정을 알릴 방법이 없다.
  check('넘겼다는 표시를 남긴다', rolled.dateRolled, true);

  const kept = parseKakaoIntake(form(md(future))).when;
  check('아직 안 온 날짜는 올해', kept.date.slice(0, 4), String(now.getUTCFullYear()));
  check('그때는 표시가 없다', !!kept.dateRolled, false);

  console.log('\n[연도를 적어주면 그대로 쓴다]');
  // 고객이 연도를 적는 일은 실측 0건이지만(카카오 접수 로그 141건 전수), 적었을 때 무시하면
  // 아무 표시 없이 1년 뒤로 밀린다 — 추정한 게 아니니 확인 문구도 아무 말을 안 한다.
  // "2026년 7월 27일"은 월/일 규칙에 먼저 걸려 연도가 버려졌고, "2026-07-27"은 주소 번지
  // (\d+-\d+)로 오인돼 일시 줄이 통째로 사라져 날짜·시각을 둘 다 잃었다(2026-09-08 실측).
  const year = String(now.getUTCFullYear());
  for (const text of [`${year}-07-27`, `${year}.07.27`, `${year}/07/27`, `${year}년 7월 27일`]) {
    const w = parseKakaoIntake(form(text)).when;
    check(`"${text}"`, [w.date, w.time, !!w.dateRolled], [`${year}-07-27`, '18:30', false]);
  }

  // 번지는 여전히 주소로 읽혀야 한다 — 날짜를 살리려고 주소 판정을 망가뜨리면 안 된다.
  const addr = parseKakaoIntake(form(`${year}-07-27`));
  check('도착지 번지가 살아 있다', addr.destination && addr.destination.address, '경기 화성시 병점구 진안동 922-1');
  check('출발지 주소가 살아 있다', addr.origin && addr.origin.address, '서울 양천로 53길 30');

  console.log('\n[확인 문구 — 추정을 밝힌다]');
  const withNote = summary.buildSummaryText(
    summary.fromParsed(parseKakaoIntake(form(md(past))), null),
    { head: '접수하겠습니다.', labeled: false }
  );
  console.log(`      ${withNote.split('\n')[1]}`);
  check('추정했다고 알린다', /내년으로 봤습니다/.test(withNote), true);

  const noNote = summary.buildSummaryText(
    summary.fromParsed(parseKakaoIntake(form(md(future))), null),
    { head: '접수하겠습니다.', labeled: false }
  );
  // 추정하지 않은 건에까지 붙으면 문구가 늘어나 정작 봐야 할 때 눈에 안 들어온다.
  check('추정 안 했으면 안 알린다', /내년으로 봤습니다/.test(noNote), false);

  // 즉시 요청은 날짜 자체를 오늘로 되돌린다(resolveReservation) — 알릴 추정이 없다.
  const immediate = summary.buildSummaryText(
    { reservedDate: toDateStr(now), reservedTime: '10:00', immediate: true, reservedYearGuessed: true },
    { head: '접수하겠습니다.', labeled: false }
  );
  check('즉시 요청에는 안 붙인다', /내년으로 봤습니다/.test(immediate), false);

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
