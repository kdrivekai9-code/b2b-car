// 정산 화면이 EJS와 **같은 값**을 쓰는지 본다.
//
// 왜 이 화면만 따로 보나: 여기 숫자가 그대로 청구서에 찍힌다. 다른 화면은 값이 하나 빠지면
// 눈에 띄지만, 정산은 합계가 그럴듯하게 나와서 틀린 줄 모른다 — 예를 들어 대기요금 줄을
// 빠뜨려도 총액은 여전히 "얼마"로 보인다.
//
// 어떻게 보나: EJS가 읽는 데이터 필드(summary.x, extraSummary.x, r.x …)를 뽑아, Next 판이
// 그 필드를 하나도 빠짐없이 읽는지 대조한다. 값을 만드는 계산은 서버(loadSettlement) 한
// 곳이므로, "같은 필드를 읽는다"가 곧 "같은 숫자를 보여준다"에 가깝다.
//
// 이관이 끝나 EJS 쪽이 지워지면 이 검사도 함께 지운다.
//
// 파일만 읽는다 — CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; }
};

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const ejs = read('views/groups/settlement.ejs');
// 본문은 관리자용·고객용이 함께 쓰는 부품에 있다 — 화면 파일만 보면 전부 "빠졌다"로 나온다.
const NEXT_FILES = [
  'src/app/_components/settlement/SettlementView.js',
  'src/app/_components/settlement/SettlementActions.js',
  'src/app/_components/VehicleClassBadge.js',
  'src/app/groups/[id]/settlement/page.js',
  'src/app/my/settlement/page.js',
];
const next = NEXT_FILES.map(read).join('\n');

console.log('[정산 화면이 있다]');
check('EJS를 읽었다', ejs.length > 1000, `${ejs.length}자`);
check('Next 판을 읽었다', next.length > 1000, `${next.length}자`);

console.log('\n[EJS가 읽는 값을 Next도 읽는다]');
// summary.* / extraSummary.* — 합계 숫자들.
const OBJECTS = ['summary', 'extraSummary'];
for (const obj of OBJECTS) {
  const fields = new Set([...ejs.matchAll(new RegExp(`\\b${obj}\\.([a-zA-Z]+)`, 'g'))].map((m) => m[1]));
  const missing = [...fields].filter((f) => !new RegExp(`\\b${obj}\\.${f}\\b`).test(next));
  check(`${obj}의 값을 다 쓴다 (${fields.size}개)`, missing.length === 0,
    `빠진 값: ${missing.map((f) => `${obj}.${f}`).join(', ')} — 그만큼 화면에서 사라진다`);
}

// 오더 줄(r.*) — 요금 구성 요소가 빠지면 그 줄의 금액 설명이 사라진다.
const ROW_FIELDS = [
  'baseFare', 'waitFee', 'cancelFee', 'surchargeTotal', 'surcharges', 'total', 'ferry',
  'settled', 'settled_at', 'settled_by_name', 'wait_fee_note', 'cancel_fee_note',
  'reserved_date', 'reserved_time', 'vehicle_type', 'origin_address', 'destination_address',
];
const missingRow = ROW_FIELDS.filter((f) => new RegExp(`\\br\\.${f}\\b`).test(ejs) && !new RegExp(`\\br\\.${f}\\b`).test(next));
check(`오더 줄의 값을 다 쓴다 (${ROW_FIELDS.length}개 중)`, missingRow.length === 0,
  `빠진 값: ${missingRow.join(', ')}`);

// 기타정산 줄
const EXTRA_FIELDS = ['charged_on', 'vehicle_number', 'charge_type', 'settleMode', 'amount', 'derived', 'oid', 'note'];
const missingExtra = EXTRA_FIELDS.filter((f) => new RegExp(`\\br\\.${f}\\b`).test(ejs) && !new RegExp(`\\br\\.${f}\\b`).test(next));
check(`기타정산 줄의 값을 다 쓴다 (${EXTRA_FIELDS.length}개 중)`, missingExtra.length === 0,
  `빠진 값: ${missingExtra.join(', ')}`);

