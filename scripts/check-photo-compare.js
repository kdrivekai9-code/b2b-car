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

console.log('[항목 이름 — 단계마다 다르다]');
// 콜마너 촬영 순서는 운행전과 운행후가 다르다(사용자 확정 2026-09-08): 운행후에는 계기판이
// **맨 앞**으로 오고 나머지가 한 칸씩 밀린다. 이걸 몰라서 두 가지가 조용히 틀려 있었다 —
// 주행거리 종료값을 보조석 앞바퀴 사진에서 읽으려 했고(그래서 전부 실패),
// 운행전 전면과 운행후 계기판을 나란히 놓고 비교했다.
check('운행전 1번은 전면', photos.photoLabel(1, 'start') === '1. 전면', photos.photoLabel(1, 'start'));
check('운행후 1번은 계기판', photos.photoLabel(1, 'end') === '1. 계기판', photos.photoLabel(1, 'end'));
check('운행전 13번은 계기판', photos.photoLabel(13, 'start') === '13. 계기판');
check('운행후 13번은 보조석 앞 바퀴', photos.photoLabel(13, 'end') === '13. 보조석 앞 바퀴', photos.photoLabel(13, 'end'));
check('운행후는 운행전보다 한 칸 밀린다',
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].every((n) => photos.photoItem(n, 'start') === photos.photoItem(n + 1, 'end')));
check('운행후 1번이 운행전 마지막', photos.photoItem(1, 'end') === photos.photoItem(13, 'start'));
// 두 단계 모두 같은 열세 항목을 찍는다 — 하나라도 빠지면 짝지을 수 없는 항목이 생긴다.
check('두 단계의 항목 집합이 같다',
  JSON.stringify([...photos.PHOTO_ITEMS.start].sort()) === JSON.stringify([...photos.PHOTO_ITEMS.end].sort()));
check('열세 장씩', photos.PHOTO_ITEMS.start.length === 13 && photos.PHOTO_ITEMS.end.length === 13);
// 표 밖은 아는 척하지 않는다.
check('표 밖은 번호만', photos.photoLabel(14, 'start') === '14번', photos.photoLabel(14, 'start'));

console.log('\n[순번을 코드에 박지 않는다]');
// 계기판·전면 순번을 상수로 박으면 표와 어긋나는 순간 조용히 틀린 사진을 읽는다 —
// 주행거리 버그가 정확히 그것이었다.
check('계기판 순번을 표에서 가져온다',
  photos.seqOfItem('계기판', 'start') === 13 && photos.seqOfItem('계기판', 'end') === 1);
check('전면 순번도 표에서', photos.seqOfItem('전면', 'start') === 1 && photos.seqOfItem('전면', 'end') === 2);
// 주행거리는 단계별로 다른 자리를 봐야 한다.
check('주행거리 자리 — 운행전 13', photos.odometerPhotoIndex({}, 'start') === 13);
check('주행거리 자리 — 운행후 1', photos.odometerPhotoIndex({}, 'end') === 1, String(photos.odometerPhotoIndex({}, 'end')));
// 지사 재정의는 운행전 기준으로 적힌 값이라, 운행후에 그대로 쓰면 버그가 돌아온다.
check('지사 재정의는 운행전에만', photos.odometerPhotoIndex({ odometer_photo_index: 5 }, 'start') === 5
  && photos.odometerPhotoIndex({ odometer_photo_index: 5 }, 'end') === 1);
// 번호판은 운행전 전면에서 읽는다.
check('번호판 자리는 운행전 전면', photos.platePhotoIndex({}) === photos.seqOfItem('전면', 'start'));
check('1번이 번호판 대조가 보는 자리', photos.DEFAULT_PLATE_PHOTO_INDEX === 1);
check('13번이 주행거리가 보는 자리(운행전)', photos.DEFAULT_ODOMETER_PHOTO_INDEX === 13);

console.log('\n[짝짓기 — 순번이 아니라 항목으로]');
// 운행전 전면(1)과 운행후 전면(2)이 한 줄이어야 한다. 순번으로 지으면 운행전 전면(1)과
// 운행후 계기판(1)이 한 줄이 된다 — 실제로 그렇게 나가고 있었다.
const rows = [
  { id: 1, phase: 'start', seq: 1, url: 'a' }, { id: 2, phase: 'end', seq: 2, url: 'b' },
  { id: 3, phase: 'start', seq: 3, url: 'c' },
  { id: 4, phase: 'end', seq: 1, url: 'd' },
];
const pairs = photos.pairByPhase(rows);
check('항목마다 한 줄', pairs.length === 3, String(pairs.length));
// 줄 순서는 운행전 촬영 순서를 따른다(전면 → 보조석 측면 → 운전석 측면 → … → 계기판).
check('운행전 순서대로', pairs.map((p) => p.label).join(',') === '전면,운전석 측면,계기판',
  pairs.map((p) => p.label).join(','));
// 전면끼리 짝지어야 한다 — 운행전 1번과 운행후 **2번**이다.
check('전면끼리 짝', pairs[0].start.url === 'a' && pairs[0].end.url === 'b');
check('단계별 순번을 함께 준다', pairs[0].startSeq === 1 && pairs[0].endSeq === 2,
  `${pairs[0].startSeq}/${pairs[0].endSeq}`);
// 계기판은 운행후 1번이다 — 순번으로 지었다면 이 자리에 전면 사진이 붙었다.
check('계기판은 운행후 1번과 짝', pairs[2].label === '계기판' && pairs[2].end.url === 'd');
// 한쪽만 있는 자리도 남긴다 — 빠진 것이 보여야 "안 찍었다"를 알 수 있다.
check('운행전만 있어도 줄이 남는다', pairs[1].start && pairs[1].end === null);
check('운행후만 있어도 줄이 남는다', pairs[2].start === null && !!pairs[2].end);
check('빈 입력도 안전', photos.pairByPhase([]).length === 0 && photos.pairByPhase(null).length === 0);

console.log('\n[두 화면이 같은 짝을 본다]');
// 화면이 각자 짝을 지으면 EJS와 Next가 갈린다. 서버가 한 번 짓고 둘 다 그걸 쓴다.
const routes = read('routes/orders.js');
check('서버가 짝을 지어 내려준다',
  (routes.match(/callmanerPhotoPairs: callmanerPhotos\.pairByPhase/g) || []).length === 2,
  '두 화면 모두에 필요하다');
['views/orders/detail.ejs', 'src/app/orders/[id]/CallmanerPhotos.js'].forEach((f) => {
  const src = read(f);
  // 2026-09-08부터 배치가 가로 두 줄이다(줄 하나가 운행전, 하나가 운행후, 열이 곧 짝) —
  // 예전의 photo-pair(짝마다 한 행)는 없다. 서버가 지은 짝을 그대로 훑는지만 본다.
  check(`${f} — 짝을 그대로 그린다`,
    /photo-rails/.test(src) && /운행전/.test(src) && /운행후/.test(src)
    && /pairs\.forEach|rows\.map/.test(src));
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
