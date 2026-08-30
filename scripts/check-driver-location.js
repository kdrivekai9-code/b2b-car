// 기사 위치 — 언제 보여주고 언제 감추는지를 못 박는다.
//
// 이 기능의 위험은 두 가지다. 둘 다 화면을 봐서는 안 보인다:
//   - 완료된 운행의 위치를 계속 물어보면 콜마너를 헛되이 두드린다(수집이 끝난 값이다)
//   - 오래된 좌표를 "지금 위치"로 보여주면 고객이 엉뚱한 곳에서 기다린다
require('dotenv').config();
const driverLocation = require('../lib/driverLocation');
const kakaoNotify = require('../lib/kakaoOrderNotify');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

(async () => {
  console.log('[언제 조회하나]');
  const slip = { callmaner_conf_slip: 'C1' };
  check('기사배정이면 조회한다', driverLocation.isTrackable({ ...slip, status: '기사배정' }), true);
  check('운행시작이면 조회한다', driverLocation.isTrackable({ ...slip, status: '운행시작' }), true);
  // 완료 뒤에는 콜마너가 위치를 수집하지 않는다(사용자 확인) — 물어봐야 빈손이다.
  check('완료면 안 조회한다', driverLocation.isTrackable({ ...slip, status: '완료' }), false);
  check('취소면 안 조회한다', driverLocation.isTrackable({ ...slip, status: '취소' }), false);
  check('배차 전이면 안 조회한다', driverLocation.isTrackable({ ...slip, status: '접수' }), false);
  // 콜마너에 안 올라간 오더는 애초에 조회할 대상이 없다.
  check('콜마너 접수번호가 없으면 안 조회한다', driverLocation.isTrackable({ status: '기사배정' }), false);

  console.log('[사유를 구분해서 알려준다]');
  // "확인되지 않습니다" 한 마디로 뭉뚱그리면 보는 사람이 새로고침만 반복하고 결국 전화한다.
  const done = await driverLocation.loadForOrder({ id: 1, status: '완료', callmaner_conf_slip: 'C1' });
  check('완료는 실패가 아니라 완료로', done.reason, 'completed');
  const early = await driverLocation.loadForOrder({ id: 2, status: '기사배정' });
  check('콜마너 연동 없음', early.reason, 'no_callmaner');

  console.log('[링크]');
  // 운행 중에만 링크를 준다. 완료된 운행 링크를 보내면 열어봐야 빈 화면이라 문의만 는다.
  const running = { status: '기사배정', tracking_token: 'tok-1' };
  check('토큰이 있으면 주소를 만든다', /\/track\/tok-1$/.test(driverLocation.trackingLink(running)), true);
  // 마이그레이션 전 오더는 토큰이 없다 — 빈 값이라야 통보 문구에서 그 줄이 사라진다.
  check('토큰이 없으면 빈 값', driverLocation.trackingLink({ status: '기사배정' }), '');

  console.log('[통보 문구]');
  const tpl = '접수번호: {oid}\n현재 위치: {driver_place}\n도착 예상: {driver_eta}\n실시간 위치: {driver_location_link}';
  const order = { oid: 'OID1', status: '기사배정', tracking_token: 'tok-1' };
  const withLoc = kakaoNotify.renderTemplate(tpl, order, { driverPlace: '서울 강남구 역삼동', driverEtaMinutes: 12 });
  check('위치가 있으면 채운다', withLoc.split('\n')[1], '현재 위치: 서울 강남구 역삼동');
  check('ETA에 단위가 붙는다', withLoc.split('\n')[2], '도착 예상: 약 12분');
  // 위치를 못 가져와도 통보 자체는 나가야 한다 — 라벨만 남은 줄은 통째로 사라진다.
  const noLoc = kakaoNotify.renderTemplate(tpl, order, {});
  check('위치가 없으면 그 줄만 사라진다', noLoc.split('\n').length, 2);
  check('통보 자체는 살아있다', noLoc.split('\n')[0], '접수번호: OID1');
  // 완료된 오더에는 링크를 넣지 않는다.
  const doneMsg = kakaoNotify.renderTemplate(tpl, { ...order, status: '완료' }, {});
  check('완료 오더에는 링크가 없다', /track/.test(doneMsg), false);

  console.log('[설정 화면 변수 칩]');
  // 칩과 renderTemplate이 같은 목록을 봐야 한다 — 화면에서 넣은 토큰이 치환 안 되면 그대로 발송된다.
  const tokens = kakaoNotify.TEMPLATE_VARIABLES.map((v) => v.token);
  ['{driver_place}', '{driver_eta}', '{driver_location_link}'].forEach((t) => {
    check(`${t} 칩이 있다`, tokens.includes(t), true);
  });

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