console.log('\n[금액 통계표의 줄이 그대로 있다]');
// 필드가 쓰였는지만 보면 부족하다 — 같은 필드가 다른 표에도 나오므로, 통계 줄 하나를 지워도
// "쓰였다"로 통과한다(음성 시험에서 실제로 그랬다). 이 표는 청구서로 그대로 옮겨 적는
// 자리라 줄 구성이 곧 계약이다. 라벨과 값 표현을 짝지어 본다.
const STAT_ROWS = [
  ['운행요금', 'summary.total'],
  ['└ 구간요금', 'summary.base'],
  ['└ 할증요금', 'summary.surcharge'],
  ['└ 대기요금', 'summary.wait'],
  ['└ 취소요금', 'summary.cancel'],
  ['기타 정산', 'extraSummary.total'],
  ['총 청구액', 'grandTotal'],
];
for (const [label, expr] of STAT_ROWS) {
  // **모든 등장 위치를 본다.** 첫 번째만 보면 다른 표의 같은 이름 머리글(예: 청구 주체별
  // 구분표의 "운행요금")이 먼저 잡혀 엉뚱한 자리를 검사한다(처음에 그렇게 틀렸다).
  let ok = false;
  for (let i = next.indexOf(`>${label}<`); i >= 0; i = next.indexOf(`>${label}<`, i + 1)) {
    if (next.slice(i, i + 200).includes(expr)) { ok = true; break; }
  }
  check(`통계 "${label}" 줄`, ok, `${expr}를 보여주는 줄이 없다`);
}
// EJS와 줄 수가 같은지도 본다 — 새 줄이 조용히 늘거나 줄면 청구서 구성이 갈린다.
const ejsStatRows = (ejs.match(/class="stat-(group|sub|total)"/g) || []).length;
const nextStatRows = (next.match(/className="stat-(group|sub|total)"/g) || []).length;
check('통계 줄 수가 같다', ejsStatRows === nextStatRows,
  `EJS ${ejsStatRows}줄 / Next ${nextStatRows}줄 — 기타정산 항목별 줄은 양쪽 다 반복문으로 만든다`);

console.log('\n[돈이 갈리는 분기가 같다]');
// 할증 표시 방식에 따라 운행요금 줄의 금액이 달라진다 — 이 계산이 EJS와 달라지면 청구가 틀린다.
check('줄 금액이 표시 방식으로 갈린다',
  /surchargeMode === 'itemized' \? r\.baseFare \+ r\.waitFee \+ r\.cancelFee : r\.total/.test(next),
  '포함 방식이면 총액, 별도 줄 방식이면 할증을 뺀 금액을 보여줘야 한다');
check('합계도 같은 규칙이다',
  /surchargeMode === 'itemized' \? summary\.base \+ summary\.wait \+ summary\.cancel : summary\.total/.test(next));
// 할증 표는 별도 줄 방식에서만 나온다 — 포함 방식에서 또 보이면 이중으로 읽힌다.
check('할증 표를 별도 줄 방식에서만 그린다',
  /surchargeMode === 'itemized' && summary\.surcharge > 0/.test(next));
// 개별정산은 총 청구액에 안 들어간다(건별 청구) — 그 구분이 화면에 남아야 한다.
check('개별정산을 따로 표시한다', /settleMode === 'individual'/.test(next));
check('개별정산이 총액에 빠진다는 것을 밝힌다', /총 청구액에 포함되지 않습니다/.test(next));
// 도선료 줄은 오더에서 파생돼 따로 확정하지 않는다 — 체크박스를 주면 눌러도 아무 일이 없다.
check('파생 줄에는 체크박스를 주지 않는다', /!r\.derived && <input type="checkbox"/.test(next));

