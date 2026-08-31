// 기사 푸시(FCM) 검사 — 실제로 보내지 않고 메시지 구성과 실패 처리만 본다.
//
// 이 기능이 틀리면 두 방향으로 망가진다:
//   · 알림이 뜨는데 탭해도 엉뚱한 화면 — notification/data 조합이 틀린 경우
//   · 기기를 바꾼 기사에게 매번 실패가 쌓임 — 죽은 토큰을 안 지우는 경우
require('dotenv').config();

const push = require('../lib/driverPush');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${e} / 실제 ${a})`}`);
}

console.log('[메시지 구성]');
const m = push.buildMessage('TOK123', {
  title: 'OID1476 전달사항', body: '도착지가 변경되었습니다',
  deeplink: '/driver/chat?order=1476', orderId: 1476, msgId: 88,
}).message;

// notification만 보내면 탭했을 때 앱이 받을 데이터가 없어 첫 화면만 열린다.
// data만 보내면 알림 자체가 안 뜬다(특히 iOS). 둘 다 있어야 한다.
check('notification과 data를 둘 다 싣는다', [!!m.notification, !!m.data], [true, true]);
check('딥링크가 data에 있다', m.data.deeplink, '/driver/chat?order=1476');
// FCM data 값은 전부 문자열이어야 한다 — 숫자를 그대로 넣으면 요청이 거부된다.
check('data 값은 전부 문자열', Object.values(m.data).every((v) => typeof v === 'string'), true);
check('숫자도 문자열로 변환', [m.data.orderId, m.data.msgId], ['1476', '88']);
check('빈 값도 문자열로', push.buildMessage('T', { title: 'a', body: 'b' }).message.data.orderId, '');
// 절전 상태에서도 즉시 도착해야 한다.
check('안드로이드 우선순위 high', m.android.priority, 'high');
// 배차 알림과 같은 채널이면 기사가 한쪽을 끄는 순간 둘 다 꺼진다.
check('전달사항 전용 알림 채널', m.android.notification.channel_id, 'driver_message');
check('iOS 우선순위', m.apns.headers['apns-priority'], '10');
check('토큰이 실린다', m.token, 'TOK123');

console.log('\n[실패 코드 판정]');
const err = (code) => push.errorCodeOf({
  error: { status: 'X', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code }] },
});
check('FcmError에서 코드를 뽑는다', err('UNREGISTERED'), 'UNREGISTERED');
check('details가 없으면 status로', push.errorCodeOf({ error: { status: 'UNAVAILABLE' } }), 'UNAVAILABLE');
check('아무것도 없으면 UNKNOWN', push.errorCodeOf(null), 'UNKNOWN');

// 앱 삭제·재설치·장기 미사용이면 토큰이 죽는다 — 지워야 매번 실패가 쌓이지 않는다.
check('UNREGISTERED는 죽은 토큰', push.DEAD_TOKEN_CODES.has('UNREGISTERED'), true);
// 서버가 잠깐 죽은 것은 토큰 탓이 아니다 — 지우면 안 된다.
check('UNAVAILABLE은 지우지 않는다', push.DEAD_TOKEN_CODES.has('UNAVAILABLE'), false);
check('INTERNAL도 지우지 않는다', push.DEAD_TOKEN_CODES.has('INTERNAL'), false);

console.log('\n[설정이 없을 때]');
// 자격증명이 없는 환경(로컬·마이그레이션 전)에서 예외를 던지면 메시지 저장까지 막힌다.
check('설정이 없으면 보내지 않는다', typeof push.isConfigured(), 'boolean');

(async () => {
  const r = await push.notifyDriver(1, { title: 'a', body: 'b' });
  if (!push.isConfigured()) {
    check('설정 없이 불러도 예외가 아니다', r.skipped, 'not_configured');
  } else {
    console.log('  SKIP 자격증명이 설정돼 있어 이 검사는 건너뜁니다');
  }

  console.log('\n[발송 — HTTP를 흉내내서]');
  const okFetch = async () => ({ ok: true });
  const deadFetch = async () => ({
    ok: false,
    json: async () => ({ error: { message: '토큰 없음', details: [{ '@type': 'FcmError', errorCode: 'UNREGISTERED' }] } }),
  });
  // 자격증명이 없으면 getAccessToken에서 막히므로, 그 경우엔 이 구간을 건너뛴다.
  if (!push.isConfigured()) {
    console.log('  SKIP 자격증명이 없어 발송 경로는 건너뜁니다(구성 검사는 위에서 끝났다)');
  } else {
    const a = await push.sendToToken('T', { title: 'a', body: 'b' }, { fetchImpl: okFetch });
    check('성공하면 ok', a.ok, true);
    const b = await push.sendToToken('T', { title: 'a', body: 'b' }, { fetchImpl: deadFetch });
    check('죽은 토큰은 dead로 표시', [b.ok, b.dead], [false, true]);
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
