// 오더 사진을 카카오로 보내는 경로를 확인한다 — 권한 · 부분 실패 · 문구.
//
// 실제 발신도 실제 업로드도 하지 않는다. 카카오에 사진을 올리는 것은 되돌릴 수 없고(21일 보관),
// 고객 대화창에 사진이 튀어나오면 그게 사고다. 업로드·발신·다운로드를 전부 주입해서 본다.
//
// DB는 쓴다 — 지사 열람 설정(branch_photo_settings)과 사진 목록(order_photos)을 읽는 부분이
// 이 기능의 핵심 판단이라, 그것까지 흉내 내면 확인하는 의미가 없다. 만든 행만 지운다.
//
//   node scripts/check-kakao-order-photos.js
require('dotenv').config();
const db = require('../db');
const photos = require('../lib/kakaoOrderPhotos');

const MARK = 'e2e-kakao-photo-check';

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}`);
  if (!ok) console.log(`         기대: ${JSON.stringify(expected)}\n         실제: ${JSON.stringify(actual)}`);
}

// 주입할 가짜들 — 무엇이 오갔는지 기록해서 문구까지 확인한다.
function makeStubs(options = {}) {
  const sent = [];
  return {
    sent,
    fetchImage: options.fetchImage || (async () => ({ ok: true, buffer: Buffer.from('fake'), contentType: 'image/jpeg' })),
    uploadImage: options.uploadImage || (async (_session, _buf, name) => ({ ok: true, url: `https://kakao.example/${name}` })),
    sendImages: options.sendImages || (async (_session, urls, text) => { sent.push({ urls, text }); return { ok: true }; }),
  };
}

