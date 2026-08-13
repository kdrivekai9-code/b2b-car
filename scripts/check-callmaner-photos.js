#!/usr/bin/env node
// 콜마너 탁송사진(ConsPicture) 파싱과 계기판 사진 찾기 — DB/네트워크 없이 순수 로직만 본다.
//
// 왜 필요한가: 계기판 사진을 "13번째"라는 순번으로 찾기 때문에 순번 보존이 깨지면 엉뚱한
// 사진에서 숫자를 읽어 고객에게 잘못된 주행거리를 통보한다.
//
// 사용법: node scripts/check-callmaner-photos.js
const { pictureLinks } = require('../lib/callmaner');
const { findOdometerPhoto, odometerPhotoIndex, DEFAULT_ODOMETER_PHOTO_INDEX } = require('../lib/callmanerPhotos');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) console.log(`       기대: ${JSON.stringify(expected)}\n       실제: ${JSON.stringify(actual)}`);
}

console.log('[ConsPicture 링크 파싱]');
check('picLink 목록을 뽑는다', pictureLinks([{ picLink: 'a.jpg' }, { picLink: 'b.jpg' }]), ['a.jpg', 'b.jpg']);
check('공백은 다듬는다', pictureLinks([{ picLink: '  a.jpg  ' }]), ['a.jpg']);
check('빈 링크는 버린다', pictureLinks([{ picLink: '' }, { picLink: 'b.jpg' }, {}]), ['b.jpg']);
// 콜마너가 문자열 배열로 줄 수도 있어 둘 다 받는다(응답 형태가 문서와 다른 사례가 여럿 있었다).
check('문자열 배열도 받는다', pictureLinks(['a.jpg', 'b.jpg']), ['a.jpg', 'b.jpg']);
check('스네이크 케이스도 받는다', pictureLinks([{ pic_link: 'a.jpg' }]), ['a.jpg']);
check('배열이 아니면 빈 배열', pictureLinks(null), []);
check('없는 필드면 빈 배열', pictureLinks([{ other: 'x' }]), []);

console.log('[계기판 사진 인덱스]');
check('기본값은 13', DEFAULT_ODOMETER_PHOTO_INDEX, 13);
check('지사 설정이 없으면 기본값', odometerPhotoIndex({}), 13);
check('지사 설정을 쓴다', odometerPhotoIndex({ odometer_photo_index: 5 }), 5);
check('0 이하는 기본값으로 되돌린다', odometerPhotoIndex({ odometer_photo_index: 0 }), 13);
check('음수도 기본값', odometerPhotoIndex({ odometer_photo_index: -3 }), 13);
check('숫자가 아니면 기본값', odometerPhotoIndex({ odometer_photo_index: 'abc' }), 13);

console.log('[계기판 사진 찾기]');
const photos = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, seq: i + 1, url: `p${i + 1}.jpg` }));
check('13번째를 찾는다', findOdometerPhoto(photos, 13).url, 'p13.jpg');
check('지사가 5번째로 바꾸면 5번째', findOdometerPhoto(photos, 5).url, 'p5.jpg');
// 장수가 모자라면 계산을 건너뛴다 — 없는 사진을 억지로 고르면 엉뚱한 숫자를 읽는다.
check('장수가 모자라면 null', findOdometerPhoto(photos.slice(0, 10), 13), null);
check('사진이 없으면 null', findOdometerPhoto([], 13), null);
check('배열이 아니면 null', findOdometerPhoto(null, 13), null);
// 순번은 배열 위치가 아니라 seq 값으로 찾는다 — 중간이 빠져도 13번째 사진을 정확히 집는다.
check(
  '중간이 빠져도 seq로 찾는다',
  findOdometerPhoto([{ seq: 1, url: 'a' }, { seq: 13, url: 'odo' }], 13).url,
  'odo'
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
