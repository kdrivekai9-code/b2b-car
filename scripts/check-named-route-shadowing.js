// 이름 있는 경로가 `:id` 패턴에 가려지지 않는지 본다 — Express 라우터 안에서.
//
// 무엇을 막나(2026-09-11 실사고): `/orders/team-feed/data.json`을 `/orders/:id` 바로 앞에
// 등록했는데, 그것만으로는 부족했다. `/:id/data.json`이 **더 앞에** 있어서 id="team-feed"로
// 먼저 잡혔고, 오더 조회가 터져 화면이 "오류가 발생했습니다"만 보여줬다. 프로덕션은 서버
// 컴포넌트의 실제 메시지를 감추므로(React #441) 원인을 찾는 데 시간이 걸렸다.
//
// 이 저장소는 같은 함정을 이미 두 번 겪고 주석에 적어뒀다 — 프록시 쪽(`/orders/ai-intake`가
// `/orders/:id`에 먹혀 플래그가 무효였다)과 라우터 쪽(`/team-feed`가 오더 id로 읽혔다).
// 그때마다 **한 세그먼트만** 생각했는데, `/:id/무엇이든`도 똑같이 가로챈다.
//
// 어떻게 보나: 각 라우터의 GET 경로를 등록 순서대로 읽어, 뒤에 있는 "이름 있는 경로"가 앞의
// `:param` 패턴에 매치되면 잡는다. Express 라우터를 실제로 불러 정규식으로 판정하므로
// 패턴 해석을 우리가 흉내 내지 않는다.
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// 라우터를 가진 모듈들. 서브 라우터(myRouter 등)도 함께 본다.
const MODULES = [
  ['orders', 'routes/orders'],
  ['groups', 'routes/groups'],
  ['branches', 'routes/branches'],
  ['users', 'routes/users'],
  ['drivers', 'routes/drivers'],
  ['inquiries', 'routes/inquiries'],
  ['notices', 'routes/notices'],
  ['photoDelivery', 'routes/photoDelivery'],
  ['quickReplies', 'routes/quickReplies'],
  ['vehicleModels', 'routes/vehicleModels'],
  ['kakaoAccounts', 'routes/kakaoAccounts'],
  ['knowledgeBase', 'routes/knowledgeBase'],
  ['locationAliases', 'routes/locationAliases'],
];

// 경로에 :param이 없으면 "이름 있는 경로"다 — 이런 경로는 자기보다 앞선 :param 패턴에
// 가려지면 절대 실행되지 않는다.
const isNamed = (p) => !p.includes(':');

for (const [label, mod] of MODULES) {
  let exported;
  try { exported = require(path.join(ROOT, mod)); } catch (e) {
    check(`${label}: 라우터를 읽었다`, false, e.message);
    continue;
  }
  // 기본 내보내기와 서브 라우터(.router / .myRouter / .cronRouter) 모두 본다.
  const routers = [];
  if (exported && exported.stack) routers.push([label, exported]);
  for (const key of Object.keys(exported || {})) {
    const v = exported[key];
    if (v && v.stack && Array.isArray(v.stack)) routers.push([`${label}.${key}`, v]);
  }
  if (!routers.length) { check(`${label}: 라우터를 찾았다`, false, '스택이 없다'); continue; }

  for (const [name, router] of routers) {
    const layers = router.stack.filter((l) => l.route);
    const shadowed = [];
    for (let i = 0; i < layers.length; i++) {
      const p = layers[i].route.path;
      if (!isNamed(p)) continue;
      // 자기보다 앞에 등록된 :param 패턴 중 이 경로를 잡는 것이 있나
      for (let j = 0; j < i; j++) {
        const earlier = layers[j].route.path;
        if (!earlier.includes(':')) continue;
        // 같은 메서드끼리만 본다 — GET 경로를 POST 패턴이 가리지는 않는다.
        const sameMethod = Object.keys(layers[i].route.methods)
          .some((m) => layers[j].route.methods[m]);
        if (!sameMethod) continue;
        if (layers[j].regexp.test(p)) {
          shadowed.push(`${p} ← ${earlier} (${j}번이 ${i}번보다 앞)`);
          break;
        }
      }
    }
    check(`${name}: 가려진 경로가 없다`, shadowed.length === 0,
      shadowed.join('\n       ') + '\n       이름 있는 경로를 :param 패턴보다 먼저 등록할 것');
  }
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
