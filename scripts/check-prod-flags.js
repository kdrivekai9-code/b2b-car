// 프로덕션이 어느 화면을 Next로 서비스하는지 실제로 찍어본다.
//
// 왜 필요한가: Vercel 환경변수는 대시보드를 열어야 보이고, 열어서 값을 봐도 "지금 실제로
// 무엇이 서비스되는지"는 알 수 없다 — env는 배포 단위로 굳으므로 값을 바꿔도 재배포 전에는
// 반영되지 않는다. 그래서 값이 아니라 **응답**을 본다.
//
// 판별 근거는 Vercel의 x-matched-path 헤더다. 프록시가 toExpress()로 보내면 /api/index로
// 리라이트되므로 그대로 드러난다. 로그인이 필요 없다 — 비로그인 요청도 프록시는 똑같이
// 판정한다(src/proxy.js는 쿠키를 보지 않는다).
//
// 쓰는 법:
//   node scripts/check-prod-flags.js                       (기본 도메인)
//   node scripts/check-prod-flags.js https://<다른도메인>
//
// 플래그를 단계적으로 켤 때 각 단계 뒤에 이걸 돌리면, 의도한 경로만 넘어갔는지 바로 보인다.
const BASE = (process.argv[2] || 'https://b2bcarkr.vercel.app').replace(/\/$/, '');

// 경로와 그것을 켜는 플래그. src/proxy.js의 PATH_FLAGS와 맞춰야 한다 —
// check-proxy-named-paths가 프록시 쪽 정합성을 보고, 여기는 "실제로 그렇게 서비스되나"를 본다.
const TARGETS = [
  ['/', 'NEXT_STAGE1_DASHBOARD_ENABLED'],
  ['/orders', 'NEXT_STAGE1_ORDERS_ENABLED'],
  ['/orders/new', 'NEXT_STAGE2_ORDER_FORM_ENABLED'],
  ['/orders/ai-intake', 'NEXT_STAGE3_AI_INTAKE_ENABLED'],
  ['/inquiries', 'NEXT_STAGE1_INQUIRIES_ENABLED'],
  ['/chat/sessions', 'NEXT_STAGE3_CHAT_CARDS_ENABLED'],
  ['/chat/guide', 'NEXT_CHAT_GUIDE_ENABLED'],
  ['/login', 'NEXT_LOGIN_ENABLED'],
  ['/notices', 'NEXT_NOTICES_ENABLED'],
  ['/faq', 'NEXT_FAQ_ENABLED'],
  ['/branches', 'NEXT_BRANCHES_ENABLED'],
  ['/groups', 'NEXT_GROUPS_ENABLED'],
  ['/users', 'NEXT_USERS_ENABLED'],
  ['/drivers', 'NEXT_DRIVERS_ENABLED'],
  ['/settings', 'NEXT_SETTINGS_ENABLED'],
  ['/knowledge-base', 'NEXT_KNOWLEDGE_BASE_ENABLED'],
  ['/location-aliases', 'NEXT_LOCATION_ALIASES_ENABLED'],
  ['/ferry-fares', 'NEXT_FERRY_FARES_ENABLED'],
  ['/push/settings', 'NEXT_PUSH_SETTINGS_ENABLED'],
  ['/access-logs', 'NEXT_ACCESS_LOGS_ENABLED'],
];

async function probe(path) {
  try {
    // **GET이어야 한다.** 처음에 HEAD를 썼는데, src/proxy.js 첫 줄이 GET이 아닌 요청을
    // 플래그와 무관하게 전부 Express로 보낸다(비-GET을 Next 라우터에 넘기면 메서드를
    // 구분하지 않고 페이지를 렌더링해 요청 바디가 무시되기 때문이다).
    //
    // 그래서 이 도구가 **무엇을 켜도 항상 EJS라고 답했다.** 그 잘못된 출력을 근거로
    // "프로덕션이 전부 EJS"라고 결론 내렸고, 문서 세 곳에 그렇게 적기까지 했다.
    // 측정 도구가 틀리면 그 위에 쌓은 판단이 전부 틀린다 — 도구부터 의심해야 했다.
    const res = await fetch(BASE + path, { method: 'GET', redirect: 'manual' });
    const matched = res.headers.get('x-matched-path') || '';
    if (!matched) return { ui: '?', detail: `x-matched-path 없음(HTTP ${res.status})` };
    // /api/index = Express로 리라이트된 것. 그 밖이면 Next 라우트가 잡았다.
    return { ui: matched === '/api/index' ? 'EJS' : 'Next', detail: matched };
  } catch (e) {
    return { ui: '?', detail: String(e.message).slice(0, 40) };
  }
}

(async () => {
  console.log(`대상: ${BASE}\n`);
  const results = await Promise.all(TARGETS.map(async ([path, flag]) => {
    const r = await probe(path);
    return { path, flag, ...r };
  }));

  let next = 0;
  let ejs = 0;
  let unknown = 0;
  results.forEach((r) => {
    if (r.ui === 'Next') next += 1;
    else if (r.ui === 'EJS') ejs += 1;
    else unknown += 1;
    const mark = r.ui === 'Next' ? 'Next' : (r.ui === 'EJS' ? 'EJS ' : '??  ');
    console.log(`  ${mark}  ${r.path.padEnd(20)} ${r.flag}`);
  });

  console.log(`\nNext ${next}개 · EJS ${ejs}개${unknown ? ` · 판정불가 ${unknown}개` : ''}`);
  if (!next) {
    console.log('\n한 경로도 Next로 안 갑니다. 세 가지를 차례로 보세요.');
    console.log('  1. 이 도구가 GET으로 찍는지(비-GET은 프록시가 전부 Express로 보낸다 — 실제로 이걸로 틀렸다)');
    console.log('  2. Vercel → Settings → Environment Variables 의 **Production** 범위와 값(소문자 true)');
    console.log('  3. 값을 넣은 뒤 **재배포**했는지(환경변수는 배포 단위로 굳는다)');
  }
  // 이 스크립트는 진단 도구다 — 결과가 어떻든 실패로 끝내지 않는다. 배포를 막을 근거가 아니다.
  process.exit(0);
})();
