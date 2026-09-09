// 확인 단계의 "고쳐주세요"가 제대로 먹는지 본다.
//
// 무엇을 지키나(2026-09-08 실사용 사고): 확인 화면에서 고객이 "예약일을 2026년 9월 8일
// 18:30분 도착으로 변경해줘"라고 했는데, 예약일은 2027-07-27 그대로였고 그 문장 자체가
// 도착지 칸에 들어갔다. 주소 줄에는 앞선 지시문이 " / "로 덧붙기까지 했다.
//
// 원인은 둘이었다.
//   1. 확인 대기 중의 답을 원문에 **이어붙여** 통째로 다시 파싱했다. 그 방식은 보충
//      ("차량은 12가1234요")에는 맞지만 정정("A를 B로 바꿔줘")에는 안 맞는다 — 지시문이
//      값으로 흡수되고, 나중 값이 앞 값을 덮는 규칙이 없어 먼저 나온 날짜가 이긴다.
//   2. 예약일 되묻기가 **연도를 적어준 먼 미래**를 안 봤다. 밀린 경우와 지난 날짜만 봐서
//      2027-07-27이 확인 화면까지 그대로 올라왔다.
//
// 모델을 부르지 않는다. 병합 규칙·되묻기 판정·연결만 본다 — 그래야 회차마다 같은 답이 나오고
// CI에서 돌릴 수 있다. 모델이 델타를 잘 뽑는지는 사람이 확인한다(실측 3건은 통과).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { mergeDelta } = require(path.join(ROOT, 'lib/intakeCorrection'));
const { needsDateReask, buildDateQuestion } = require(path.join(ROOT, 'lib/reservationReask'));

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// 사고 당시의 접수 내용 그대로.
function baseParsed() {
  return {
    vehicles: [{ plate: '150두8774', type: '토레스' }],
    origin: { address: '서울 양천로 53길 30', addressDetail: '서서울모터리움 803호', contact: '010-8116-1240' },
    destination: { address: '경기도 화성시 병점구 진안동 922-1', addressDetail: null, contact: '010-3094-3523' },
    when: { immediate: false, date: '2027-07-27', time: '18:30', dateRolled: false, raw: '2027-07-27 18:30' },
    memo: '회수서류 우편발송',
  };
}
// **날짜를 박아두지 않는다.** 처음에는 사고 당일 날짜(2026-09-08)를 그대로 썼는데, 하루가
// 지나자 그 날짜가 과거가 되어 되묻기(reason:'past')에 걸렸고 검사가 CI에서 깨졌다 —
// 코드는 그대로인데 달력이 움직여서 깨지는 검사는 배포를 막는 근거가 못 된다.
function daysFromToday(n) {
  const d = new Date(Date.now() + n * 86400000);
  const kst = new Date(d.getTime() + 9 * 3600000);
  return kst.toISOString().slice(0, 10);
}
const TOMORROW = daysFromToday(1);

const NOTHING = {
  isCorrection: true, reservedDate: null, reservedTime: null,
  originAddress: null, originAddressDetail: null, originContact: null,
  destinationAddress: null, destinationAddressDetail: null, destinationContact: null,
  vehicleNumber: null, vehicleType: null, memo: null,
};

console.log('[바뀐 항목만 바뀐다]');
{
  const r = mergeDelta(baseParsed(), { ...NOTHING, reservedDate: TOMORROW, reservedTime: '18:30' });
  check('예약일이 바뀐다', r.parsed.when.date === TOMORROW && r.parsed.when.time === '18:30',
    `${r.parsed.when.date} ${r.parsed.when.time}`);
  // 이것이 사고의 핵심이다 — 날짜를 고쳐달라고 했는데 도착지가 바뀌었다.
  check('도착지는 그대로다', r.parsed.destination.address === '경기도 화성시 병점구 진안동 922-1',
    r.parsed.destination.address);
  check('도착지 연락처도 그대로다', r.parsed.destination.contact === '010-3094-3523');
  check('출발지도 그대로다', r.parsed.origin.address === '서울 양천로 53길 30');
  check('차량도 그대로다', r.parsed.vehicles[0].plate === '150두8774');
  check('바뀐 항목만 보고한다', r.changed.join(',') === '예약일시', r.changed.join(','));
}

console.log('\n[null은 "안 바꾼다"이지 "비운다"가 아니다]');
{
  const r = mergeDelta(baseParsed(), { ...NOTHING, destinationContact: '010-1111-2222' });
  check('연락처만 바뀐다', r.parsed.destination.contact === '010-1111-2222');
  check('예약일은 그대로', r.parsed.when.date === '2027-07-27');
  check('요청사항이 안 지워진다', r.parsed.memo === '회수서류 우편발송');
}

