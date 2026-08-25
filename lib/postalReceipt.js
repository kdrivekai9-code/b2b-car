// 우편발송(등기) 요청 건의 인수증 업로드 — 감지 · 링크 · 표기.
//
// 왜 필요한가: 상담 로그에 서류를 우편으로 보내달라는 요청이 반복해서 나온다.
//   "인감, 차량등록증 있으며 서울지점으로 등기발송부탁드립니다"
//   "서류 인감, 등록증 서울지점으로 등기발송부탁드립니다 / 가능하면 우체국이용 부탁드립니다"
//   "배정된 기사에게 등기 발송 요청 드리면 될까요?"
// 그런데 기사가 등기를 부치고 나면 그 등기번호와 인수증이 어디에도 남지 않았다. 고객이
// "보냈나요?"라고 물으면 상담원이 기사에게 따로 확인해야 했다.
//
// 콜마너로 배차된 기사는 우리 기사 앱을 쓰지 않는다. 그래서 접수 시 업로드 링크를 만들어
// 기사메모(적요1)에 실어 보내고, 기사가 그 링크로 등기번호와 인수증 사진을 올리게 한다.
const crypto = require('crypto');

// 우편발송 요청으로 볼 표현.
//
// `등기`만으로는 부족하고 `택배`만으로도 부족하다 — 로그에는 "서류택배로 보내려 하는데"처럼
// 기사가 상황을 설명하는 문장도 있고, 고객이 부탁하는 문장도 있다. 둘 다 "우편으로 보낸다"는
// 같은 일이라 함께 잡는다.
//
// `우편`/`우체국`/`등기`/`택배`가 발송·전달 동사와 함께 있을 때만 잡는다. "등기부등본"처럼
// 서류 이름에 들어간 경우를 배제하기 위해서다.
// 조사가 끼는 경우가 흔하다 — 로그의 "서류택배로 보내려 하는데"처럼 낱말과 동사 사이에 "로"가
// 들어간다. `이용`/`부탁`도 동사로 친다("가능하면 우체국 이용 부탁드립니다").
const POSTAL_WORD = '(?:등기|우편|우체국|택배)';
const POSTAL_VERB = '(?:발송|보내|부치|부쳐|접수|전달|송부|처리|이용|부탁)';
const POSTAL_REQUEST_RE = new RegExp(
  `${POSTAL_WORD}\\s*(?:으로|로|를|을|는|은|에)?\\s*${POSTAL_VERB}`
  + `|(?:발송|보내|부쳐)\\s*(?:주?\\s*(?:세요|시면|시고))?[^\\n]{0,6}${POSTAL_WORD}`
);

function isPostalRequested(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  // 등기부등본은 서류 이름이지 발송 요청이 아니다.
  if (/등기부\s*등본/.test(s) && !/등기\s*(발송|보내|부치)/.test(s)) return false;
  return POSTAL_REQUEST_RE.test(s);
}

// 업로드 링크에 쓸 토큰.
//
// 짧아야 한다. 이 링크는 콜마너 적요1(기사메모)에 실려 나가는데 그 칸이 100Byte뿐이고,
// 차량번호와 기사 전달사항이 이미 그 안에 들어 있기 때문이다(lib/callmaner.js memoWithVehicle).
// UUID(36자)를 쓰면 링크만 71Byte라 기사 전달사항에 4글자밖에 안 남는다. 8자로 줄이면
// 링크가 38Byte가 되어 15글자쯤 남는다.
//
// 8자 base62 = 약 2.2×10^14 가지. 추측으로 남의 오더 업로드 페이지에 닿을 수 있는 수준이
// 아니고, 이 페이지는 조회가 아니라 업로드 전용이라 노출되는 정보도 오더 요약뿐이다.
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generateReceiptToken() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return out;
}

// 공개 주소. lib/kakaoOrderNotify.js의 publicBaseUrl과 같은 환경변수를 본다.
function publicBaseUrl() {
  const raw = String(process.env.PUBLIC_BASE_URL || '').trim();
  return raw.replace(/\/+$/, '') || 'https://b2bcarkr.vercel.app';
}

// 경로가 짧아야 하는 이유는 위 토큰 주석과 같다 — /upload/ 대신 /r/를 쓴다.
function receiptUploadUrl(token) {
  const t = String(token || '').trim();
  return t ? `${publicBaseUrl()}/r/${t}` : null;
}

// 기사메모에 붙일 한 줄. 링크만 덩그러니 두면 무엇을 하라는 것인지 알 수 없어 짧은 이름을 붙인다.
// "영수증 업로드"는 사용자가 정한 표기다.
const RECEIPT_MEMO_LABEL = '영수증 업로드';

function receiptMemoLine(token) {
  const url = receiptUploadUrl(token);
  return url ? `${RECEIPT_MEMO_LABEL} ${url}` : null;
}

module.exports = {
  POSTAL_REQUEST_RE,
  isPostalRequested,
  generateReceiptToken,
  receiptUploadUrl,
  receiptMemoLine,
  publicBaseUrl,
  RECEIPT_MEMO_LABEL,
};
