// 고객이 브라우저 알림으로 오더 진행을 받을 수 있는지 본다.
//
// 왜 필요한가(실사용 지적 2026-09-08): 웹 통보는 상담창에 꽂히는데 창을 열지 않으면 도착한
// 줄을 모른다. 안읽음 배지를 붙였지만 그것도 화면을 열어야 보인다 — 카카오는 앱 알림이
// 저절로 뜨는데 웹은 그게 없었다.
//
// 만들면서 **웹푸시 구독 자체가 깨져 있던 것**을 찾았다. 2026-08-29에 notify_plate_mismatch
// 컬럼이 추가될 때 INSERT의 컬럼 목록만 늘리고 VALUES의 물음표를 안 늘려서(컬럼 10개 /
// 물음표 8개) 42601로 항상 실패했다. 그날부터 아무도 구독할 수 없었다 — 알림이 안 오는 것은
// 조용해서, 남아 있는 구독 3건이 전부 2026-08-03 이전 것인 걸 세어보고서야 알았다.
//
// 파일만 읽는다 — DB도 외부 서비스도 부르지 않으므로 CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

console.log('[구독 INSERT의 컬럼과 값 개수가 맞는다]');
const pushRoutes = read('routes/push.js');
// 손으로 맞추는 방식은 이미 한 번 깨졌다. 컬럼 배열에서 물음표를 만들어야 한다.
check('컬럼을 배열로 두고 물음표를 그 길이에서 만든다',
  /const COLUMNS = \[/.test(pushRoutes)
  && /COLUMNS\.map\(\(\) => '\?'\)\.join/.test(pushRoutes));
check('컬럼 목록도 그 배열에서 만든다', /COLUMNS\.join\(', '\)/.test(pushRoutes));
// 물음표를 문자열로 박아두면 같은 사고가 다시 난다.
const literalValues = pushRoutes.match(/VALUES \((\?, )+\?\)/g) || [];
check('VALUES에 물음표를 박아두지 않았다', literalValues.length === 0, literalValues.join(' '));
// ON CONFLICT 갱신 목록도 같은 배열에서 만들어야 컬럼이 늘 때 함께 따라온다.
check('갱신 목록도 같은 배열에서 만든다', /excluded\.\$\{c\}|=excluded\.\$\{c\}/.test(pushRoutes)
  || /\$\{c\}=excluded\.\$\{c\}/.test(pushRoutes));

console.log('\n[고객 한 사람에게 보내는 길이 있다]');
const pushLib = read('lib/push.js');
check('notifyUser가 있다', /async function notifyUser\(/.test(pushLib));
check('내보낸다', /module\.exports = \{ notify, notifyUser \}/.test(pushLib));
// 지사·이벤트 조건은 관리자용이다. 고객은 자기 구독만 봐야 한다.
check('사용자 구독만 고른다',
  /WHERE user_id = \? AND notify_order_events = 1/.test(pushLib));
// 만료된 기기를 안 지우면 영원히 재시도한다.
check('만료된 구독을 지운다',
  /statusCode === 404 \|\| err\.statusCode === 410[\s\S]{0,200}DELETE FROM push_subscriptions/.test(pushLib));
// 구독자마다 독립적인 외부 요청이다 — 순차로 보내면 기기 수만큼 왕복이 곱해진다.
check('병렬로 보낸다', /notifyUser[\s\S]{0,1200}Promise\.all\(subs\.map/.test(pushLib));
check('VAPID 미설정이면 조용히 건너뛴다', /notifyUser[\s\S]{0,300}VAPID_PUBLIC_KEY/.test(pushLib));

console.log('\n[통보가 나갈 때 함께 보낸다]');
const notify = read('lib/kakaoOrderNotify.js');
check('웹 통보 성공 뒤에 부른다', /notifyUser\(\{/.test(notify));
// 카카오는 알림톡이 이미 그 역할을 한다 — 중복해서 보내면 같은 소식이 두 번 온다.
check('카카오 채널에는 보내지 않는다', /target\.channel === 'web' && target\.order\.created_by/.test(notify));
// 브라우저 알림은 덤이고 상담창 메시지가 본체다. 여기서 막히면 발송 대기줄이 느려진다.
check('실패해도 통보를 막지 않는다',
  /notifyUser\(\{[\s\S]{0,400}\.catch\(\(e\) => console\.error/.test(notify));
check('상담창으로 보낸다(배지도 거기서 지워진다)', /url: '\/orders\/ai-intake'/.test(notify));

console.log('\n[고객 화면 문구와 스위치]');
// 고객에게 "본인이 등록한 오더는 알림이 안 온다"고 적어두면 정확히 반대다.
for (const [label, src] of [['EJS', read('views/push_settings.ejs')], ['Next', read('src/app/push/settings/page.js')]]) {
  check(`${label}: 고객용 문구가 따로 있다`, /내 오더의 진행 알림/.test(src));
}
for (const [label, src] of [['EJS', read('views/push_settings.ejs')], ['Next', read('src/app/push/settings/PushSettingsClient.js')]]) {
  check(`${label}: 고객에게는 스위치가 하나다`, /내 오더 진행 알림/.test(src));
  // 없는 체크박스를 널 가드 없이 읽으면 구독 버튼이 통째로 죽는다.
  check(`${label}: 없는 체크박스를 읽지 않는다`,
    /notifyDriverAssignEl \? notifyDriverAssignEl\.checked : true/.test(src));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
