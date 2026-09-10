// 지사 탁송 요금 화면의 **폼 칸 이름**이 EJS와 Next에서 같은지 본다.
//
// 무엇을 막나: 이 화면은 한 폼에 수십 칸이 들어 있고, 저장 라우트는 안 온 칸을 "비웠다"로
// 다룬다. 그래서 이식하면서 칸 하나를 빠뜨리면 **그 화면으로 저장할 때마다 그 설정이 조용히
// 지워진다** — 화면에 없으니 눈으로는 안 보이고, 다음에 요금을 계산할 때 금액이 달라진다.
// EJS 파티셜 머리말이 같은 사고를 이미 적어두고 있다("한쪽에만 항목을 늘리면 그 화면으로
// 저장할 때 다른 쪽 설정이 조용히 지워진다").
//
// 이관이 끝나 EJS 쪽이 지워지면 이 검사도 함께 지운다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// 파일이 없으면 빈 문자열로 본다 — 없는 것 자체는 아래 검사가 사유와 함께 보고해야 한다.
// 여기서 던지면 검사가 통째로 죽어서 "무엇이 잘못됐는지"가 안 남는다(음성 시험에서 그랬다).
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; }
};

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

// EJS: name="foo" / name="<%= g.keys.threshold %>" 같은 동적 이름은 서버 상수에서 온다.
function ejsNames(files) {
  const out = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/name="([a-z_]+)"/g)) out.add(m[1]);
  }
  return out;
}
// Next 쪽은 칸 이름을 **간접적으로** 넘기는 자리가 많다:
//   name={c.name}     열 정의 배열(COLUMNS)에서 온다
//   name={nameKey}    부품에 prop으로 넘긴다
//   name={g.keys.wait} 서버 상수에서 온다
// 그래서 `name="..."`만 찾으면 멀쩡한 칸을 "빠졌다"고 잡는다(처음에 실제로 그랬다).
// 이름이 그 파일들 어딘가에 **문자열로 존재하는지**를 본다 — "통째로 빠뜨렸다"를 잡는 것이
// 이 검사의 목적이고, 그건 이 방식으로 충분히 걸린다.
function nextHasName(files, name) {
  const re = new RegExp(`['"\`]${name}['"\`]`);
  return files.some((f) => re.test(read(f)));
}
// 반대 방향(Next에만 있는 칸)은 **화면에 직접 적힌 것**만 본다 — 부품이 조건부로 그리는 칸
// (비고 등)까지 세면 이 화면에 안 나오는 것을 잡게 된다.
function nextLiteralNames(files) {
  const out = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/name="([a-z_]+)"/g)) out.add(m[1]);
  }
  return out;
}

const EJS_FILES = [
  'views/branches/fare_rules.ejs',
  'views/partials/fare_surcharge_settings.ejs',
  'views/partials/order_type_trip_fees.ejs',
];
const NEXT_FILES = [
  'src/app/branches/[id]/fare-rules/page.js',
  'src/app/_components/FareSurchargeSettings.js',
  'src/app/_components/OrderTypeTripFees.js',
  'src/app/branches/_components/DistanceTierTable.js',
];

console.log('[부품이 제자리에 있다]');
// 지사·법인이 각자 사본을 들면 한쪽만 고쳐 갈라진다 — EJS가 파티셜을 쓰는 이유다.
// 이 검사를 맨 앞에 둔다: 파일이 없으면 아래 칸 대조가 전부 "빠졌다"로 나와 원인이 묻힌다.
for (const [label, f] of [['할증·부대비용', 'src/app/_components/FareSurchargeSettings.js'],
  ['오더구분별 요금', 'src/app/_components/OrderTypeTripFees.js'],
  ['거리 구간표', 'src/app/branches/_components/DistanceTierTable.js']]) {
  check(`${label} 부품이 있다`, fs.existsSync(path.join(ROOT, f)),
    `${f}가 없다 — 지사 전용 폴더로 옮기면 법인 화면이 사본을 만들게 된다`);
}

const ejs = ejsNames(EJS_FILES);
const nextLiteral = nextLiteralNames(NEXT_FILES);

console.log('\n[탁송 요금 폼의 칸이 두 화면에서 같다]');
check('EJS 칸을 읽었다', ejs.size > 10, `${ejs.size}개`);

const missing = [...ejs].filter((n) => !nextHasName(NEXT_FILES, n));
check('EJS에 있는 칸이 Next에도 다 있다', missing.length === 0,
  `빠진 칸: ${missing.join(', ')}\n       저장하면 이 설정이 지워진다(라우트가 안 온 칸을 비웠다로 다룬다)`);

// 이 화면에 직접 적힌 칸 중 EJS에 없는 것 — 저장 라우트가 모르는 값을 보내게 된다.
//
// 구간표 부품(DistanceTierTable)은 화면마다 켜는 열이 다르다(비고는 프리미엄 편도 요금
// 화면에서만 켠다) — 그 파일의 칸까지 세면 이 화면에 나오지도 않는 열을 잡는다.
const extra = [...nextLiteralNames(NEXT_FILES.filter((f) => !/DistanceTierTable/.test(f)))]
  .filter((n) => !ejs.has(n));
check('Next에만 있는 칸이 없다', extra.length === 0, extra.join(', '));

console.log('\n[오더구분별 요금 칸은 서버 상수에서 온다]');
// 화면에 필드명을 또 적으면 컬럼이 늘 때 한쪽만 바뀐다.
const tripFeesNext = read('src/app/_components/OrderTypeTripFees.js');
check('Next가 서버가 준 키를 쓴다', /g\.keys\.(threshold|wait|before|after)/.test(tripFeesNext));
check('Next가 필드명을 박아두지 않았다',
  !/name="(premium|daily_driver)_/.test(tripFeesNext));
// 서버 상수가 실제로 그 네 키를 준다.
const { ORDER_TYPE_FEE_GROUPS } = require(path.join(ROOT, 'lib/tripFees'));
check('서버 상수에 네 키가 다 있다',
  ORDER_TYPE_FEE_GROUPS.every((g) => ['threshold', 'wait', 'before', 'after'].every((k) => g.keys[k])),
  JSON.stringify(ORDER_TYPE_FEE_GROUPS.map((g) => Object.keys(g.keys))));

console.log('\n[행 추가가 앞 행을 복제하지 않는다]');
// 복제하면 앞 행의 값이 딸려와, 지우는 걸 잊으면 의도치 않은 할증이 하나 더 저장된다.
const surcharge = read('src/app/_components/FareSurchargeSettings.js');
check('빈 행을 만든다', /name: '', fee: 0/.test(surcharge));
check('금액 0인 특수구간을 경고한다', /청구되지 않습니다/.test(surcharge));
// 값이 없는 대형 차종 칸에 0을 넣으면 "안 받음"으로 저장돼 뜻이 뒤집힌다.
check('차종별 금액 빈 칸을 0으로 채우지 않는다', /saved === undefined \? '' : saved/.test(surcharge));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
