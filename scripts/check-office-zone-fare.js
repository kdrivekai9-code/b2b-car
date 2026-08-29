// 지점 구간요금이 거리 구간표보다 먼저 적용되는지, 그리고 엉뚱한 오더에 붙지 않는지.
//
// 계약이 "강남지점 ↔ 서울 강남구 = 20,000원"처럼 표로 맺어지는 경우가 많다(첨부 단가표).
// 거리로 환산하면 계약서와 금액이 어긋나므로, 이 표가 있으면 거리 구간표를 건너뛴다.
//
// 이 표에 든 금액은 그대로 청구된다. 그래서 양쪽이 다 위험하다.
//  · 안 붙으면 → 계약과 다른(대개 더 비싼) 거리 요금이 나간다.
//  · 엉뚱하게 붙으면 → 관계없는 오더가 계약 단가로 청구된다.
// 특히 지점 판정은 좌표 반경으로 하므로, 반경 밖까지 붙으면 옆 건물 오더가 딸려온다.
require('dotenv').config();
const db = require('../db');
const ozf = require('../lib/officeZoneFare');
const zoneGeocode = require('../lib/zoneGeocode');

const MARK = 'chk-office';
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

// 강남역 부근을 지점으로 쓴다.
const OFFICE = { lat: 37.4979, lon: 127.0276 };

async function cleanup() {
  const rows = await db.all('SELECT id FROM group_branch_offices WHERE name LIKE ?', [`${MARK}%`]).catch(() => []);
  for (const r of rows) {
    await db.run('DELETE FROM group_office_zone_fares WHERE office_id = ?', [r.id]).catch(() => {});
    await db.run('DELETE FROM group_branch_offices WHERE id = ?', [r.id]).catch(() => {});
  }
}