async function main() {
  const created = { orderId: null, branchId: null, photoIds: [], settingExisted: false, settingBefore: null };

  try {
    console.log('[사진 요청 판정]');
    // 오탐이 나면 엉뚱한 대화에 사진이 튀어나온다. 특히 고객이 "제가 보내드릴게요"라고 한 것을
    // 요청으로 읽으면, 고객은 자기가 보낸 사진이 되돌아온 것으로 오해한다.
    [
      ['사진 좀 보내주세요', true],
      ['인수증 사진 받을 수 있나요', true],
      ['차량 사진 확인 가능한가요', true],
      ['이미지 보내주실 수 있어요?', true],
      ['제가 사진 보내드릴게요', false],
      ['사진 첨부할게요', false],
      ['사진 올릴게요', false],
      ['배차 됐나요?', false],
      ['요금이 얼마인가요', false],
    ].forEach(([sentence, want]) => check(`"${sentence}"`, photos.isPhotoRequest(sentence), want));

    console.log('\n[파일명 추출]');
    check('URL 끝의 파일명을 쓴다', photos.fileNameFromUrl('https://x/y/abc.jpg', 0), 'abc.jpg');
    check('쿼리스트링은 떼어낸다', photos.fileNameFromUrl('https://x/y/abc.png?token=1', 0), 'abc.png');
    // 카카오는 확장자를 보고 거른다(jpg/jpeg/png/gif). 확장자가 없으면 붙여준다.
    check('확장자가 없으면 붙인다', photos.fileNameFromUrl('https://x/y/blob', 2), 'photo_3.jpg');

    const branch = await db.get('SELECT id FROM branches ORDER BY id LIMIT 1');
    created.branchId = branch.id;

    // 지사 열람 설정은 실제 운영값이라 손대기 전에 떠놓는다.
    created.settingBefore = await db.get(
      'SELECT client_can_view, branch_manager_can_view, guide_text, guide_image_url FROM branch_photo_settings WHERE branch_id = ?',
      [branch.id]
    );
    created.settingExisted = !!created.settingBefore;

    const order = await db.get(
      `INSERT INTO orders (oid, branch_id, status, origin_address, destination_address, reserved_date, reserved_time, memo_customer)
       VALUES (?, ?, '접수', '서울 강서구', '경기 성남시', '2026-08-20', '14:00', ?) RETURNING id`,
      [`${MARK}-oid`, branch.id, MARK]
    );
    created.orderId = order.id;
    const orderRow = { id: order.id, oid: `${MARK}-oid`, branch_id: branch.id };
    const session = { id: 0, kakao_service_key: 'k', kakao_user_key: 'u' };

    // client_can_view는 boolean이 아니라 integer다(화면이 1/0으로 저장한다 — routes/branches.js).
    const setViewable = async (canView) => {
      await db.run(`
        INSERT INTO branch_photo_settings (branch_id, client_can_view)
        VALUES (?, ?)
        ON CONFLICT (branch_id) DO UPDATE SET client_can_view = excluded.client_can_view
      `, [branch.id, canView ? 1 : 0]);
    };

    console.log('\n[지사가 고객 열람을 막아둔 경우]');
    await setViewable(false);
    {
      const stubs = makeStubs();
      const result = await photos.sendOrderPhotos(session, orderRow, stubs);
      check('보내지 않는다', result.skipped, 'not_allowed');
      check('발신 시도조차 없다', stubs.sent.length, 0);
      // 화면에서는 막아놓고 챗봇으로는 나가면 그 설정이 의미가 없다.
      check('상담원 안내로 돌린다', result.message, photos.MESSAGES.notAllowed);
    }

    console.log('\n[사진이 아직 없을 때]');
    await setViewable(true);
    {
      const stubs = makeStubs();
      const result = await photos.sendOrderPhotos(session, orderRow, stubs);
      check('보내지 않는다', result.skipped, 'no_photos');
      check('"아직 없다"고 알린다', result.message, photos.MESSAGES.noPhotos);
    }

    console.log('\n[사진이 있을 때]');
    for (let i = 0; i < 3; i += 1) {
      const row = await db.get(
        'INSERT INTO order_photos (order_id, url) VALUES (?, ?) RETURNING id',
        [created.orderId, `https://storage.example/${created.orderId}/p${i}.jpg`]
      );
      created.photoIds.push(row.id);
    }
    {
      const stubs = makeStubs();
      const result = await photos.sendOrderPhotos(session, orderRow, stubs);
      check('세 장을 보낸다', result.sent, 3);
      check('한 번의 메시지로 보낸다', stubs.sent.length, 1);
      check('업로드된 카카오 URL로 보낸다', stubs.sent[0].urls.every((u) => u.startsWith('https://kakao.example/')), true);
      check('어느 오더인지 문구에 넣는다', stubs.sent[0].text.includes(`${MARK}-oid`), true);
      check('장수를 밝힌다', stubs.sent[0].text.includes('3장'), true);
    }

    console.log('\n[일부만 올라간 경우]');
    {
      let n = 0;
      const stubs = makeStubs({
        // 첫 장만 실패시킨다 — 5MB 초과나 비율 제한에 걸리는 사진이 섞이는 상황이다.
        uploadImage: async (_s, _b, name) => {
          n += 1;
          return n === 1 ? { ok: false, error: 'image_too_large(9999999)' } : { ok: true, url: `https://kakao.example/${name}` };
        },
      });
      const result = await photos.sendOrderPhotos(session, orderRow, stubs);
      // 한 장 때문에 전부 못 보내면 고객은 아무것도 못 받는다.
      check('나머지는 보낸다', result.sent, 2);
      check('못 보낸 장수를 센다', result.failed, 1);
      check('일부만 갔다고 밝힌다', stubs.sent[0].text.includes('3장 중 2장'), true);
    }

    console.log('\n[전부 실패한 경우]');
    {
      const stubs = makeStubs({ uploadImage: async () => ({ ok: false, error: 'boom' }) });
      const result = await photos.sendOrderPhotos(session, orderRow, stubs);
      check('보내지 않는다', result.skipped, 'upload_failed');
      check('발신 시도조차 없다', stubs.sent.length, 0);
      check('상담원이 이어받는다고 알린다', result.message, photos.MESSAGES.allFailed);
    }

    console.log('\n[사진이 많을 때]');
    {
      const stubs = makeStubs();
      const result = await photos.sendOrderPhotos(session, orderRow, { ...stubs, limit: 2 });
      // 수십 장을 한꺼번에 보내면 대화창이 묻힌다.
      check('상한을 넘기지 않는다', result.sent, 2);
    }
  } finally {
    if (created.photoIds.length) {
      await db.run(`DELETE FROM order_photos WHERE id IN (${created.photoIds.map(() => '?').join(',')})`, created.photoIds).catch(() => {});
    }
    if (created.orderId) {
      await db.run('DELETE FROM orders WHERE id = ? AND memo_customer = ?', [created.orderId, MARK]).catch(() => {});
    }
    // 지사 설정은 원래대로 되돌린다 — 이 DB는 프로덕션과 같다.
    if (created.branchId) {
      if (created.settingExisted) {
        await db.run(
          'UPDATE branch_photo_settings SET client_can_view = ? WHERE branch_id = ?',
          [created.settingBefore.client_can_view, created.branchId]
        ).catch(() => {});
      } else {
        await db.run('DELETE FROM branch_photo_settings WHERE branch_id = ?', [created.branchId]).catch(() => {});
      }
    }
    console.log(`\n정리: order=${created.orderId ?? '-'}, photos=${created.photoIds.length}, 지사설정=${created.settingExisted ? '원복' : '삭제'}`);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exitCode = failed ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => {
  console.error('\n확인 중 오류:', e.message);
  process.exit(1);
});
