// 지점 구간요금: 화면에서 등록하고 엑셀로 올린 값이 실제 요금 계산까지 닿는지.
//
// 이 표에 든 금액은 그대로 청구된다. 그래서 "화면에 저장됐다"로는 부족하고, 요금 계산이
// 정말 이 금액을 쓰는지(그리고 거리 구간표를 건너뛰는지)까지 봐야 한다.
//
// 엑셀 업로드는 파일을 실제로 만들어 올린다 — 파서를 직접 부르면 multer·열 이름 판정·
// 지점 이름 매칭이 다 빠진 채로 통과한다.
const { test, expect } = require('@playwright/test');
const db = require('../../db');
const { loginWithRetry } = require('./helpers/auth');
const { calculateFare } = require('../../lib/branchPolicy');

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000';
// 로그인 계정: 실사용 admin으로 로그인하면 단일 세션 강제 때문에 그 계정을 쓰던 사람이
// 로그아웃된다 — QA 전용 계정을 쓴다. 비밀번호는 .env(E2E_PASSWORD)에서 온다.
const LOGIN_ID = process.env.E2E_LOGIN_ID || 'qa_test_bot';
const PASSWORD = process.env.E2E_PASSWORD || '';

const MARK = 'e2e-지점';
// 강남역 부근. 지점 판정은 좌표 반경으로 하므로 실제 좌표가 필요하다.
const OFFICE = { lat: 37.4979, lon: 127.0276 };

let groupId = null;
let branchId = null;

async function wipe() {
  const rows = await db.all('SELECT id FROM group_branch_offices WHERE name LIKE ?', [`${MARK}%`]).catch(() => []);
  for (const r of rows) {
    await db.run('DELETE FROM group_office_zone_fares WHERE office_id = ?', [r.id]).catch(() => {});
    await db.run('DELETE FROM group_branch_offices WHERE id = ?', [r.id]).catch(() => {});
  }
}

test.beforeAll(async () => {
  await wipe();
  // 거리 구간표가 실제로 있는 법인이어야 "구간표를 건너뛴다"를 확인할 수 있다.
  const row = await db.get(`
    SELECT g.id, g.branch_id FROM groups_tbl g
     WHERE EXISTS (SELECT 1 FROM group_fare_rules f WHERE f.group_id = g.id)
     ORDER BY g.id LIMIT 1
  `).catch(() => null);
  if (row) { groupId = Number(row.id); branchId = row.branch_id; }
});

test.afterAll(async () => {
  await wipe();
  // 풀은 여기서 닫지 않는다 — workers: 1이라 같은 프로세스의 다음 스펙이 죽는다.
  // 전부 끝난 뒤 한 번 닫는 일은 tests/global-teardown.js가 맡는다.
});