(async () => {
  try {
    console.log('[표기 정규화 — orders와 같은 규칙이어야 매칭이 된다]');
    // 엑셀에는 "서울특별시"라고 적히지만 orders에는 "서울"로 저장된다.
    check('시도 약어', ozf.normSido('서울특별시'), '서울');
    check('강원특별자치도', ozf.normSido('강원특별자치도'), '강원');
    check('이미 약어면 그대로', ozf.normSido('경기'), '경기');
    check('시군구 붙여쓰기', ozf.normSigugun('성남시 분당구'), '성남시분당구');

    console.log('[지역 매칭 — 계약표는 "성남시"까지만 적는 일이 흔하다]');
    check('정확히 같으면 맞다', ozf.zoneMatches('강남구', '강남구'), true);
    // orders는 시+구를 붙여 저장하는데(성남시분당구) 계약표는 시까지만 적는다.
    check('시까지만 적힌 표가 시+구 오더에 맞는다', ozf.zoneMatches('성남시', '성남시분당구'), true);
    // 반대로 구만 적힌 표가 다른 시의 같은 구에 걸리면 안 된다.
    check('구만 적힌 표는 시+구에 안 맞는다', ozf.zoneMatches('분당구', '성남시분당구'), false);
    check('다른 지역', ozf.zoneMatches('강남구', '강동구'), false);
    check('빈 값', ozf.zoneMatches('', '강남구'), false);

    console.log('[지점 판정 — 좌표 반경]');
    const offices = [{ id: 1, name: 'A', lat: OFFICE.lat, lon: OFFICE.lon }];
    check('같은 좌표면 그 지점', !!ozf.nearestOffice(offices, OFFICE.lat, OFFICE.lon), true);
    // 약 200m 떨어진 곳(같은 부지의 후문 정도) — 지점으로 봐야 한다.
    check('200m는 같은 지점', !!ozf.nearestOffice(offices, OFFICE.lat + 0.0018, OFFICE.lon), true);
    // 약 2km — 옆 동네다. 여기까지 붙으면 관계없는 오더가 계약 단가로 청구된다.
    check('2km는 다른 곳', !!ozf.nearestOffice(offices, OFFICE.lat + 0.018, OFFICE.lon), false);
    check('좌표가 없으면 판정하지 않는다', ozf.nearestOffice(offices, null, null), null);

    await cleanup();
    const group = await db.get('SELECT id FROM groups_tbl ORDER BY id LIMIT 1');
    if (!group) {
      console.log('  (건너뜀 — 법인 표본이 없습니다)');
      console.log('\n모두 통과');
      process.exit(0);
    }

    const officeRow = await db.get(
      `INSERT INTO group_branch_offices (group_id, name, address, lat, lon, sido, sigugun)
       VALUES (?, ?, '서울 강남구 검사로 1', ?, ?, '서울', '강남구') RETURNING id`,
      [group.id, `${MARK}-강남지점`, OFFICE.lat, OFFICE.lon]
    );
    const officeId = Number(officeRow.id);
    await db.run(
      `INSERT INTO group_office_zone_fares (office_id, sido, sigugun, fare, distance_km)
       VALUES (?, '서울', '강동구', 30000, 12.3), (?, '경기', '수원시', 45000, 31.5)`,
      [officeId, officeId]
    );

    console.log('[출발지가 지점이면 도착지 지역 요금]');
    const a = await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon,
      destinationSido: '서울', destinationSigugun: '강동구',
    });
    check('요금', a && a.fare, 30000);
    check('어느 쪽이 지점이었는지 밝힌다', a && a.matchedSide, 'origin');

    console.log('[도착지가 지점이면 출발지 지역 요금]');
    const b = await ozf.findZoneFare(group.id, {
      destinationLat: OFFICE.lat, destinationLon: OFFICE.lon,
      originSido: '경기', originSigugun: '수원시',
    });
    check('요금', b && b.fare, 45000);
    check('밝힌 방향', b && b.matchedSide, 'destination');

    console.log('[엑셀 표기(서울특별시)로 물어도 찾는다]');
    const c = await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon,
      destinationSido: '서울특별시', destinationSigugun: '강동구',
    });
    check('약어로 바꿔 찾는다', c && c.fare, 30000);

    console.log('[계약표가 "수원시"까지만이어도 "수원시장안구" 오더에 맞는다]');
    const d = await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon,
      destinationSido: '경기', destinationSigugun: '수원시장안구',
    });
    check('접두사 매칭', d && d.fare, 45000);

    console.log('[붙지 않아야 하는 경우 — 여기가 새면 남의 오더가 계약 단가로 청구된다]');
    // 등록하지 않은 지역.
    check('등록 안 한 지역', await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon, destinationSido: '부산', destinationSigugun: '해운대구',
    }), null);
    // 지점에서 멀리 떨어진 오더.
    check('지점과 무관한 오더', await ozf.findZoneFare(group.id, {
      originLat: 35.1796, originLon: 129.0756, destinationSido: '서울', destinationSigugun: '강동구',
    }), null);
    // 좌표가 아예 없는 오더 — 주소 문자열만으로 지점을 단정하지 않는다.
    check('좌표가 없으면 붙지 않는다', await ozf.findZoneFare(group.id, {
      originSido: '서울', originSigugun: '강남구', destinationSido: '서울', destinationSigugun: '강동구',
    }), null);
    // 다른 법인의 계약표가 넘어오면 안 된다.
    check('다른 법인에는 안 붙는다', await ozf.findZoneFare(-1, {
      originLat: OFFICE.lat, originLon: OFFICE.lon, destinationSido: '서울', destinationSigugun: '강동구',
    }), null);

    console.log('[우선 적용을 끄면 표가 있어도 쓰지 않는다]');
    // 표를 등록해두고도 "이번 달은 거리로 계산하자"처럼 잠시 끌 수 있어야 한다(사용자 지시).
    // 끄면 거리 구간표로 돌아간다 — 줄을 지우지 않고도 되돌릴 수 있어야 한다.
    await db.run('UPDATE groups_tbl SET office_fare_enabled = false WHERE id = ?', [group.id]);
    check('꺼진 법인에는 붙지 않는다', await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon, destinationSido: '서울', destinationSigugun: '강동구',
    }), null);
    check('isEnabled가 false', await ozf.isEnabled(group.id), false);

    await db.run('UPDATE groups_tbl SET office_fare_enabled = true WHERE id = ?', [group.id]);
    check('다시 켜면 그대로 돌아온다', (await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon, destinationSido: '서울', destinationSigugun: '강동구',
    }) || {}).fare, 30000);

    console.log('[시군구가 없는 시도 — 세종]');
    // 세종은 하위 시군구가 없는 단층제라 우리 지오코더가 sigugun을 항상 빈 값으로 준다
    // (실측: 세종시청·보람동·조치원읍·정부청사 모두 ''). 시군구로만 찾으면 세종 오더는
    // 어떤 계약표에도 안 걸린다.
    await db.run(
      `INSERT INTO group_office_zone_fares (office_id, sido, sigugun, fare, distance_km)
       VALUES (?, '세종', '세종시', 80000, 128.4)`, [officeId]
    );
    const sejong = await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon,
      destinationSido: '세종', destinationSigugun: '',
    });
    check('시군구가 비어도 그 시도의 유일한 지역이면 쓴다', sejong && sejong.fare, 80000);

    // 그 시도에 지역이 둘이면 무엇을 고를지 알 수 없다 — 계약 금액이라 추측하면 안 된다.
    await db.run(
      `INSERT INTO group_office_zone_fares (office_id, sido, sigugun, fare)
       VALUES (?, '세종', '조치원읍', 75000)`, [officeId]
    );
    check('둘 이상이면 붙이지 않는다', await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon,
      destinationSido: '세종', destinationSigugun: '',
    }), null);
    await db.run("DELETE FROM group_office_zone_fares WHERE office_id = ? AND sigugun = '조치원읍'", [officeId]);

    // 시도조차 없으면 아무것도 못 한다.
    check('시도가 없으면 붙이지 않는다', await ozf.findZoneFare(group.id, {
      originLat: OFFICE.lat, originLon: OFFICE.lon,
      destinationSido: '', destinationSigugun: '',
    }), null);

    console.log('[거리 기준점 — 시는 시청, 군은 군청, 구는 구청]');
    check('구 → 구청', zoneGeocode.officeNameOf('강남구'), '강남구청');
    check('시 → 시청', zoneGeocode.officeNameOf('수원시'), '수원시청');
    check('군 → 군청', zoneGeocode.officeNameOf('양평군'), '양평군청');
    check('이미 청이면 그대로', zoneGeocode.officeNameOf('수원시청'), '수원시청');
    check('시+구는 구를 떼어낸다', zoneGeocode.splitSigugun('성남시분당구'), { city: '성남시', district: '분당구' });
    // 소수점 한 자리(사용자 지정) — 화면·엑셀·DB가 다른 자릿수를 보이면 안 된다.
    check('거리는 소수점 한 자리', zoneGeocode.roundKm(31.4567), 31.5);
    check('거리 없음', zoneGeocode.roundKm(''), null);
  } finally {
    await cleanup();
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
