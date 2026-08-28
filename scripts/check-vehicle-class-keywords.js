// 운영자가 더한 판정 낱말이 실제 요금 계산까지 닿는지, 그리고 바닥(코드 사전)을 무너뜨리지 않는지.
//
// 왜 만들었나: 판정 사전이 코드에만 있어서, 빠진 브랜드를 발견해도(쿠프라 · DS · 볼보 EX30 …)
// 운영자가 손쓸 방법이 없고 배포를 기다려야 했다. 그동안 그 차종에는 할증이 안 붙는다 —
// 요금이 **적게** 나가는 쪽이라 고객은 항의하지 않고 정산할 때까지 아무도 모른다.
//
// 그렇다고 사전을 통째로 DB로 옮기지는 않았다. 옮기면 표가 비었을 때(마이그레이션 누락, 신규
// 환경) 모든 차가 국산·일반으로 떨어져 할증이 통째로 사라진다. 그래서 **더하기만** 한다.
// 이 검사의 핵심은 그 두 가지다: 더한 게 닿는가, 그리고 바닥이 그대로인가.
require('dotenv').config();
const db = require('../db');
const { classifyVehicleModel, KEYWORD_KINDS, BUILT_IN } = require('../lib/vehicleClass');
const vehicleModels = require('../lib/vehicleModels');

const MARK = 'chk쿠프라';
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

async function cleanup() {
  await db.run('DELETE FROM vehicle_class_keywords WHERE word LIKE ?', [`${MARK}%`]).catch(() => {});
  vehicleModels.clearKeywordCache();
}

(async () => {
  try {
    await cleanup();

    console.log('[코드 사전이 바닥을 받친다]');
    // DB를 아예 안 본 판정. 이게 무너지면 표가 비었을 때 할증이 통째로 사라진다.
    check('추가 낱말 없이도 벤츠는 수입', classifyVehicleModel('벤츠 E250').isImported, true);
    check('추가 낱말 없이도 EV6는 전기', classifyVehicleModel('EV6').isEv, true);
    check('빈 추가목록을 줘도 그대로', classifyVehicleModel('벤츠 E250', {}).isImported, true);
    check('모르는 이름은 여전히 모른다', classifyVehicleModel(`${MARK} 포맨터`).isImported, false);

    console.log('[더한 낱말이 판정에 반영된다]');
    check('추가 전', classifyVehicleModel(`${MARK} 포맨터`).isImported, false);
    check('추가 후', classifyVehicleModel(`${MARK} 포맨터`, { import_brand: [MARK] }).isImported, true);
    // 판정 근거를 남겨야 화면에서 "왜 붙었나"를 설명할 수 있다.
    check('근거에 그 낱말이 남는다',
      classifyVehicleModel(`${MARK} 포맨터`, { import_brand: [MARK] }).reasons.join(',').includes(MARK), true);

    console.log('[DB에 넣으면 요금 경로까지 닿는다]');
    // 여기가 이 기능의 전부다 — 화면에서 추가한 낱말이 flagsForVehicleType(요금 계산이 부르는
    // 함수)까지 오지 않으면 아무 의미가 없다.
    const before = await vehicleModels.flagsForVehicleType(`${MARK} 포맨터`);
    check('넣기 전에는 국산·일반', [before.isImported, before.source], [false, 'auto']);

    await db.run('INSERT INTO vehicle_class_keywords (kind, word) VALUES (?, ?)', ['import_brand', MARK]);
    // 캐시를 비우지 않으면 최대 60초 옛 값이 나온다 — 화면도 저장 직후 비운다.
    vehicleModels.clearKeywordCache();

    const after = await vehicleModels.flagsForVehicleType(`${MARK} 포맨터`);
    check('넣은 뒤에는 수입차', after.isImported, true);
    // 등록된 차종(vehicle_models)이 아니라 사전으로 잡힌 것이므로 auto가 맞다.
    check('출처는 자동 판정', after.source, 'auto');

    console.log('[캐시가 붙어 있다 — 요금 경로가 매번 표를 읽으면 안 된다]');
    const keywords = await vehicleModels.loadExtraKeywords();
    check('묶음이 다 있다', Object.keys(keywords).sort(), KEYWORD_KINDS.slice().sort());
    check('넣은 낱말이 그 묶음에 있다', (keywords.import_brand || []).includes(MARK), true);
    // 두 번째 호출은 캐시라 같은 객체여야 한다(새로 읽으면 다른 객체가 온다).
    check('두 번째 호출은 캐시', (await vehicleModels.loadExtraKeywords()) === keywords, true);
    vehicleModels.clearKeywordCache();
    check('비우면 다시 읽는다', (await vehicleModels.loadExtraKeywords()) !== keywords, true);

    console.log('[더하기만 한다 — 코드 사전을 덮어쓰지 않는다]');
    // 운영자가 넣은 낱말이 코드 사전을 밀어내면, 잘못 넣은 한 줄로 기존 판정이 통째로 무너진다.
    const merged = classifyVehicleModel('벤츠 E250', { import_brand: [MARK] });
    check('기존 브랜드도 그대로 잡힌다', merged.isImported, true);
    check('코드 사전 배열은 그대로', BUILT_IN.import_brand.includes(MARK), false);

    console.log('[표가 없어도 죽지 않는다]');
    // 마이그레이션 전 환경에서도 코드 사전만으로 접수가 돌아야 한다.
    const origAll = db.all;
    db.all = async (sql, params) => {
      if (/vehicle_class_keywords/.test(sql)) {
        const e = new Error('relation "vehicle_class_keywords" does not exist');
        e.code = '42P01';
        throw e;
      }
      return origAll(sql, params);
    };
    vehicleModels.clearKeywordCache();
    const fallback = await vehicleModels.flagsForVehicleType('벤츠 E250');
    db.all = origAll;
    vehicleModels.clearKeywordCache();
    check('표가 없어도 벤츠는 수입', fallback.isImported, true);
  } finally {
    await cleanup();
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
