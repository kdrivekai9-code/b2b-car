// 번호판 대조 검사 — 모델을 부르지 않고 판정 규칙만 본다.
//
// 이 기능이 틀리면 두 방향으로 망가진다:
//   · 헛알림 — 멀쩡한 오더에 "상이"가 붙어 관리자가 곧 무시하게 된다(진짜를 놓친다)
//   · 놓침   — 다른 차가 나갔는데 조용하다
// 앞쪽이 더 위험해서 "애매하면 판정하지 않는다"를 규칙으로 뒀고, 여기서 그걸 확인한다.
require('dotenv').config();

const plateOcr = require('../lib/plateOcr');
const callmanerPhotos = require('../lib/callmanerPhotos');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${e} / 실제 ${a})`}`);
}

console.log('[번호판 표준형(대조 키)]');
check('평범한 번호', plateOcr.plateKey('12가3456'), '12가3456');
check('세 자리 번호', plateOcr.plateKey('123가4567'), '123가4567');
// 접수는 "12가3456"인데 번호판에는 "서울12가3456"이 찍혀 있는 경우가 흔하다.
check('지역명은 뗀다', plateOcr.plateKey('서울12가3456'), '12가3456');
check('띄어쓰기 무시', plateOcr.plateKey('12 가 3456'), '12가3456');
check('하이픈 무시', plateOcr.plateKey('12-가-3456'), '12가3456');
check('문장 속에서도 찾는다', plateOcr.plateKey('차량 12가3456 입니다'), '12가3456');
check('번호판이 아니면 빈 값', plateOcr.plateKey('abc'), '');
check('빈 값', plateOcr.plateKey(''), '');
check('null', plateOcr.plateKey(null), '');

console.log('\n[대조 판정]');
check('같으면 true', plateOcr.comparePlates('12가3456', '12가3456'), true);
check('지역명만 달라도 같은 차', plateOcr.comparePlates('12가3456', '서울12가3456'), true);
check('서로 다른 지역명도 몸통이 같으면 같은 차', plateOcr.comparePlates('서울12가3456', '경기12가3456'), true);
check('숫자가 다르면 false', plateOcr.comparePlates('12가3456', '12가3457'), false);
check('한글이 다르면 false', plateOcr.comparePlates('12가3456', '12나3456'), false);
check('완전히 다르면 false', plateOcr.comparePlates('12가3456', '34나7890'), false);
// 한쪽이라도 못 읽었으면 판정하지 않는다 — null은 "상이"가 아니다.
check('인식 실패는 판정 안 함', plateOcr.comparePlates('12가3456', null), null);
check('접수 번호가 없으면 판정 안 함', plateOcr.comparePlates('', '12가3456'), null);
check('둘 다 없으면 판정 안 함', plateOcr.comparePlates(null, null), null);
check('형식이 아닌 값은 판정 안 함', plateOcr.comparePlates('12가3456', '읽을 수 없음'), null);

console.log('\n[확신도 기준]');
// 계기판(0.6)보다 높게 잡았다 — 여기서 틀리면 관리자에게 헛알림이 간다.
check('0.75 이상만 인정', plateOcr.MIN_CONFIDENCE, 0.75);

console.log('\n[전면 사진 순번]');
check('기본 1번', callmanerPhotos.platePhotoIndex({}), 1);
check('지사 설정이 우선', callmanerPhotos.platePhotoIndex({ plate_photo_index: 3 }), 3);
check('0 이하는 기본값', callmanerPhotos.platePhotoIndex({ plate_photo_index: 0 }), 1);
check('숫자가 아니면 기본값', callmanerPhotos.platePhotoIndex({ plate_photo_index: 'x' }), 1);

console.log('\n[사진 읽기 — 모델 호출을 흉내내서]');
(async () => {
  const fakeImage = async () => ({ ok: true, buffer: Buffer.from('x'), contentType: 'image/jpeg' });
  const read = (out) => plateOcr.readPlate('http://x', { fetchImage: fakeImage, generate: async () => out });

  check('정상 인식', (await read({ plate: '12가3456', confidence: 0.9 })).plate, '12가3456');
  check('확신도 미달이면 null', (await read({ plate: '12가3456', confidence: 0.5 })).plate, null);
  check('빈 번호판이면 null', (await read({ plate: '', confidence: 0.9 })).plate, null);
  // 모델이 설명 문장을 돌려주는 경우가 있다 — 그걸 번호판으로 저장하면 안 된다.
  check('형식이 아니면 null', (await read({ plate: '번호판이 보이지 않습니다', confidence: 0.9 })).plate, null);
  check('확신도가 없으면 null', (await read({ plate: '12가3456' })).plate, null);

  // 링크가 죽은 것과 모델이 못 읽은 것을 구분해야 한다 — 앞쪽만 나중에 다시 시도할 값이 있다.
  const dead = await plateOcr.readPlate('http://x', {
    fetchImage: async () => ({ ok: false, error: '404' }),
    generate: async () => { throw new Error('불려서는 안 된다'); },
  });
  check('사진을 못 받으면 재시도 대상', [dead.plate, dead.retryable], [null, true]);
  const bad = await read({ plate: '', confidence: 0.9 });
  check('모델이 못 읽은 건 재시도 대상 아님', !!bad.retryable, false);

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('검사 실패:', e); process.exit(1); });
