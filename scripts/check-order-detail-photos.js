// 오더상세 탁송사진 배치 — 가로 두 줄, 작게, 클릭하면 확대.
//
// 왜 필요한가(사용자 지정 2026-09-08): 예전에는 짝마다 한 행을 만들어 큰 사진 두 장을 넣었다.
// 13쌍이면 화면이 열세 번 스크롤되고 한 장이 화면 절반을 차지해, 목록으로도 비교용으로도
// 못 썼다. 줄 하나는 운행전, 줄 하나는 운행후이고 **열이 곧 짝**이다.
//
// 여기서 보는 것은 두 화면이 갈리지 않는가다. 같은 섹션이 EJS(views/orders/detail.ejs)와
// Next(src/app/orders/[id]/CallmanerPhotos.js)에 두 벌 있고, 플래그로 갈아 신는다 —
// 한쪽만 고치면 플래그에 따라 배치가 달라진다. 동작 확인은 스펙이 한다
// (tests/manual/order-detail-callmaner-photos.playwright.spec.js).
require('dotenv').config();
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ejs = read('views/orders/detail.ejs');
const next = read('src/app/orders/[id]/CallmanerPhotos.js');
const css = read('public/css/style.css');
const lightbox = read('public/js/photo-lightbox.js');

console.log('[두 화면이 같은 배치를 쓴다]');
[['EJS', ejs], ['Next', next]].forEach(([label, src]) => {
  check(`${label} — 가로 두 줄`, /photo-rails/.test(src) && /rail-strip/.test(src), true);
  check(`${label} — 줄 이름은 운행전·운행후`, /\['start', ?'운행전'\], ?\['end', ?'운행후'\]/.test(src.replace(/"/g, "'")), true);
  // 예전 배치(짝마다 한 행)가 남아 있으면 한쪽만 고친 것이다.
  check(`${label} — 예전 배치가 남지 않았다`, /photo-row\b|photo-pair\b/.test(src), false);
  // 확대는 공용 스크립트가 맡는다 — 화면마다 따로 만들면 동작이 갈린다.
  check(`${label} — 확대 표식`, /data-lightbox/.test(src), true);
  check(`${label} — 캡션을 준다`, /data-caption/.test(src), true);
  // 링크는 남긴다. 스크립트가 죽거나 새 탭으로 열고 싶은 사람에게 예전 동작이 남아야 한다.
  check(`${label} — href를 남긴다`, /href=/.test(src) && /target="_blank"|target={?'_blank'?}/.test(src), true);
  // 두 줄이 따로 굴러가면 열이 어긋나 짝이 깨진다.
  check(`${label} — 두 줄 스크롤을 맞춘다`, /scrollLeft/.test(src), true);
  // 빠진 자리를 남겨야 "안 찍었다"를 알 수 있고 열도 안 밀린다.
  check(`${label} — 빈 자리를 남긴다`, /photo-cell empty/.test(src), true);
});

console.log('\n[CSS]');
check('줄이 스스로 스크롤한다', /\.photo-rail \.rail-strip\{[^}]*overflow-x:auto/.test(css), true);
// min-width:0이 없으면 flex 항목이 내용 폭만큼 벌어져, 줄이 아니라 페이지가 옆으로 밀린다.
check('줄이 줄어들 수 있다(min-width:0)', /\.photo-rail \.rail-strip\{[^}]*min-width:0/.test(css), true);
// 격자 칸이 안 줄어들면 카드가 화면보다 넓어지고, .app{overflow-x:clip}이 넘친 부분을
// 잘라내 뒤쪽 사진에 아예 닿을 수 없다(실측으로 잡았다).
check('격자 칸도 줄어들 수 있다', /\.detail-grid > \*\{min-width:0;\}/.test(css), true);
check('칸이 작다(84px)', /\.photo-rail \.photo-cell\{[^}]*width:84px/.test(css), true);
check('확대 창이 있다', /\.lightbox\{/.test(css), true);
// 콜마너 원본이 400x300이라 화면을 채우게 늘리면 뭉개진다 — 두 배까지만.
check('확대는 원본 두 배까지', /\.lightbox \.lb-img\{width:min\(90vw, 800px\)/.test(css), true);

console.log('\n[확대 스크립트]');
check('묶음 단위로 넘긴다', /data-lightbox="' \+ name \+ '"/.test(lightbox), true);
check('←/→/Esc를 받는다', /ArrowLeft/.test(lightbox) && /ArrowRight/.test(lightbox) && /Escape/.test(lightbox), true);
// 새 탭으로 열려는 의도(⌘/Ctrl/가운데클릭)는 가로채지 않는다.
check('새 탭 의도는 건드리지 않는다', /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.button !== 0/.test(lightbox), true);
// 사진 자체를 눌렀을 때 닫히면, 확대해 보는 중에 손이 스치면 사라진다.
check('바닥을 눌러야 닫힌다', /e\.target === box/.test(lightbox), true);

console.log('\n[두 껍데기가 같은 스크립트를 싣는다]');
// 한쪽만 넣으면 플래그에 따라 확대가 사라진다(hint-tooltip.js와 같은 함정).
check('EJS 푸터', /\/js\/photo-lightbox\.js/.test(read('views/partials/footer.ejs')), true);
check('Next 셸', /\/js\/photo-lightbox\.js/.test(read('src/app/_components/AppShell.js')), true);

console.log('\n[같은 화면의 영수증 사진도 같은 방식으로 열린다]');
// 같은 화면에서 같은 모양의 썸네일이 다르게 동작하면 하나가 고장난 것으로 읽힌다.
check('EJS 영수증', /data-lightbox="receipt-/.test(ejs), true);
check('Next 영수증', /data-lightbox=\{`receipt-/.test(read('src/app/orders/[id]/ReceiptGallery.js')), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
