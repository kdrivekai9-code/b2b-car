// 탁송사진 짝 비교와 실비 영수증 검사.
//
// 왜 검사로 고정하나: 운행전·운행후를 각각 늘어놓으면 같은 자리를 비교하려고 눈으로 세어 짝을
// 찾아야 한다. 흠집이 언제 생겼는지가 사고 처리의 전부인데, 짝이 어긋나면 엉뚱한 자리를 비교하고
// 그 판단으로 책임을 가르게 된다. 화면에는 아무 오류도 안 뜬다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const photos = require('../lib/callmanerPhotos');
const extraCharges = require('../lib/extraCharges');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('[항목 이름]');
// 확인된 자리만 이름을 붙인다. 모르는 자리에 그럴듯한 이름을 넣으면 "운전석 휠"이라고 적힌
// 자리에 뒷범퍼 사진이 뜨고, 사고 처리에서 그 이름을 근거로 다투게 된다.
check('1번은 전면', photos.photoLabel(1) === '1. 전면');
check('13번은 계기판', photos.photoLabel(13) === '13. 계기판');
check('모르는 자리는 번호만', photos.photoLabel(7) === '7번', photos.photoLabel(7));
// 이 두 자리는 코드가 실제로 쓰고 있다 — 이름과 동작이 어긋나면 안 된다.
check('1번이 번호판 대조가 보는 자리', photos.DEFAULT_PLATE_PHOTO_INDEX === 1);
check('13번이 주행거리가 보는 자리', photos.DEFAULT_ODOMETER_PHOTO_INDEX === 13);

console.log('\n[짝짓기]');
const rows = [
  { id: 1, phase: 'start', seq: 1, url: 'a' }, { id: 2, phase: 'end', seq: 1, url: 'b' },
  { id: 3, phase: 'start', seq: 3, url: 'c' },
  { id: 4, phase: 'end', seq: 2, url: 'd' },
];
const pairs = photos.pairByPhase(rows);
check('순번마다 한 줄', pairs.length === 3, String(pairs.length));
check('순번 오름차순', pairs.map((p) => p.seq).join(',') === '1,2,3');
check('같은 순번끼리 짝', pairs[0].start.url === 'a' && pairs[0].end.url === 'b');
// 한쪽만 있는 자리도 남긴다 — 빠진 것이 보여야 "안 찍었다"를 알 수 있다.
check('운행전만 있어도 줄이 남는다', pairs[2].start && pairs[2].end === null);
check('운행후만 있어도 줄이 남는다', pairs[1].end && pairs[1].start === null);
check('빈 입력도 안전', photos.pairByPhase([]).length === 0 && photos.pairByPhase(null).length === 0);

console.log('\n[두 화면이 같은 짝을 본다]');
// 화면이 각자 짝을 지으면 EJS와 Next가 갈린다. 서버가 한 번 짓고 둘 다 그걸 쓴다.
const routes = read('routes/orders.js');
check('서버가 짝을 지어 내려준다',
  (routes.match(/callmanerPhotoPairs: callmanerPhotos\.pairByPhase/g) || []).length === 2,
  '두 화면 모두에 필요하다');
['views/orders/detail.ejs', 'src/app/orders/[id]/CallmanerPhotos.js'].forEach((f) => {
  const src = read(f);
  check(`${f} — 짝을 그대로 그린다`, /photo-pair/.test(src) && /운행전/.test(src) && /운행후/.test(src));
  check(`${f} — 빠진 자리를 남긴다`, /photo-cell empty|photo-cell\.empty|className="photo-cell empty"/.test(src));
});

console.log('\n[실비 영수증]');
check('loadWithReceipts가 있다', typeof extraCharges.loadWithReceipts === 'function');
['views/orders/detail.ejs', 'src/app/orders/[id]/ReceiptGallery.js'].forEach((f) => {
  const src = read(f);
  check(`${f} — 항목과 금액을 함께`, /charge_type/.test(src) && /amount/.test(src));
  // 아직 안 올라온 줄도 남긴다 — 빠진 것이 보여야 받아야 할 영수증을 안다.
  check(`${f} — 없는 영수증을 표시한다`, /영수증이 아직 올라오지 않았습니다/.test(src));
});
// 청구 금액이라 고객에게는 아예 내려주지 않는다(오더상세의 다른 금액 칸과 같은 규칙).
check('고객에게는 영수증을 안 내려준다',
  (routes.match(/receiptCharges: (u|req\.session\.user)\.role === 'client' \? \[\]/g) || []).length === 2);

(async () => {
  console.log('\n[실제 데이터]');
  if (!process.env.DATABASE_URL) { console.log('  건너뜀 — DATABASE_URL 없음'); }
  else {
    try {
      const real = await photos.loadPhotos(237);
      const p = photos.pairByPhase(real);
      check('실제 오더가 짝지어진다', real.length === 0 || p.length > 0, `${real.length}장 → ${p.length}항목`);
      // 짝지어도 사진이 사라지면 안 된다.
      const counted = p.reduce((n, r) => n + (r.start ? 1 : 0) + (r.end ? 1 : 0), 0);
      check('짝지어도 장수가 같다', counted === real.length, `${counted} vs ${real.length}`);
      // 마이그레이션 전이어도 던지지 않아야 한다.
      const withR = await extraCharges.loadWithReceipts(237);
      check('영수증 조회가 던지지 않는다', Array.isArray(withR));
    } catch (e) {
      check('실제 데이터 검사', false, e.message);
    }
  }
  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})();
