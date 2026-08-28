// 지점별 구간요금 엑셀(가로형 교차표)을 법인 계약표로 적재한다.
//
// 화면의 업로더는 세로형(지점/시도/시군구/요금 한 줄씩)을 받는데, 실제 단가표는 가로형이다 —
// 행이 지역이고 지점이 옆으로 6열씩(분류 / 시도 / 시군구 / 요금 / km / 여백) 반복된다.
// 그 표를 사람이 세로로 펴서 올리게 하면 1,000줄 넘는 손작업이 되고 그 과정에서 숫자가 틀어진다.
//
// 사용:
//   node scripts/import-office-zone-fares.js <엑셀경로> --group=<법인id> [--dry] [--recompute-km]
//
//   --dry            무엇이 들어갈지 보여주기만 하고 저장하지 않는다.
//   --recompute-km   엑셀의 km를 무시하고 청사 기준으로 다시 계산한다(외부 API를 줄마다 부른다).
//                    기본은 엑셀 값을 그대로 쓴다 — 계약 당시 기준을 보존한다.
require('dotenv').config();
const path = require('path');
const db = require('../db');
const ExcelJS = require('exceljs');
const officeZoneFare = require('../lib/officeZoneFare');
const zoneGeocode = require('../lib/zoneGeocode');
const { routeDistance } = require('../lib/fareQuote');
const { lookupRegion } = require('../lib/kakaoRegion');

// 한 지점이 차지하는 열 수: 분류 / 시도 / 시군구 / 요금 / km / 여백
const BLOCK = 6;
const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
const groupId = Number((args.find((a) => a.startsWith('--group=')) || '').split('=')[1]);
const dryRun = args.includes('--dry');
const recomputeKm = args.includes('--recompute-km');

function cellValue(ws, r, c) {
  const v = ws.getRow(r).getCell(c).value;
  return v && typeof v === 'object' && 'result' in v ? v.result : v;
}

// "강남지점 출발&도착\n(서울 강남구 헌릉로745길 25)" → { name, address }
function parseOfficeTitle(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s*(?:출발\s*&\s*도착)?\s*\(([^)]+)\)\s*$/.exec(s);
  if (!m) return null;
  return { name: m[1].replace(/출발\s*&\s*도착/g, '').trim(), address: m[2].trim() };
}

