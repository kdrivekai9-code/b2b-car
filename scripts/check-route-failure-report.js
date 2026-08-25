// 경로탐색이 실패했을 때 그 사실이 어디엔가 남는지.
//
// 2026-08-25 실사용 사고: 사당역→서귀포시청 요금문의에서 "거리 계산을 완료하지 못했습니다.
// 주소를 조금 더 상세히 입력해주세요"가 나갔다. 주소는 둘 다 정상 확정됐고 서버 경로탐색도
// 멀쩡했다(직접 호출해 571.8km 확인) — 안내가 틀린 말이었고, 고객은 고칠 것이 없는 주소를
// 고치려 들었다. 그런데 원인을 확인할 방법이 전혀 없었다:
//
//   · 브라우저는 응답이 ok가 아니면 null로 바꿔 그냥 return하고, 예외는 빈 .catch()가 먹었다.
//   · 서버는 실패 응답을 돌려주기만 하고 아무 기록도 남기지 않았다.
//
// 그래서 화면에는 직선거리 임시값만 남고 챗봇은 20초를 기다리다 포기하는데, 왜 그랬는지가
// 아무 데도 없었다. 이 검사는 그 두 구멍이 다시 열리지 않는지 본다 — 실패 자체를 막을 수는
// 없지만, 실패가 조용해지는 것은 막을 수 있다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { getKakaoDirections } = require('../lib/routeFareSearch');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}
function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