test.describe('법인관리 · 지점 구간요금', () => {
  test.describe.configure({ timeout: 300000 });

  test('지점 등록 → 엑셀 업로드 → 요금 계산까지 이어진다', async ({ page }) => {
    test.skip(!groupId, '거리 구간표가 등록된 법인이 없습니다');
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    const base = `${BASE_URL}/groups/${groupId}/office-fares`;
    const res = await page.goto(base, { waitUntil: 'domcontentloaded' });
    expect(res.status()).toBe(200);

    // 이 화면이 거리 구간표를 덮는다는 사실이 화면에 있어야 한다 — 없으면 관리자가 구간표를
    // 고쳐놓고 왜 안 바뀌는지 찾는다.
    await expect(page.getByText('거리 구간별 요금 규칙보다 먼저 적용', { exact: false })).toBeVisible();

    // 이 화면은 탭이 아니라 탁송 요금 안에서 들어온다(사용자 지시) — 돌아가는 길이 있어야 한다.
    await expect(page.locator(`a[href="/groups/${groupId}/fare-rules"]`).first()).toBeVisible();

    // ── 지점 등록 ──
    // 주소검색은 카카오 API를 타고 사람이 후보를 고르는 흐름이라, 검사에서는 좌표를 직접
    // 채워 넣는다(그 UI 자체는 아래 "좌표 없이 등록 못 한다"에서 확인한다).
    const officeName = `${MARK}-강남`;
    await page.evaluate(({ name, lat, lon }) => {
      document.querySelector('#officeForm input[name="name"]').value = name;
      const addr = document.getElementById('officeAddress');
      addr.removeAttribute('readonly');
      addr.value = '서울 강남구 강남대로 396';
      document.getElementById('officeLat').value = String(lat);
      document.getElementById('officeLon').value = String(lon);
    }, { name: officeName, lat: OFFICE.lat, lon: OFFICE.lon });
    await page.locator('#officeForm button[type="submit"]').click();
    await page.waitForURL(/saved=/, { timeout: 30000 });

    const office = await db.get('SELECT * FROM group_branch_offices WHERE name = ?', [officeName]);
    expect(office, '지점이 저장돼야 한다').toBeTruthy();
    // 좌표가 이 기능의 전부다 — 없으면 지점을 영영 못 알아본다.
    expect(Number(office.lat)).toBeCloseTo(OFFICE.lat, 3);
    // 등록할 때 지점의 행정구역도 함께 잡아둔다(엑셀에서 시도가 비었을 때 이 값을 쓴다).
    expect(office.sido).toBe('서울');

    // ── 엑셀 업로드 ──
    // km를 비운 줄은 청사 기준으로 자동 계산돼야 한다.
    const csv = '﻿' + [
      '지점,시도,시군구,요금,km',
      `${officeName},서울특별시,강동구,30000,`,
      `${officeName},경기도,수원시,45000,`,
      // 없는 지점 — 조용히 넘어가면 안 되고 건너뛴 줄로 알려야 한다.
      `${MARK}-없는지점,서울특별시,송파구,10000,`,
    ].join('\r\n');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'zones.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8'),
    });
    await page.locator('form[action$="/office-fares/upload"] button[type="submit"]').click();
    await page.waitForURL(/uploaded=/, { timeout: 120000 });

    await expect(page.getByText('2줄 저장', { exact: false })).toBeVisible();
    // 건너뛴 줄을 숨기면 "다 올라간 줄" 알고 넘어간다 — 청구 누락으로 이어진다.
    await expect(page.getByText('등록되지 않은 지점', { exact: false })).toBeVisible();

    const zones = await db.all(
      'SELECT sido, sigugun, fare, distance_km FROM group_office_zone_fares WHERE office_id = ? ORDER BY sigugun',
      [office.id]
    );
    expect(zones.map((z) => `${z.sido} ${z.sigugun} ${z.fare}`))
      .toEqual(['서울 강동구 30000', '경기 수원시 45000']);
    // 엑셀은 "서울특별시"라고 적지만 orders는 "서울"로 저장한다 — 표기를 맞춰 넣어야 매칭된다.
    expect(zones.every((z) => z.sido.length <= 2)).toBe(true);
    // km를 비웠으니 청사 기준으로 채워져야 한다.
    expect(Number(zones[1].distance_km), '수원시청까지 거리').toBeGreaterThan(0);
    // 소수점 한 자리(사용자 지정).
    expect(String(zones[1].distance_km)).toMatch(/^\d+(\.\d)?$/);

    // ── 요금 계산이 이 금액을 쓰는가 ──
    // 여기가 이 기능의 전부다. 화면에 저장만 되고 계산이 거리 구간표를 쓰면 아무 의미가 없다.
    const zoneFare = await calculateFare(branchId, 12.3, {
      groupId,
      originLat: OFFICE.lat, originLon: OFFICE.lon,
      destinationSido: '서울', destinationSigugun: '강동구',
    });
    expect(zoneFare.enabled).toBe(true);
    expect(zoneFare.fare, '계약표 금액이 그대로 나와야 한다').toBe(30000);
    expect(zoneFare.zoneFare && zoneFare.zoneFare.officeName).toBe(officeName);

    // 같은 거리인데 지점과 무관한 오더는 거리 구간표로 가야 한다.
    const distanceFare = await calculateFare(branchId, 12.3, {
      groupId,
      originLat: 35.1796, originLon: 129.0756, // 부산
      destinationSido: '서울', destinationSigugun: '강동구',
    });
    expect(distanceFare.zoneFare, '지점과 무관한 오더에는 붙지 않는다').toBeFalsy();
    expect(distanceFare.fare).not.toBe(30000);

    // ── 좌표 없이는 지점을 못 만든다 ──
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const blocked = await page.evaluate(async (gid) => {
      const body = new URLSearchParams({ name: 'e2e-좌표없음', address: '서울 어딘가' });
      const r = await fetch(`/groups/${gid}/office-fares/offices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      return r.url;
    }, groupId);
    expect(decodeURIComponent(blocked)).toContain('좌표');
    expect(await db.get('SELECT id FROM group_branch_offices WHERE name = ?', ['e2e-좌표없음'])).toBeFalsy();

    expect(problems, `페이지 오류: ${problems.join(' | ')}`).toEqual([]);
  });

  // 사용자가 요구한 것은 "엑셀 업로드"다. CSV만 확인하고 넘어가면 정작 .xlsx가 안 열려도
  // 모른다 — exceljs로 실제 파일을 만들어 올려본다.
  test('진짜 .xlsx 파일도 그대로 등록된다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    const officeName = `${MARK}-엑셀`;
    await db.run(
      `INSERT INTO group_branch_offices (group_id, name, address, lat, lon, sido, sigugun)
       VALUES (?, ?, '서울 강남구 검사로 1', ?, ?, '서울', '강남구')`,
      [groupId, officeName, OFFICE.lat, OFFICE.lon]
    );

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('요금표');
    // 열 순서를 샘플과 다르게 둔다 — 사람이 만든 표는 순서가 자주 바뀌고, 열 이름으로
    // 읽는다고 해놓고 실제로는 순서에 기대고 있으면 여기서 걸린다.
    ws.addRow(['시도', '지점', '요금', '시군구', 'km']);
    ws.addRow(['서울특별시', officeName, 21000, '서초구', 5.2]);
    ws.addRow(['경기도', officeName, 33000, '성남시분당구', '']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/groups/${groupId}/office-fares`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').setInputFiles({
      name: 'zones.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: buf,
    });
    await page.locator('form[action$="/office-fares/upload"] button[type="submit"]').click();
    await page.waitForURL(/uploaded=/, { timeout: 120000 });
    await expect(page.getByText('2줄 저장', { exact: false })).toBeVisible();

    const office = await db.get('SELECT id FROM group_branch_offices WHERE name = ?', [officeName]);
    const zones = await db.all(
      'SELECT sido, sigugun, fare, distance_km FROM group_office_zone_fares WHERE office_id = ? ORDER BY fare',
      [office.id]
    );
    expect(zones.map((z) => `${z.sido} ${z.sigugun} ${z.fare}`))
      .toEqual(['서울 서초구 21000', '경기 성남시분당구 33000']);
    // 적어 넣은 km는 그대로, 비운 km는 청사 기준으로 채워져야 한다.
    expect(Number(zones[0].distance_km)).toBe(5.2);
    expect(Number(zones[1].distance_km)).toBeGreaterThan(0);
  });

  // 켜고 끄는 것은 탁송 요금 화면에서 한다(사용자 지시) — 요금이 어떻게 산출되는지는 한
  // 화면에서 보여야 한다. 등록 화면과 떨어져 있으면 "표는 있는데 왜 안 붙지"를 겪는다.
  test('탁송 요금 화면 맨 위에서 우선 적용을 켜고 끌 수 있다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });

    const before = await db.get('SELECT office_fare_enabled FROM groups_tbl WHERE id = ?', [groupId]);
    try {
      await page.goto(`${BASE_URL}/groups/${groupId}/fare-rules`, { waitUntil: 'domcontentloaded' });

      // 거리 구간표보다 **위에** 있어야 한다 — 아래 있으면 구간표만 고치고 왜 안 바뀌는지 찾는다.
      //
      // 카드를 제목으로 찾지 않는다. 화면에 "지점 구간요금"이라는 말이 들어간 카드가 둘이다
      // (맨 위 '현재 적용되는 요금표' 순위표에도 나온다) — 제목으로 잡으면 엉뚱한 카드를 집는다.
      // 체크박스가 있는 카드가 이 검사가 말하는 그 카드다.
      const officeCard = page.locator('.card:has(input[name="office_fare_enabled"])');
      await expect(officeCard).toBeVisible();
      const officeY = await officeCard.boundingBox();
      const tierY = await page.locator('.card', { hasText: '거리 구간별 요금 규칙' }).first().boundingBox();
      expect(officeY.y, '지점 구간요금이 거리 구간표보다 위에 있어야 한다').toBeLessThan(tierY.y);

      // 등록 화면으로 가는 버튼.
      await expect(officeCard.locator(`a[href="/groups/${groupId}/office-fares"]`)).toBeVisible();

      // 꺼서 저장 → DB에 반영되고, 화면이 "적용 꺼짐"이라고 밝혀야 한다.
      await officeCard.locator('input[type="checkbox"][name="office_fare_enabled"]').uncheck();
      await page.locator('button[form="fareForm"]', { hasText: '저장' }).first().click();
      await page.waitForURL(/saved=1/, { timeout: 30000 });
      expect((await db.get('SELECT office_fare_enabled FROM groups_tbl WHERE id = ?', [groupId])).office_fare_enabled)
        .toBe(false);
      // 저장 뒤 다시 그려진 화면에도 꺼진 채로 보여야 한다 — 저장은 됐는데 체크가 되살아나면
      // 관리자는 안 꺼진 줄 알고 다시 누른다.
      await expect(page.locator('.card:has(input[name="office_fare_enabled"])')
        .locator('input[type="checkbox"][name="office_fare_enabled"]')).not.toBeChecked();
      // 꺼진 상태에서 무엇으로 계산되는지 밝혀야 한다(등록 여부에 따라 문구가 갈린다).
      await expect(page.getByText('거리 구간표로 계산합니다', { exact: false }).first()).toBeVisible();

      // 다시 켜면 되돌아온다 — 줄을 지우지 않고 되돌릴 수 있어야 한다.
      await page.locator('.card:has(input[name="office_fare_enabled"])')
        .locator('input[type="checkbox"][name="office_fare_enabled"]').check();
      await page.locator('button[form="fareForm"]', { hasText: '저장' }).first().click();
      await page.waitForURL(/saved=1/, { timeout: 30000 });
      expect((await db.get('SELECT office_fare_enabled FROM groups_tbl WHERE id = ?', [groupId])).office_fare_enabled)
        .toBe(true);
    } finally {
      await db.run('UPDATE groups_tbl SET office_fare_enabled = ? WHERE id = ?',
        [before ? before.office_fare_enabled : true, groupId]).catch(() => {});
    }
  });

  test('샘플 양식을 받으면 업로드에 필요한 열이 다 들어 있다', async ({ page }) => {
    test.skip(!groupId, '법인이 없습니다');
    await loginWithRetry(page, { baseUrl: BASE_URL, loginId: LOGIN_ID, password: PASSWORD });
    await page.goto(`${BASE_URL}/groups/${groupId}/office-fares`, { waitUntil: 'domcontentloaded' });

    // BOM은 바이트로 확인한다 — Response.text()는 규격상 선두 BOM을 떼어내므로
    // 문자열로 보면 "없다"로 나온다(실제로 그렇게 한 번 틀렸다).
    const { text, head } = await page.evaluate(async (gid) => {
      const r = await fetch(`/groups/${gid}/office-fares/sample`);
      const buf = new Uint8Array(await r.arrayBuffer());
      return { text: new TextDecoder('utf-8').decode(buf), head: Array.from(buf.slice(0, 3)) };
    }, groupId);

    // 샘플이 업로드 파서가 요구하는 열 이름과 어긋나면, 받아서 채운 파일이 그대로 거절된다.
    const header = text.replace(/^﻿/, '').split(/\r?\n/)[0];
    ['지점', '시도', '시군구', '요금'].forEach((c) => expect(header).toContain(c));
    // 엑셀이 UTF-8을 알아보게 BOM이 있어야 한다 — 없으면 한글이 깨져서 열린다.
    expect(head, 'UTF-8 BOM(EF BB BF)').toEqual([0xEF, 0xBB, 0xBF]);
  });
});
