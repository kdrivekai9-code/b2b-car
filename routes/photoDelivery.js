// 사진 전송리스트 (고객용) — /my/photos
//
// 정산내역(/my/settlement)과 같은 자리의 고객 메뉴다. 권한 규칙도 그쪽과 맞춘다:
// 법인 소속이 없으면 볼 것이 없고, 개인 딜러는 본인이 접수한 건만 본다(lib/clientScope.js).
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { requireAuth, requireRole } = require('../middleware/auth');
const clientScope = require('../lib/clientScope');
const photoDelivery = require('../lib/photoDelivery');
const { buildZip } = require('../lib/zipStream');

const router = express.Router();
router.use(requireAuth, requireRole('client'));

// 한 오더의 사진을 전부 내려받을 때 서버가 감당할 상한.
//
// 콜마너 촬영은 운행전·후 13장씩이라 26장 + 영수증 몇 장이 정상 범위다. 그 이상이면 뭔가
// 잘못된 것이므로 자른다 — 상한이 없으면 사진 수에 비례해 메모리와 응답시간이 늘고,
// 서버리스 함수의 30초 제한에 걸려 아무것도 못 내려받는 상태가 된다.
const MAX_FILES = 60;
// 장당 상한. 콜마너 사진은 보통 1~3MB다.
const MAX_FILE_BYTES = 15 * 1024 * 1024;
// 한 장을 기다릴 시간. 콜마너 CDN은 만료되면 응답이 늦거나 없다 — 한 장 때문에 전체가
// 매달리지 않게 끊고, 나머지로 압축을 만든다.
const FETCH_TIMEOUT_MS = 8000;

function scopeOf(user) {
  return {
    groupId: user.group_id,
    // 개인 딜러는 본인 접수분만. 본사 직원은 법인 전체를 본다.
    createdBy: clientScope.isDealer(user) ? user.id : null,
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const me = req.session.user;
  // 법인이 없는 고객 계정은 볼 오더가 없다. 이제 계정 등록에서 막고 있지만(routes/users.js
  // clientGroupError), 그 전에 만들어진 계정이 남아 있을 수 있어 화면에서도 걸러준다.
  if (!me.group_id) return res.status(403).render('403', { title: '접근 권한 없음' });

  const rows = await photoDelivery.listForClient(scopeOf(me));
  res.render('photo_delivery/list', {
    title: '사진 전송리스트',
    rows,
    meIsDealer: clientScope.isDealer(me),
  });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const me = req.session.user;
  if (!me.group_id) return res.status(403).render('403', { title: '접근 권한 없음' });
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(404).send('오더를 찾을 수 없습니다.');

  const detail = await photoDelivery.detailForClient(orderId, scopeOf(me));
  if (!detail.order) return res.status(404).send('오더를 찾을 수 없거나 접근 권한이 없습니다.');
  if (detail.reason === 'not_allowed') {
    return res.status(403).render('photo_delivery/detail', { title: '사진을 볼 수 없습니다', ...detail });
  }
  res.render('photo_delivery/detail', { title: `사진 - ${detail.order.oid}`, ...detail });
}));

// 사진을 하나씩 눌러 저장하게 하면 26번을 눌러야 한다. 한 번에 묶어 준다.
//
// 링크(a[download])로 하지 않는 이유: 사진이 우리 도메인이 아니라 콜마너 CDN·스토리지에
// 있어서 브라우저가 download 속성을 무시하고 새 탭으로 열어버린다(크로스 오리진). 서버가
// 받아서 다시 내려주면 그 문제가 없고, 파일 이름도 "1. 전면.jpg"처럼 붙일 수 있다.
router.get('/:id/download.zip', asyncHandler(async (req, res) => {
  const me = req.session.user;
  if (!me.group_id) return res.status(403).send('접근 권한이 없습니다.');
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(404).send('오더를 찾을 수 없습니다.');

  const detail = await photoDelivery.detailForClient(orderId, scopeOf(me));
  if (!detail.order) return res.status(404).send('오더를 찾을 수 없거나 접근 권한이 없습니다.');
  if (detail.reason === 'not_allowed') return res.status(403).send('사진 열람이 허용되지 않은 지사입니다.');

  const plan = photoDelivery.downloadPlan(detail).slice(0, MAX_FILES);
  if (!plan.length) return res.status(404).send('내려받을 사진이 없습니다.');

  // 한 장이 실패해도 나머지는 담는다 — 콜마너 CDN 링크는 만료될 수 있어서, 전부-아니면-전무로
  // 만들면 오래된 오더는 영영 못 받는다. 무엇이 빠졌는지는 압축 안에 글로 남긴다.
  const failed = [];
  const entries = [];
  for (const item of plan) {
    const buf = await fetchImage(item.url).catch((e) => { failed.push({ ...item, reason: e.message }); return null; });
    if (buf) entries.push({ dir: item.dir, name: item.name, data: buf, date: detail.order.created_at });
  }

  if (!entries.length) {
    return res.status(502).send('사진을 내려받지 못했습니다. 사진 보관 기간이 지났을 수 있습니다.');
  }
  if (failed.length) {
    const lines = ['내려받지 못한 사진', ''].concat(
      failed.map((f) => `- ${f.dir}/${f.name} : ${f.reason}`),
      ['', '사진 보관 기간이 지나 원본이 사라졌을 수 있습니다. 상담원에게 문의해 주세요.']
    );
    entries.push({ name: '못받은사진.txt', data: Buffer.from(lines.join('\n'), 'utf8') });
  }

  const zip = buildZip(entries);
  // 파일명에 한글을 쓰려면 filename*=UTF-8''… 이 필요하다. 구형 브라우저용으로 ASCII
  // filename도 함께 준다 — 없으면 이름 없이 저장되는 경우가 있다.
  const base = `탁송사진-${String(detail.order.oid || orderId)}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(zip.length));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="photos-${orderId}.zip"; filename*=UTF-8''${encodeURIComponent(base + '.zip')}`
  );
  res.end(zip);
}));

// 사진 한 장을 받아온다. 이미지가 아니거나 너무 크면 담지 않는다 — 링크가 만료돼 HTML
// 오류 페이지가 돌아오는 경우가 있어서, 그것을 .jpg로 담으면 열리지 않는 파일이 섞인다.
async function fetchImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (type && !type.startsWith('image/')) throw new Error(`이미지가 아님(${type.split(';')[0]})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('빈 파일');
    if (buf.length > MAX_FILE_BYTES) throw new Error('파일이 너무 큼');
    return buf;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('응답 시간 초과');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = router;
module.exports.MAX_FILES = MAX_FILES;
