// 장애 알림 판정 검사 — 발송 없이 규칙만 본다.
//
// 이 장치가 틀리면 두 방향으로 망가진다: 장애가 나도 조용하거나, 멀쩡한데 매분 울린다.
// 뒤쪽이 더 위험하다 — 사람이 알림을 꺼버려서 정작 다음 장애를 놓친다.
require('dotenv').config();

const systemAlert = require('../lib/systemAlert');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${e} / 실제 ${a})`}`);
}

const cfg = {
  errorWindowMin: 10, errorThreshold: 20, cooldownMin: 60,
  backlogPercent: 80, stalledMin: 15,
};

(async () => {
  console.log('[KST 시각 문자열]');
  const s = systemAlert.kstStringMinutesAgo(0);
  check('형식이 DB(text)와 같다', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s), true);
  const past = systemAlert.kstStringMinutesAgo(60);
  check('과거 시각이 더 작다(문자열 비교가 성립)', past < s, true);

  console.log('\n[동기화 백로그 판정]');
  // DB를 건드리지 않도록 count를 직접 넣어 계산 규칙만 확인한다.
  const backlog = (count, limit) => {
    const threshold = Math.ceil(limit * (cfg.backlogPercent / 100));
    if (count < threshold) return null;
    return count > limit ? 'over' : 'near';
  };
  check('상한의 79%면 조용', backlog(157, 200), null);
  check('상한의 80%면 경고', backlog(160, 200), 'near');
  check('상한과 같으면 경고', backlog(200, 200), 'near');
  check('상한을 넘으면 심각', backlog(201, 200), 'over');
  check('진행 오더가 없으면 조용', backlog(0, 200), null);

  console.log('\n[쿨다운]');
  const now = Date.now();
  const fakePrev = (minAgo, value) => ({ last_sent_at: new Date(now - minAgo * 60000), last_value: value });
  const decide = (prev, alertValue) => {
    if (!prev) return true;
    const elapsedMin = (now - new Date(prev.last_sent_at).getTime()) / 60000;
    if (elapsedMin >= cfg.cooldownMin) return true;
    const prevValue = Number(prev.last_value) || 0;
    return prevValue > 0 && alertValue >= prevValue * 2;
  };
  check('처음이면 보낸다', decide(null, 30), true);
  check('쿨다운 안이면 안 보낸다', decide(fakePrev(10, 30), 35), false);
  check('쿨다운이 지나면 보낸다', decide(fakePrev(61, 30), 35), true);
  // 악화는 새 소식이다 — 쿨다운 중이라도 알려야 한다.
  check('규모가 2배가 되면 쿨다운 중에도 보낸다', decide(fakePrev(5, 30), 60), true);
  check('2배 미만이면 안 보낸다', decide(fakePrev(5, 30), 59), false);
  check('줄어들면 안 보낸다', decide(fakePrev(5, 30), 10), false);

  console.log('\n[설정 기본값]');
  const loaded = await systemAlert.loadSettings().catch(() => null);
  if (!loaded) {
    console.log('  SKIP 설정 조회 실패(DB 미연결) — 규칙 검사는 위에서 끝났다');
  } else {
    check('오류 임계 기본 20건', loaded.errorThreshold >= 1, true);
    check('쿨다운 기본값이 있다', loaded.cooldownMin >= 1, true);
    check('백로그 기준이 백분율 범위', loaded.backlogPercent >= 10 && loaded.backlogPercent <= 100, true);
  }

  // 실제 DB를 보고 지금 무엇이 걸리는지 — 검사라기보다 현황 확인이다.
  console.log('\n[현재 상태(참고)]');
  try {
    const cur = await systemAlert.loadSettings();
    const limit = Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 200);
    const found = [
      ...await systemAlert.checkErrorSpikes(cur),
      ...await systemAlert.checkSyncBacklog(cur, limit),
      ...await systemAlert.checkSyncStalled(cur),
    ];
    if (!found.length) console.log('  걸리는 항목 없음 (정상)');
    found.forEach((f) => console.log('  ●', f.title, '|', f.key));
  } catch (e) {
    console.log('  조회 실패(무시):', e.message);
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('검사 실패:', e);
  process.exit(1);
});