console.log('\n[주소를 통째로 바꾸면 옛 상세주소는 버린다]');
{
  // 다른 건물의 호수가 새 주소에 붙어 남는 것이 가장 나쁘다.
  const r = mergeDelta(baseParsed(), { ...NOTHING, originAddress: '서울 강남구 테헤란로 152' });
  check('새 주소가 들어간다', r.parsed.origin.address === '서울 강남구 테헤란로 152');
  check('옛 상세주소가 남지 않는다', r.parsed.origin.addressDetail === null, String(r.parsed.origin.addressDetail));
  const r2 = mergeDelta(baseParsed(), { ...NOTHING, originAddress: '서울 강남구 테헤란로 152', originAddressDetail: '3층' });
  check('상세주소를 같이 주면 그것을 쓴다', r2.parsed.origin.addressDetail === '3층');
}

console.log('\n[정정이 아니면 손대지 않는다]');
{
  const r = mergeDelta(baseParsed(), NOTHING);
  check('바뀐 것이 없으면 빈 목록', r.changed.length === 0, r.changed.join(','));
}

console.log('\n[날짜를 새로 받으면 추정 표시를 지운다]');
{
  const p = baseParsed();
  p.when.dateRolled = true; // 우리가 연도를 밀어서 만든 값이었다
  const r = mergeDelta(p, { ...NOTHING, reservedDate: TOMORROW });
  // 고객이 직접 말한 값이므로 "우리가 추정했다"는 표시가 남으면 안 된다 — 남으면 되묻기가
  // rolled_far로 또 걸려 같은 질문이 반복된다.
  check('dateRolled가 꺼진다', r.parsed.when.dateRolled === false);
  check('되묻지 않는다', needsDateReask(r.parsed.when).ask === false);
}

console.log('\n[먼 미래는 연도가 적혀 있어도 되묻는다]');
{
  const far = { immediate: false, date: '2027-07-27', time: '18:30', dateRolled: false, raw: '2027-07-27 18:30' };
  const r = needsDateReask(far);
  check('되묻는다', r.ask === true && r.reason === 'far', JSON.stringify(r));
  const q = buildDateQuestion(r, far);
  // 거절이 아니라 확인이다 — 90일 뒤 예약은 실제로 있을 수 있다.
  check('그대로 진행할 길을 알려준다', /맞으면 그대로/.test(q), q.split('\n')[1]);
  check('며칠 뒤인지 말해준다', /일 뒤입니다/.test(q));

  const near = { immediate: false, date: '2026-11-01', time: '14:00', dateRolled: false, raw: '11/1' };
  const nearDays = require(path.join(ROOT, 'lib/reservationReask')).daysFromToday(near.date);
  // 90일 안쪽이면 묻지 않는다. 정상 예약마다 대화가 한 턴 늘어나면 안 된다.
  if (nearDays !== null && nearDays <= 90) {
    check('가까운 미래는 안 묻는다', needsDateReask(near).ask === false);
  } else {
    check('가까운 미래는 안 묻는다 (건너뜀 — 오늘 기준 90일 밖)', true);
  }
  check('즉시는 안 묻는다', needsDateReask({ immediate: true, date: null, time: null }).ask === false);
}

console.log('\n[두 채널이 모두 이 경로를 탄다]');
{
  const web = fs.readFileSync(path.join(ROOT, 'lib/webIntakeTurn.js'), 'utf8');
  const kakao = fs.readFileSync(path.join(ROOT, 'routes/kakaoConsult.js'), 'utf8');
  // 위치 비교는 **같은 함수 안에서** 해야 한다. 처음에는 파일 전체에서 찾았는데, 카카오는
  // 확인 처리(handleConfirmReply)와 되묻기 보충 처리가 다른 함수에 있고 후자의 이어붙이기가
  // 파일 앞쪽이라 "정정이 뒤에 있다"는 거짓 실패가 났다. 코드가 아니라 단언이 틀렸던 것이다.
  const scope = (src, startMark) => {
    const i = src.indexOf(startMark);
    if (i < 0) return '';
    const next = src.indexOf('\nasync function ', i + startMark.length);
    return src.slice(i, next < 0 ? src.length : next);
  };
  const bodies = [
    ['웹', scope(web, "if (pending && pending.awaiting === 'confirm')")],
    ['카카오', scope(kakao, 'async function handleConfirmReply')],
  ];
  for (const [label, body] of bodies) {
    check(`${label} 채널이 정정 경로를 부른다`, /applyCorrection\(/.test(body));
    // 정정이 이어붙이기보다 **먼저** 와야 한다. 뒤에 있으면 영원히 안 불린다.
    const cut = body.indexOf('applyCorrection(');
    const merge = body.indexOf('`${pending.raw}\\n');
    check(`${label} 채널은 이어붙이기 전에 정정을 본다`,
      cut >= 0 && (merge < 0 || cut < merge), `정정 ${cut} / 이어붙이기 ${merge}`);
  }
  // 정정에 성공했으면 원문을 그대로 넘겨야 한다 — 지시문을 raw에 남기면 나중 재파싱에서
  // 그 문장이 다시 값으로 흡수된다(사고의 재발 경로).
  check('웹: 정정 성공 시 원문을 그대로 넘긴다', /mergedRaw: pending\.raw/.test(web));
  check('카카오: 정정 성공 시 원문을 그대로 넘긴다', /completeIntake\(session, corrected\.parsed, pending\.raw/.test(kakao));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