console.log('\n[접근 통제가 서버에 있다]');
const routes = read('routes/groups.js');
const dataRoute = routes.slice(routes.indexOf("router.get('/:id/settlement/data.json'"), routes.indexOf("router.get('/:id/settlement'"));
// 자기 법인이 아니면 아예 막는다 — 목록만 좁히는 것으로는 부족하다(금액이 나오는 화면이다).
check('남의 법인 정산을 막는다', /Number\(me\.group_id\) !== Number\(req\.params\.id\)/.test(dataRoute));
check('개인 딜러는 본인 것만 본다', /meIsDealer \? me\.id :/.test(dataRoute));
// 화면 쪽에서 다시 판정하면 두 곳이 갈린다.
check('화면이 권한을 다시 판정하지 않는다', !/isDealer\(/.test(next));

console.log('\n[관리자용·고객용이 본문을 공유한다]');
// 두 화면은 같은 뷰다(EJS도 settlement.ejs 하나였다). 복사해두면 금액 표시를 고칠 때
// 한쪽만 바뀌고, 그건 곧 청구서가 갈리는 것이다.
check('본문 부품이 있다', fs.existsSync(path.join(ROOT, 'src/app/_components/settlement/SettlementView.js')));
for (const [label, f] of [['관리자용', 'src/app/groups/[id]/settlement/page.js'], ['고객용', 'src/app/my/settlement/page.js']]) {
  check(`${label} 화면이 그 부품을 쓴다`, /SettlementView/.test(read(f)));
  // 본문을 자기 파일에 다시 그리기 시작하면 갈린다.
  check(`${label} 화면에 본문 사본이 없다`, !/금액 통계/.test(read(f)));
}
// **고객 화면은 /my/settlement 경로를 써야 한다.**
//
// EJS 화면은 이 버튼들을 /groups/:id/... 로 걸어뒀는데 그 라우터는 통째로
// requireRole('admin')이라 고객이 누르면 403이었다(2026-09-10 확인). 2026-09-11에 고객 전용
// 경로를 열었으므로, 화면이 그쪽을 가리키는지 본다 — 다시 /groups/... 로 바뀌면 조용히
// 403으로 되돌아간다.
const my = read('src/app/my/settlement/page.js');
check('고객 화면에 내보내기 버튼이 있다', /ExcelLink|PrintButton/.test(my));
check('고객 화면이 /my/settlement 경로를 쓴다', /base="\/my\/settlement"/.test(my));
// 주석에는 그 경로를 설명하려고 적어둔 자리가 있다 — **코드 줄만 본다**(주석을 근거로 삼는
// 실수를 이 저장소에서 이미 두 번 했다).
const myCode = my.split('\n').filter((l) => !/^\s*(\/\/|\{\/\*|\*)/.test(l)).join('\n');
check('고객 화면이 /groups 경로를 쓰지 않는다', !/href=|base=|window\.open\(/.test(myCode) || !/['"`]\/groups\//.test(myCode),
  '그 경로는 admin 전용이라 고객이 누르면 403이다');

console.log('\n[내보내기 생성 코드가 한 벌이다]');
// 정산서는 청구 문서다 — 두 벌로 두면 같은 달의 서류가 서로 달라진다.
for (const [label, fn] of [['엑셀', 'writeSettlementExcel'], ['정산내역서', 'renderSettlementPrint'], ['건별 청구서', 'renderIndividualPrint']]) {
  const uses = (routes.match(new RegExp(`\\b${fn}\\(`, 'g')) || []).length;
  // 정의 1 + 관리자 호출 1 + 고객 호출 1 = 3
  check(`${label}: 관리자·고객이 같은 함수를 쓴다`, uses >= 3, `${fn} 등장 ${uses}회`);
}
// 고객 경로의 범위는 서버가 정해야 한다 — 주소창의 법인 id를 믿으면 남의 정산서가 나간다.
const myRoutes = routes.slice(routes.indexOf('async function loadMySettlement'));
check('고객 경로가 법인을 로그인 계정에서 정한다', /me\.group_id/.test(myRoutes)
  && !/req\.params\.id/.test(myRoutes.slice(0, myRoutes.indexOf('myRouter.get(\'/data.json\'')) || ''));
check('고객 경로가 개인 딜러 범위를 지킨다', /clientScope\.isDealer\(me\) \? me\.id/.test(myRoutes));

console.log('\n[조회 중인 달을 잃지 않는다]');
// 안 보내면 저장·처리 후 이번 달로 튕겨 보던 정산서를 잃는다.
for (const [label, form] of [['할증 표시 저장', 'surcharge-mode'], ['정산 처리', 'settle']]) {
  const idx = next.indexOf(`settlement/${form}`);
  check(`${label}이 월을 함께 보낸다`, idx >= 0 && /name="month" value=\{month\}/.test(next.slice(idx, idx + 400)));
}
// 인쇄·엑셀은 누르는 순간의 월을 읽어야 한다(조회를 안 눌러도 화면에 보이는 달이 나가야 한다).
check('인쇄·엑셀이 누를 때 월을 다시 읽는다', /function readMonth\(fallback\)/.test(next));

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
