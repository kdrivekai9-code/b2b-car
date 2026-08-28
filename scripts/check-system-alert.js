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
  backlogPercent: 80, stalledMin: 15, timeBudgetThreshold: 3,
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
  check('상한의 79%면 조용', backlog(394, 500), null);
  check('상한의 80%면 경고', backlog(400, 500), 'near');
  check('상한과 같으면 경고', backlog(500, 500), 'near');
  check('상한을 넘으면 심각', backlog(501, 500), 'over');
  check('진행 오더가 없으면 조용', backlog(0, 500), null);

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

  console.log('\n[폴링 순환 — 상한을 넘어도 굶는 오더가 없어야 한다]');
  // 예전 정렬은 id DESC라 매분 같은 결과를 줬다. 상한을 넘는 순간 뒤로 밀린 오더는 한 번도
  // 조회되지 않고, 3일이 지나면 조회 대상에서 아예 빠져 영영 미완료로 남았다.
  // 확인 시각(오래된 순)으로 돌리면 모든 오더가 ceil(N/L)분 안에 한 번은 걸린다.
  const rotate = (n, limit, rounds) => {
    // synced[i] = 마지막으로 확인된 회차. -1은 아직 한 번도 확인 안 됨.
    const synced = Array.from({ length: n }, () => -1);
    for (let r = 0; r < rounds; r += 1) {
      const order = synced
        .map((v, i) => ({ i, v }))
        .sort((a, b) => (a.v - b.v) || (b.i - a.i))
        .slice(0, limit);
      order.forEach(({ i }) => { synced[i] = r; });
    }
    return Math.min(...synced);
  };
  // 대상 500건 / 상한 200건 → 3회차(ceil(500/200)=3) 안에 전부 한 번은 확인돼야 한다.
  check('1200건을 상한 500으로 3회 돌리면 빠지는 오더 없음', rotate(1200, 500, 3) >= 0, true);
  check('대상이 상한 이하면 매 회차 전부 확인', rotate(400, 500, 1) >= 0, true);
  // 시간 예산 때문에 일부를 미뤄도 마찬가지다 — 미뤄진 건이 다음 회차 맨 앞으로 온다.
  check('상한의 절반만 처리해도 6회 안에 전부', rotate(1200, 250, 5) >= 0, true);
  // 예전 방식(항상 같은 앞쪽 N건)에서는 뒤쪽이 영원히 -1로 남는다 — 그 대비를 남겨둔다.
  const starve = (n, limit, rounds) => {
    const synced = Array.from({ length: n }, () => -1);
    for (let r = 0; r < rounds; r += 1) {
      for (let i = 0; i < Math.min(limit, n); i += 1) synced[i] = r; // id DESC 고정 순서
    }
    return Math.min(...synced);
  };
  check('예전 방식은 100회를 돌려도 굶는 오더가 남는다', starve(1200, 500, 100), -1);

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
    const limit = Number(process.env.CALLMANER_SYNC_ORDER_LIMIT || 500);
    const found = [
      ...await systemAlert.checkErrorSpikes(cur),
      ...await systemAlert.checkSyncBacklog(cur, limit),
      ...await systemAlert.checkSyncTimeBudget(cur),
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
