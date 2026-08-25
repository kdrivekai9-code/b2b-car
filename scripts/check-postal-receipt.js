// 우편발송(등기) 요청 감지 · 기사메모 링크 · 통보 문구를 확인한다.
//
// 왜: 상담 로그에 서류를 우편으로 보내달라는 요청이 반복해서 나오는데("인감, 차량등록증 있으며
// 서울지점으로 등기발송부탁드립니다"), 기사가 등기를 부치고 나면 등기번호와 인수증이 어디에도
// 남지 않았다. 고객이 "보냈나요?"라고 물으면 상담원이 기사에게 따로 확인해야 했다.
//
// 콜마너로 배차된 기사는 우리 기사 앱을 쓰지 않는다. 그래서 접수 시 업로드 링크를 만들어
// 기사메모(적요1)에 실어 보낸다. 그 칸이 100Byte뿐이라 링크 길이가 곧 설계 제약이다.
//
// 순수 판정·조합이라 네트워크도 DB도 쓰지 않는다.
//
//   node scripts/check-postal-receipt.js
const postal = require('../lib/postalReceipt');
const callmaner = require('../lib/callmaner');
const notify = require('../lib/kakaoOrderNotify');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}
const B = (s) => Buffer.byteLength(String(s || ''), 'utf8');

console.log('[우편발송 요청 감지 — 로그 실제 문장]');
check('등기발송 부탁', postal.isPostalRequested('인감, 차량등록증 있으며 서울지점으로 등기발송부탁드립니다.'), true);
check('서류 등기발송', postal.isPostalRequested('서류 인감, 등록증 서울지점으로 등기발송부탁드립니다.'), true);
check('기사에게 등기 발송 요청', postal.isPostalRequested('배정된 기사에게 등기 발송 요청 드리면 될까요?'), true);
check('서류택배로 보내려 한다', postal.isPostalRequested('기사님 도착지 편의점에서 서류택배로 보내려 하는데'), true);
check('우체국 이용 부탁', postal.isPostalRequested('가능하면 우체국 이용 부탁드립니다.'), true);

console.log('\n[우편발송이 아닌 것 — 링크를 붙이면 적요1만 축낸다]');
check('현장 지시', postal.isPostalRequested('경비실에 키 전달 부탁드립니다.'), false);
check('주유 요청', postal.isPostalRequested('경유 2만원 주유 부탁드립니다.'), false);
check('서류만 언급', postal.isPostalRequested('서류: 인감, 자동차등록증'), false);
// 서류 이름에 '등기'가 들어간 경우 — 발송 요청이 아니다.
check('등기부등본', postal.isPostalRequested('등기부등본 지참 부탁드립니다.'), false);
check('빈 값', postal.isPostalRequested(''), false);

console.log('\n[토큰 — 적요1(100Byte)에 들어가야 한다]');
{
  const t = postal.generateReceiptToken();
  check('8자', t.length, 8);
  // 헷갈리는 글자(0/O, 1/l/I)는 뺐다 — 기사가 눈으로 옮겨 적을 수도 있다.
  check('헷갈리는 글자를 쓰지 않는다', /[0O1lI]/.test(t), false);
  const url = postal.receiptUploadUrl(t);
  console.log(`      링크: ${url} (${B(url)}byte)`);
  check('링크가 40byte 이하', B(url) <= 40, true);
}

console.log('\n[기사메모(적요1) 조합]');
{
  const order = {
    vehicle_number: '335모6328',
    memo_driver_brief: '경비실 키 전달',
    postal_requested: true,
    receipt_upload_token: 'Ab3xK9pQ',
  };
  const memo = callmaner.memoWithVehicle(order);
  console.log(`      ${memo}`);
  console.log(`      (${B(memo)}byte / 상한 100byte)`);
  check('차량번호가 맨 앞', memo.startsWith('335모6328'), true);
  // 링크가 잘리면 아예 못 누른다 — 기사 전달사항보다 앞에 둔다.
  check('링크가 기사 전달사항보다 앞', memo.indexOf('/r/Ab3xK9pQ') < memo.indexOf('경비실'), true);
  check('"영수증 업로드" 표기', memo.includes('영수증 업로드'), true);
  check('100byte를 넘지 않는다', B(callmaner.truncateBytes(memo, 100)) <= 100, true);
  check('잘라도 링크가 살아남는다', callmaner.truncateBytes(memo, 100).includes('/r/Ab3xK9pQ'), true);

  // 우편발송 건이 아니면 예전 그대로 — 다른 오더의 기사 전달사항을 축내면 안 된다.
  const plain = callmaner.memoWithVehicle({ ...order, postal_requested: false });
  check('우편발송이 아니면 링크 없음', plain, '335모6328 / 경비실 키 전달');
}

console.log('\n[통보 문구]');
{
  const order = { oid: 'OID1460', order_type: 'dispatch' };
  const setting = notify.DEFAULT_EVENT_SETTINGS.receipt_uploaded;
  const withNo = notify.buildMessage('receipt_uploaded', order, setting, { trackingNo: '1234567890123' });
  console.log(`      ${String(withNo.text).replace(/\n/g, '\n      ')}`);
  check('등기번호가 들어간다', withNo.text.includes('1234567890123'), true);
  check('사진을 함께 보낸다', withNo.attachPhotos, true);

  // 사진만 올리고 번호를 모르는 경우 — 빈 줄이 남으면 안 된다.
  const noNo = notify.buildMessage('receipt_uploaded', order, setting, {});
  check('번호가 없으면 그 줄이 사라진다', /등기번호:/.test(noNo.text), false);
}

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
