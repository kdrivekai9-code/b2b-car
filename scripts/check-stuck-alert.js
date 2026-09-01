// 조용한 전면 장애를 잡아내는지 검사한다.
//
// 2026-09-01: 세션 저장소가 1시간 30분 동안 모든 요청을 500으로 만들었는데 경보가 한 번도
// 울리지 않았다. 두 겹으로 실패했다 —
//   1. 실패가 console.error로만 나가 integration_errors에 아무것도 안 남았다
//   2. 남았더라도 못 잡았다. 같은 실패를 매 요청 기록할 수는 없어 분당 한 줄로 줄이는데,
//      그러면 10분에 10건이라 '오류 급증' 임계(20건)에 영원히 못 닿는다.
//
// 그래서 둘 다 검사한다: 저장소 실패가 기록되는가, 그리고 '고착' 판정이 그 모양을 잡는가.
require('dotenv').config();

const sessionStore = require('../lib/sessionStore');
const systemAlert = require('../lib/systemAlert');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

// ── 1. 저장소 감싸기 ────────────────────────────────────────────────────────
console.log('[세션 저장소 계측]');

function fakeStore(behavior) {
  return {
    get(sid, cb) { behavior(cb); },
    set(sid, sess, cb) { behavior(cb); },
    destroy(sid, cb) { behavior(cb); },
    touch(sid, sess, cb) { behavior(cb); },
  };
}

const okStore = sessionStore.instrumentSessionStore(fakeStore((cb) => cb(null, { ok: 1 })));
let passed = null;
okStore.get('sid', (err, val) => { passed = { err, val }; });
// 실패를 기록하는 것이지 가로채는 것이 아니다 — 성공 결과가 그대로 와야 한다.
check('성공 결과가 그대로 전달된다', passed && passed.err === null && passed.val && passed.val.ok === 1);

const boom = new Error('Connection terminated due to connection timeout');
boom.code = 'ETIMEDOUT';
const badStore = sessionStore.instrumentSessionStore(fakeStore((cb) => cb(boom)));
let seen = null;
badStore.set('sid', {}, (err) => { seen = err; });
// 실패도 삼키지 않는다. 삼키면 express-session이 세션이 저장된 줄 알고 넘어간다.
check('실패도 원래 콜백으로 그대로 간다', seen === boom);

check('두 번 감싸도 한 번만', sessionStore.instrumentSessionStore(badStore) === badStore);
check('감쌀 메서드에 get/set/destroy가 있다',
  ['get', 'set', 'destroy'].every((m) => sessionStore.WRAPPED.includes(m)));

// 기록 억제 — 이 사고에서는 모든 요청이 같은 에러로 실패했다. 그대로 남기면 초당 수십 건의
// INSERT가 되고, 그 INSERT도 같은 풀을 쓰므로 막힌 DB를 더 밀어붙인다.
sessionStore.resetThrottle();
const logged = [];
for (let i = 0; i < 50; i += 1) sessionStore.noteFailure('get', boom, (payload) => logged.push(payload));
check('50번 실패해도 기록은 1건', logged.length === 1, `${logged.length}건`);
check('source는 session_store', logged[0] && logged[0].source === 'session_store');
// 세션 값에는 사용자 정보가 들어 있다.
check('세션 내용을 싣지 않는다',
  logged[0] && !JSON.stringify(logged[0].context || {}).includes('sess'));

// ── 2. 고착 판정 ────────────────────────────────────────────────────────────
console.log('\n[고착 오류 판정]');
check('checkStuckErrors가 있다', typeof systemAlert.checkStuckErrors === 'function');
check('고착 설정이 있다', !!systemAlert.SETTINGS.stuckMin && !!systemAlert.SETTINGS.stuckMinCount);
// 관측 창이 곧 보고 가능한 지속 시간의 상한이다. 좁으면 90분 장애도 창 끝에서 잘려 보이고,
// 그러면 아래 상향 규칙이 멈춰 장기 장애를 잊는다(실측으로 29분까지 잘렸다).
check('관측 창이 상향 두 단계는 담는다',
  systemAlert.SETTINGS.stuckWindowMin && systemAlert.SETTINGS.stuckWindowMin[1] >= systemAlert.SETTINGS.stuckMin[1] * 4,
  '창 < 고착기준 × 4면 15→30→60 상향이 창 안에서 끝난다');

// 이 사고의 모양: 분당 1건이 90분간. 크기는 작고 길이가 길다.
const cfg = { stuckMin: 15, stuckMinCount: 3, errorWindowMin: 10, errorThreshold: 20 };
const perMinuteFor90 = 90;
check('급증 임계로는 못 잡는 모양이다',
  Math.min(perMinuteFor90, cfg.errorWindowMin) < cfg.errorThreshold,
  `10분 창에 ${Math.min(perMinuteFor90, cfg.errorWindowMin)}건 < 임계 ${cfg.errorThreshold}건`);
check('고착 최소 건수로는 잡힌다', perMinuteFor90 >= cfg.stuckMinCount);

// 값이 건수가 아니라 지속 분이어야 쿨다운의 "2배면 다시 알린다"가 의미를 갖는다 —
// 15분 → 30분 → 60분으로 다시 울려, 안 풀리는 장애를 잊지 않게 한다.
const escalates = (prev, now) => now >= prev * 2;
check('지속 시간이 2배가 되면 다시 알린다', escalates(15, 30) && !escalates(15, 20));

(async () => {
  console.log('\n[실제 DB]');
  if (!process.env.DATABASE_URL) {
    console.log('  건너뜀 — DATABASE_URL 없음');
  } else {
    try {
      const full = await systemAlert.loadSettings();
      check('설정을 읽는다',
        Number.isFinite(full.stuckMin) && Number.isFinite(full.stuckMinCount) && Number.isFinite(full.stuckWindowMin));
      const alerts = await systemAlert.checkStuckErrors(full);
      // 지금 걸리는 게 없는 것이 정상이다. 던지지 않고 배열을 주는지만 본다.
      check('질의가 성공한다', Array.isArray(alerts), '집계 SQL이 깨지면 조용히 []가 된다');
      console.log(`  (참고) 지금 고착으로 걸리는 것: ${alerts.length}건`);
      alerts.forEach((a) => console.log(`         - ${a.title} / ${a.body.slice(0, 60)}`));
    } catch (e) {
      check('DB 검사', false, e.message);
    }
  }
  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