async function geocode(query) {
  const key = process.env.KAKAO_REST_API_KEY;
  const call = async (kind) => {
    const url = `https://dapi.kakao.com/v2/local/search/${kind}.json?query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + key } });
    if (!res.ok) return null;
    const docs = (await res.json()).documents || [];
    if (!docs.length) return null;
    const d = docs[0];
    return {
      lat: Number(d.y),
      lon: Number(d.x),
      address: d.road_address ? d.road_address.address_name : (d.road_address_name || d.address_name),
    };
  };
  // 도로명 주소가 먼저다 — 상호 검색은 같은 이름의 다른 곳을 집을 수 있다.
  return (await call('address')) || (await call('keyword'));
}

(async () => {
  if (!filePath || !Number.isFinite(groupId)) {
    console.error('사용: node scripts/import-office-zone-fares.js <엑셀경로> --group=<법인id> [--dry] [--recompute-km]');
    process.exit(1);
  }
  const group = await db.get('SELECT id, name, branch_id FROM groups_tbl WHERE id = ?', [groupId]);
  if (!group) { console.error(`법인 ${groupId}을 찾을 수 없습니다.`); process.exit(1); }
  console.log(`대상 법인: ${group.name} (id=${group.id})`);
  console.log(`파일: ${path.resolve(filePath)}`);
  console.log(`거리: ${recomputeKm ? '청사 기준으로 재계산' : '엑셀 값 그대로'}${dryRun ? ' · 미리보기(저장 안 함)' : ''}\n`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];

  // 지역 표기 교정은 지역마다 외부 조회가 들어간다 — 지점 8곳이 같은 지역을 공유하므로
  // (시도,시군구)로 한 번만 본다. 이게 없으면 같은 조회를 8번 반복한다.
  const regionCache = new Map();
  async function resolveRegion(sido, sigugun) {
    const key = `${sido}|${sigugun}`;
    if (!regionCache.has(key)) regionCache.set(key, await zoneGeocode.resolveZoneRegion(sido, sigugun));
    return regionCache.get(key);
  }

  const summary = [];
  let totalRows = 0;
  let corrected = 0;

  for (let b = 0; b * BLOCK + 1 <= ws.columnCount; b += 1) {
    const c0 = b * BLOCK + 1; // 분류
    const title = parseOfficeTitle(cellValue(ws, HEADER_ROW, c0 + 1));
    if (!title || !title.name) continue;

    const geo = await geocode(title.address);
    if (!geo) {
      console.error(`✗ ${title.name}: 주소 좌표를 찾지 못했습니다 — ${title.address}`);
      console.error('  좌표가 없으면 지점을 알아볼 수 없어 이 지점은 건너뜁니다.');
      continue;
    }
    const officeRegion = await lookupRegion(geo.lat, geo.lon).catch(() => null);

    // 요금 줄을 먼저 다 읽는다 — 읽는 도중 실패하면 절반만 들어간 표가 남는다.
    const zones = [];
    for (let r = FIRST_DATA_ROW; r <= ws.rowCount; r += 1) {
      const sidoRaw = cellValue(ws, r, c0 + 1);
      const sigugunRaw = cellValue(ws, r, c0 + 2);
      const fareRaw = cellValue(ws, r, c0 + 3);
      const kmRaw = cellValue(ws, r, c0 + 4);
      const sigugun = officeZoneFare.normSigugun(sigugunRaw);
      if (!sigugun) continue;
      const fare = Math.round(Number(String(fareRaw == null ? '' : fareRaw).replace(/[^0-9.]/g, '')));
      if (!Number.isFinite(fare) || fare <= 0) continue;

      const resolved = await resolveRegion(String(sidoRaw || '').trim(), sigugun);
      if (resolved.corrected) corrected += 1;
      zones.push({
        sido: resolved.sido || officeZoneFare.normSido(sidoRaw),
        sigugun,
        fare,
        km: recomputeKm ? null : zoneGeocode.roundKm(kmRaw),
        srcSido: String(sidoRaw || '').trim(),
      });
    }

    summary.push({ name: title.name, address: geo.address, geo, officeRegion, zones });
    totalRows += zones.length;
    const fares = zones.map((z) => z.fare);
    console.log(`[${summary.length}] ${title.name}`);
    console.log(`     ${geo.address}  (${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)})  ${officeRegion ? officeRegion.sido + ' ' + officeRegion.sigugun : ''}`);
    console.log(`     지역 ${zones.length}건 · 요금 ${Math.min(...fares).toLocaleString()}~${Math.max(...fares).toLocaleString()}원 · km 없는 줄 ${zones.filter((z) => z.km == null).length}건`);
  }

  console.log(`\n합계: 지점 ${summary.length}곳 · 요금 ${totalRows}줄 · 시도 교정 ${corrected}줄`);
  if (dryRun) { console.log('\n미리보기라 저장하지 않았습니다.'); await db.pool.end(); return; }

  // 저장은 지점 단위로 트랜잭션을 건다. 중간에 실패하면 그 지점만 통째로 되돌아가고, 이미 넣은
  // 지점은 남는다 — 요금표가 절반만 들어간 채로 청구에 쓰이는 것이 가장 나쁘다.
  for (const o of summary) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO group_branch_offices (group_id, name, address, lat, lon, sido, sigugun, seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT MAX(seq) + 1 FROM group_branch_offices WHERE group_id = $1), 1))
         ON CONFLICT (group_id, lower(name)) DO UPDATE SET
           address = excluded.address, lat = excluded.lat, lon = excluded.lon,
           sido = excluded.sido, sigugun = excluded.sigugun
         RETURNING id`,
        [groupId, o.name, o.address, o.geo.lat, o.geo.lon,
          o.officeRegion ? o.officeRegion.sido : null, o.officeRegion ? o.officeRegion.sigugun : null]
      );
      const officeId = ins.rows[0].id;
      for (const z of o.zones) {
        let km = z.km;
        if (recomputeKm) {
          const center = await zoneGeocode.lookupZoneCenter(z.srcSido, z.sigugun).catch(() => null);
          const route = center ? await routeDistance(o.geo, { lat: center.lat, lon: center.lon }).catch(() => null) : null;
          km = route ? zoneGeocode.roundKm(route.distanceKm) : null;
        }
        await client.query(
          `INSERT INTO group_office_zone_fares (office_id, sido, sigugun, fare, distance_km)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (office_id, sido, sigugun) DO UPDATE SET
             fare = excluded.fare,
             distance_km = COALESCE(excluded.distance_km, group_office_zone_fares.distance_km),
             updated_at = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')`,
          [officeId, z.sido, z.sigugun, z.fare, km]
        );
      }
      await client.query('COMMIT');
      console.log(`저장: ${o.name} — ${o.zones.length}줄`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`✗ ${o.name} 저장 실패(되돌림):`, e.message);
    } finally {
      client.release();
    }
  }

  await db.pool.end();
})().catch((e) => { console.error('적재 실패:', e); process.exit(1); });
