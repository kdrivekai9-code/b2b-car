// 이 커밋이 정말 프로덕션에 올라갔는지 확인한다.
//
// 왜 필요한가(2026-08-29 실사고): JSX 오류로 Vercel 빌드가 실패했는데, 실패한 배포는 alias를
// 못 받으니 **이전 배포가 그대로 서비스됐다.** 깨진 코드가 나간 게 아니라 프로덕션이 옛 코드에
// 멈춘 것이다. 그 사이 올린 동기화 순환 수정·배치 상향·장애 알림이 하나도 반영되지 않았는데,
// 저장소만 보면 다 끝난 것처럼 보였다. 프로덕션 크론이 302를 돌려주는 것을 보고서야 알았다.
//
// 그래서 배포를 **막지 않는다.** 막는 것으로는 이 사고를 못 잡는다(빌드 실패는 이미 배포를
// 막고 있었다). 빠져 있던 것은 "안 올라갔다"를 알아채는 수단이다. 막으면 오히려 잃는 게 있다 —
// 게이트가 고장나면 정상 코드도 못 나가고, 급한 수정이 CI에 묶인다. 세션 저장소가 1시간 30분
// 전면 장애였을 때 고쳐서 1분 만에 배포했는데, 그 능력을 위험에 놓을 이유가 없다.
//
// Vercel CLI도 토큰도 쓰지 않는다. Vercel의 GitHub 앱이 배포 상태를 GitHub에 그대로 올려주므로
// (deployments API), 워크플로에 기본으로 있는 GITHUB_TOKEN만으로 읽을 수 있다.
const { execFileSync } = require('child_process');

// 배포는 푸시 직후 바로 만들어지지 않는다. 빌드까지 몇 분 걸리므로 넉넉히 기다린다.
const TIMEOUT_MS = Number(process.env.DEPLOY_WAIT_MS || 12 * 60 * 1000);
const POLL_MS = Number(process.env.DEPLOY_POLL_MS || 15000);
// 배포가 아예 안 만들어지는 경우도 있다(Vercel 연동이 끊겼거나 무시 규칙에 걸렸을 때).
// 그때는 "실패"가 아니라 "안 올라갔다"라고 말해야 한다 — 원인이 다르고 할 일도 다르다.
const CREATE_GRACE_MS = Number(process.env.DEPLOY_CREATE_GRACE_MS || 3 * 60 * 1000);

const sha = process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const repo = process.env.GITHUB_REPOSITORY || '';

function api(pathname) {
  // gh CLI를 쓴다 — 워크플로에 이미 있고, 인증을 우리가 다룰 필요가 없다.
  const args = ['api', pathname, '--cache', '0s'];
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '' },
  });
  return JSON.parse(out);
}

const base = repo ? `repos/${repo}` : 'repos/{owner}/{repo}';

function listDeployments() {
  try {
    return api(`${base}/deployments?sha=${sha}&per_page=20`);
  } catch (e) {
    // 조회 자체가 안 되면 판단할 근거가 없다. 배포가 실패했다고 단정하지 않는다 —
    // 없는 사고를 알리면 다음부터 아무도 안 본다.
    console.log(`배포 목록을 읽지 못했습니다(판단 보류): ${String(e.message).split('\n')[0]}`);
    return null;
  }
}

function latestState(deploymentId) {
  try {
    const rows = api(`${base}/deployments/${deploymentId}/statuses?per_page=10`);
    // 최신 상태가 앞에 온다.
    const row = rows[0];
    return row ? { state: row.state, url: row.environment_url || row.target_url || null } : null;
  } catch (e) {
    return null;
  }
}

const DONE = new Set(['success', 'failure', 'error']);

(async () => {
  console.log(`커밋 ${sha.slice(0, 7)} 의 배포를 확인합니다.`);
  const started = Date.now();
  let sawAny = false;

  for (;;) {
    const deployments = listDeployments();
    if (deployments === null) process.exit(0); // 판단 보류 — 워크플로를 실패로 만들지 않는다

    if (deployments.length) sawAny = true;

    const results = deployments.map((d) => ({
      id: d.id,
      env: d.environment || '-',
      ...(latestState(d.id) || { state: 'pending', url: null }),
    }));

    const pending = results.filter((r) => !DONE.has(r.state));
    const bad = results.filter((r) => r.state === 'failure' || r.state === 'error');

    if (results.length && !pending.length) {
      results.forEach((r) => console.log(`  ${r.state === 'success' ? '✅' : '❌'} ${r.env} — ${r.state}${r.url ? ` (${r.url})` : ''}`));
      if (bad.length) {
        console.log(`\n배포 ${bad.length}건이 실패했습니다. **프로덕션은 이전 코드에 그대로 있습니다.**`);
        console.log('이 커밋의 변경은 아직 반영되지 않았습니다 — 저장소만 보면 끝난 것처럼 보이는 상태입니다.');
        process.exit(1);
      }
      console.log('\n프로덕션에 반영되었습니다.');
      process.exit(0);
    }

    const elapsed = Date.now() - started;
    // 배포가 아예 안 만들어졌다 — 연동이 끊겼거나 무시 규칙에 걸렸다.
    if (!sawAny && elapsed > CREATE_GRACE_MS) {
      console.log(`\n${Math.round(elapsed / 1000)}초 동안 이 커밋의 배포가 만들어지지 않았습니다.`);
      console.log('Vercel GitHub 연동이 끊겼거나 배포 무시 규칙에 걸렸을 수 있습니다.');
      process.exit(1);
    }
    if (elapsed > TIMEOUT_MS) {
      console.log(`\n${Math.round(elapsed / 60000)}분을 기다렸지만 배포가 끝나지 않았습니다(${pending.map((r) => `${r.env}=${r.state}`).join(', ')}).`);
      console.log('빌드가 매달렸을 수 있습니다 — Vercel 대시보드를 확인해주세요.');
      process.exit(1);
    }

    if (results.length) {
      console.log(`  대기 중: ${pending.map((r) => `${r.env}=${r.state}`).join(', ')} (${Math.round(elapsed / 1000)}초)`);
    } else {
      console.log(`  배포가 아직 만들어지지 않았습니다 (${Math.round(elapsed / 1000)}초)`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
})();
