// 사진 전송리스트 — 조회 범위, 열람 권한, 다운로드 묶음, 화면 렌더를 못 박는다.
//
// 이 기능의 위험은 둘이다.
//   1) 남의 오더가 보이는 것 — 법인이 다르거나, 개인 딜러가 동료 접수분을 보는 경우.
//   2) 지사가 막아둔 사진이 새 메뉴로 열리는 것(branch_photo_settings.client_can_view).
// 둘 다 화면을 눌러봐서는 확인하기 어렵다(다른 법인 계정으로 로그인해야 한다) — 여기서 본다.
//
// EJS 화면도 함께 렌더한다. 문법이 틀려도 빌드에서 안 잡히고 열 때 500이 나는 종류라,
// "파일이 있다"로는 동작을 보증할 수 없다(group-settings-pages 스펙과 같은 이유).
require('dotenv').config();
const path = require('path');
const ejs = require('ejs');
const db = require('../db');
const photoDelivery = require('../lib/photoDelivery');
const { buildZip } = require('../lib/zipStream');
const tripFees = require('../lib/tripFees');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}

const MARK = 'zzq사진전송검사';

(async () => {
  let made = [];
  try {
    console.log('[운행요금 계산 — 정산서와 같은 함수를 쓴다]');
    check('구간요금 + 대기 + 취소',
      tripFees.billableTripFare({ fare_amount: 90000, wait_fee_amount: 10000, cancel_fee_amount: 5000 }), 105000);
    // 도선료는 부대비용(기타 정산)으로 집계된다 — 여기서 더하면 두 번 세어진다.
    check('도선료는 더하지 않는다',
      tripFees.billableTripFare({ fare_amount: 90000, ferry_fare_amount: 12000 }), 90000);
    check('빈 값은 0으로 본다', tripFees.billableTripFare({}), 0);
    check('오더가 없어도 터지지 않는다', tripFees.billableTripFare(null), 0);

    console.log('[다운로드 묶음]');
    const plan = photoDelivery.downloadPlan({
      phases: [
        { label: '운행 전', items: [{ seq: 1, label: '1. 전면', url: 'https://x/a.jpg' }] },
        { label: '운행 완료 후', items: [{ seq: 13, label: '13. 계기판', url: 'https://x/b.png' }] },
      ],
      receipts: [
        { charge_type: '주유비', receipt: { files: [{ url: 'https://x/r1.jpg' }, { url: 'https://x/r2.jpg' }] } },
        { charge_type: '세차비', receipt: null },
      ],
    });
    // 폴더로 나뉘어야 압축을 푼 뒤에도 운행 전·후를 구분할 수 있다.
    check('폴더가 운행 전/후/영수증으로 나뉜다', plan.map((p) => p.dir), ['운행전', '운행완료후', '실비영수증', '실비영수증']);
    check('파일명은 항목 이름 + 확장자', plan.map((p) => p.name),
      ['1. 전면.jpg', '13. 계기판.png', '주유비-1.jpg', '주유비-2.jpg']);
    // 영수증이 없는 줄은 담을 것이 없다 — 빈 파일을 만들면 푼 사람이 "깨진 사진"으로 읽는다.
    check('영수증 없는 줄은 담지 않는다', plan.filter((p) => p.name.startsWith('세차비')).length, 0);
    check('확장자를 모르면 jpg', photoDelivery.extOf('https://x/no-ext?token=1'), '.jpg');
    check('쿼리스트링은 확장자 판정에서 뺀다', photoDelivery.extOf('https://x/a.PNG?v=2'), '.png');

    console.log('[ZIP]');
    const zip = buildZip([{ dir: '운행전', name: '1. 전면.jpg', data: Buffer.from('abc') }]);
    // 로컬 헤더 · EOCD 서명이 맞아야 압축 프로그램이 연다.
    check('로컬 헤더 서명', zip.readUInt32LE(0), 0x04034b50);
    check('EOCD 서명', zip.readUInt32LE(zip.length - 22), 0x06054b50);
    check('파일 1개', zip.readUInt16LE(zip.length - 22 + 10), 1);

    console.log('[조회 범위]');
    // 사진이 달린 오더를 검사용으로 직접 만든다 — 실데이터에 의존하면(사진 있는 오더가
    // 하나뿐이다) 그 오더가 사라지는 날 검사가 조용히 통과한다.
    const donor = await db.get(
      `SELECT id, branch_id, requester_group_id, created_by FROM orders
        WHERE branch_id IS NOT NULL AND requester_group_id IS NOT NULL
        ORDER BY id DESC LIMIT 1`);
    if (!donor) { console.log('  건너뜀 — 지사·법인이 모두 있는 오더가 없다'); }
    else {
      const mkOrder = async (suffix, groupId, createdBy) => {
        const r = await db.get(
          `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                               origin_address, destination_address, fare_amount, wait_fee_amount, created_by)
           VALUES (?, ?, ?, '완료', '2019-12-24', '10:00', 'x', 'y', 50000, 3000, ?) RETURNING id`,
          [MARK + suffix, donor.branch_id, groupId, createdBy]
        );
        made.push(r.id);
        await db.run(
          `INSERT INTO order_callmaner_photos (order_id, phase, seq, url)
           VALUES (?, 'start', 1, 'https://example.invalid/s1.jpg'), (?, 'end', 1, 'https://example.invalid/e1.jpg')`,
          [r.id, r.id]
        );
        return r.id;
      };
      // 접수자 id는 실제 계정에서 빌려온다 — orders.created_by에 외래키가 걸려 있어 가짜
      // 숫자로는 넣을 수 없다. "나"와 "동료" 둘로 갈라야 개인 딜러 범위를 확인할 수 있다.
      const users = await db.all('SELECT id FROM users ORDER BY id LIMIT 2');
      if (users.length < 2) throw new Error('계정이 둘 이상 있어야 딜러 범위를 검사할 수 있다');
      const meId = users[0].id;
      const teammateId = users[1].id;
      // 같은 법인 · 나 / 같은 법인 · 동료 / 다른 법인
      const otherGroup = await db.get('SELECT id FROM groups_tbl WHERE id <> ? LIMIT 1', [donor.requester_group_id]);
      const mineId = await mkOrder('-mine', donor.requester_group_id, meId);
      const teamId = await mkOrder('-team', donor.requester_group_id, teammateId);
      const otherId = otherGroup ? await mkOrder('-other', otherGroup.id, meId) : null;

      // 사진이 없는 오더는 목록에 오르지 않아야 한다 — "사진 전송"리스트다.
      const noPhoto = await db.get(
        `INSERT INTO orders (oid, branch_id, requester_group_id, status, reserved_date, reserved_time,
                             origin_address, destination_address, fare_amount, created_by)
         VALUES (?, ?, ?, '완료', '2019-12-24', '10:00', 'x', 'y', 10000, ?) RETURNING id`,
        [MARK + '-nophoto', donor.branch_id, donor.requester_group_id, meId]
      );
      made.push(noPhoto.id);

      const hq = await photoDelivery.listForClient({ groupId: donor.requester_group_id, createdBy: null });
      const hqIds = hq.map((r) => r.id);
      check('본사 직원은 법인 전체를 본다', [hqIds.includes(mineId), hqIds.includes(teamId)], [true, true]);
      check('사진 없는 오더는 목록에 없다', hqIds.includes(noPhoto.id), false);
      if (otherId) check('다른 법인 오더는 안 보인다', hqIds.includes(otherId), false);

      const dealer = await photoDelivery.listForClient({ groupId: donor.requester_group_id, createdBy: meId });
      const dealerIds = dealer.map((r) => r.id);
      // 개인 딜러가 동료 접수분을 보면 남의 실적과 차량 정보가 새어 나간다.
      check('개인 딜러는 본인 접수분만', [dealerIds.includes(mineId), dealerIds.includes(teamId)], [true, false]);

      const row = hq.find((r) => r.id === mineId);
      check('운행요금은 대기요금까지 포함', row.tripFare, 53000);
      check('사진 장수를 센다', row.photoCount, 2);

      console.log('[열람 권한 — 지사 설정]');
      const viewable = await photoDelivery.clientCanViewBranches();
      // 행이 없으면 볼 수 없다. 기본값을 허용으로 두면 설정을 만진 적 없는 지사의 사진이
      // 조용히 열린다(/photos/:token과 같은 규칙).
      const allowed = viewable.has(Number(donor.branch_id));
      check('목록의 canViewPhotos가 지사 설정을 따른다', row.canViewPhotos, allowed);

      const detail = await photoDelivery.detailForClient(mineId, { groupId: donor.requester_group_id, createdBy: null });
      if (allowed) {
        check('상세가 운행 전/후로 나뉜다', (detail.phases || []).map((g) => g.label), ['운행 전', '운행 완료 후']);
        check('항목 이름이 붙는다', detail.phases[0].items[0].label, '1. 전면');
      } else {
        check('막힌 지사는 상세도 막는다', detail.reason, 'not_allowed');
      }
      // 다른 법인 오더를 id로 직접 찔러도 열리지 않아야 한다(주소창으로 여는 경우).
      if (otherId) {
        const sneak = await photoDelivery.detailForClient(otherId, { groupId: donor.requester_group_id, createdBy: null });
        check('다른 법인 오더는 상세도 막는다', sneak.order, null);
      }
      const sneakDealer = await photoDelivery.detailForClient(teamId, { groupId: donor.requester_group_id, createdBy: meId });
      check('개인 딜러는 동료 오더 상세도 못 연다', sneakDealer.order, null);

      console.log('[화면 렌더]');
      // 실제 라우트는 로그인 세션이 필요해 여기서 못 태운다. 템플릿만 직접 렌더해서 문법·참조
      // 오류를 잡는다(열 때 500이 나는 종류를 배포 전에 걸러내는 것이 목적).
      const shell = { currentUser: { name: 'x', login_id: 'x', role: 'client', phone: '' }, path: '/my/photos', title: 't' };
      await ejs.renderFile(path.join(__dirname, '../views/photo_delivery/list.ejs'),
        { ...shell, rows: hq, meIsDealer: false }, { root: path.join(__dirname, '../views') });
      console.log('  OK   목록 화면이 렌더된다');
      await ejs.renderFile(path.join(__dirname, '../views/photo_delivery/detail.ejs'),
        { ...shell, ...detail, receipts: detail.receipts || [] }, { root: path.join(__dirname, '../views') });
      console.log('  OK   상세 화면이 렌더된다');
      // 사진이 없는 경우·막힌 경우도 렌더돼야 한다 — 조건 분기에서 참조 오류가 흔하다.
      await ejs.renderFile(path.join(__dirname, '../views/photo_delivery/detail.ejs'),
        { ...shell, order: { id: 1, oid: 'x' }, reason: 'not_allowed', phases: [], receipts: [], odometerIndex: null, tripFare: 0 },
        { root: path.join(__dirname, '../views') });
      console.log('  OK   열람 불가 화면이 렌더된다');
      await ejs.renderFile(path.join(__dirname, '../views/photo_delivery/list.ejs'),
        { ...shell, rows: [], meIsDealer: true }, { root: path.join(__dirname, '../views') });
      console.log('  OK   빈 목록 화면이 렌더된다');
    }
  } finally {
    for (const id of made) {
      await db.run('DELETE FROM order_callmaner_photos WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM order_status_history WHERE order_id = ?', [id]).catch(() => {});
      await db.run('DELETE FROM orders WHERE id = ?', [id]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