(async () => {
  try {
    console.log('[실패를 조용히 삼키는 자리가 남아 있지 않다]');
    // 경로탐색 부분만 본다. 같은 파일의 다른 조회(행정구역·결제수단·요금 미리보기)에도 빈
    // .catch()가 있지만 그건 이번 사고와 무관하고, 여기서 같이 걸면 검사가 무슨 말을 하는지
    // 알 수 없어진다 — 그 조회들은 실패해도 고객에게 틀린 안내가 나가지 않는다.
    const directionsOnly = (rel) => {
      const src = read(rel);
      const from = src.indexOf('fetchRealDirections') >= 0
        ? src.indexOf('function fetchRealDirections(')
        : src.indexOf('function applyFinal(');
      const to = src.indexOf('function refreshMapView(');
      return from >= 0 ? src.slice(from, to > from ? to : undefined) : src;
    };
    for (const rel of ['public/js/order-form.js', 'src/app/orders/new/RouteMap.js', 'src/app/orders/new/RouteCalculator.js']) {
      const src = directionsOnly(rel);
      const silentOk = /res\.ok \? res\.json\(\) : null|r\.ok \? r\.json\(\) : null/.test(src);
      check(`${rel} — ok가 아니면 null로 바꾸지 않는다`, silentOk, false);
      const emptyCatch = /\.catch\(\s*(function\s*\(\s*\)\s*\{\s*\}|\(\s*\)\s*=>\s*\{\s*\})\s*\)/.test(src);
      check(`${rel} — 빈 .catch()가 없다`, emptyCatch, false);
    }

    console.log('[실패 사유가 사람이 읽을 수 있게 남는다]');
    const orderForm = read('public/js/order-form.js');
    // 챗봇이 이 값을 읽어 고객에게 맞는 말을 한다.
    check('order-form.js가 사유를 __aiIntakeRouteError에 담는다',
      /__aiIntakeRouteError/.test(orderForm), true);
    check('order-form.js가 콘솔에도 남긴다',
      /console\.error\('\[경로탐색 실패\]/.test(orderForm), true);
    // 새 요청이 시작되면 지난 실패를 지운다 — 안 지우면 다음 안내에 옛 사유가 묻는다.
    check('새 요청 시작 시 사유를 지운다',
      (orderForm.match(/setRouteError\(null, null\)/g) || []).length >= 3, true);

    console.log('[고객 안내가 주소 탓으로 단정하지 않는다]');
    const intake = read('public/js/ai-intake.js');
    // 주소가 멀쩡한데 "주소를 더 상세히"라고 하면 고객은 고칠 것이 없는 것을 고치려 든다.
    // 옛 문구 그대로(말풍선으로 나가던 문장). 주석에 인용된 것과 섞이지 않게 문장째로 본다.
    check('"상세히 입력해주시면 다시 계산" 안내가 남아 있지 않다',
      /상세히 입력해주시면 다시 계산/.test(intake), false);
    check('"경유지 주소를 … 알려주시면" 안내가 남아 있지 않다',
      /상세히 알려주시면 다시 계산/.test(intake), false);
    check('실패 안내를 한 곳에서 만든다', /function routeFailureText/.test(intake), true);
    // 사유를 알면 밝히고, 모르면 시간초과라고만 말해야 한다.
    check('사유가 있으면 그대로 밝힌다', /err\.stage \+ ': ' \+ err\.detail/.test(intake), true);

    console.log('[서버도 실패를 기록한다 — 화면을 열지 않고 원인을 본다]');
    const kakaoRoute = read('routes/kakao.js');
    check('directions 실패를 통합 오류 로그에 남긴다',
      /logIntegrationErrorAsync\(\{[\s\S]{0,200}operation: 'directions'/.test(kakaoRoute), true);
    // 기록만 하고 응답은 그대로 실패로 돌려줘야 한다 — 기록이 실패를 삼키면 안 된다.
    check('기록 후에도 실패 응답을 그대로 돌려준다',
      /logIntegrationErrorAsync\([\s\S]{0,600}?return res\.status\(result\.status\)\.json/.test(kakaoRoute), true);

    console.log('[무료도로로 경로가 없으면 조건을 풀고 다시 묻는다]');
    // 진짜 원인이 여기였다(통합 오류 로그 422 "경로를 찾을 수 없습니다"로 잡혔다).
    // 탁송은 경로탐색 기본값이 무료도로라 avoid=toll이 붙는데, 제주는 톨게이트를 피하면
    // 카카오가 경로를 못 준다. 그래서 제주행 탁송 요금문의가 계속 실패해왔다.
    const sadang = '126.98155858357366,37.47656223234824';
    const seogwipo = '126.55956346690888,33.254064625579836';
    const jejuFree = await getKakaoDirections({
      origin: sadang, destination: seogwipo, priority: 'RECOMMEND', waypoints: [], avoid: 'toll',
    });
    check('제주행 무료도로도 결과가 나온다', jejuFree.ok, true);
    // 조용히 바꾸면 안 된다 — 탁송은 톨비를 고객이 내는 경우가 많다. 바꿨다는 사실이 올라와야
    // 화면과 챗봇이 밝힐 수 있다.
    check('회피조건을 푼 사실을 알려준다', jejuFree.avoidDropped, 'toll');
    check('도선 구간은 그대로 잡는다', jejuFree.hasFerryLeg, true);

    // 무료도로로 되는 경로까지 유료로 바꿔버리면 안 된다 — 그건 요금을 올리는 변경이다.
    const busanFree = await getKakaoDirections({
      origin: sadang, destination: '129.0403,35.1151', priority: 'RECOMMEND', waypoints: [], avoid: 'toll',
    });
    check('육지 장거리는 무료도로 그대로', busanFree.ok, true);
    check('멀쩡한 무료도로 경로는 건드리지 않는다', busanFree.avoidDropped, undefined);
    check('무료도로라 톨비 0원', Number(busanFree.tollFare) || 0, 0);

    console.log('[바뀐 사실이 화면과 챗봇에 나온다]');
    check('오더폼이 avoidDropped를 받아 담는다', /avoidDropped: data\.avoidDropped/.test(orderForm), true);
    check('오더폼이 그 사실을 표시한다', /무료도로만으로는 경로가 없어/.test(orderForm), true);
    check('챗봇이 거리 안내에 붙인다', /무료도로만으로는 경로가 없어/.test(intake), true);
    check('통행료가 별도임을 밝힌다', /통행료는 별도입니다/.test(intake), true);

    console.log('[사고가 난 그 경로는 실제로 계산된다 — 서버는 문제가 아니었다]');
    // 전사에 나온 장소 그대로. 이게 실패하면 원인이 서버로 옮겨간 것이니 바로 알아야 한다.
    const jeju = await getKakaoDirections({
      origin: '126.98155858357366,37.47656223234824',   // 사당역 2호선
      destination: '126.55956346690888,33.254064625579836', // 서귀포시청 제1청사
      priority: 'RECOMMEND', waypoints: [],
    });
    check('사당역 → 서귀포시청 경로탐색 성공', jeju.ok, true);
    check('거리가 나온다', Number(jeju.totalDistance) > 0, true);
    // 제주는 육로로 이어지지 않는다 — 도선 구간을 못 잡으면 도선료가 요금에서 빠진다.
    check('도선 구간을 잡는다', jeju.hasFerryLeg, true);
    // 구간 분해(segments)가 없을 수도 있는데, 그때 총거리까지 못 그리면 안 된다(그 예외가
    // 바로 화면을 직선거리에 묶어두는 원인이 될 수 있었다).
    check('segments가 없어도 총거리는 그린다',
      /Array\.isArray\(data\.segments\)/.test(orderForm), true);
  } finally {
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
