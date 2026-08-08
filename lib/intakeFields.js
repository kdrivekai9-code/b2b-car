// 탁송 접수에 필요한 필드와 질문 문구 — 웹 접수 화면과 카카오 상담톡이 공유하는 단 하나의 정의.
//
// 왜 서버로 옮겼나: 같은 정의가 두 곳에 있었다. 웹은 브라우저(public/js/ai-intake.js의
// REQUIRED_FIELDS)에, 카카오는 서버(lib/kakaoIntakeParser.js의 MISSING_PROMPTS)에. 그래서
// "빠진 항목 되묻기" 문구를 고칠 때 양쪽을 찾아 고쳐야 했고, 실제로 확인 요약을 붙이는 작업에서
// 네 군데를 손대야 했다. 필드가 하나 늘거나 문구가 바뀌면 또 갈라진다.
//
// 이 모듈은 순수하다 — DB도 네트워크도 모른다. 그래서 서버(require)와 브라우저(/orders/
// ai-intake/fields.json으로 받아 씀) 양쪽이 같은 값을 쓸 수 있고, 테스트도 Node에서 바로 된다.
//
// 접수 대화 전체(주소 후보 선택·요금 확인·최종 확인)를 옮기는 건 별개의 큰 작업이다. 여기서는
// "무엇이 필요하고 어떻게 물을지"만 한 벌로 만든다 — 그 한 조각이 지금 가장 자주 갈라지던 곳이다.

// 수집 순서 = 배열 순서. 웹 위젯이 이 순서로 물어보고 있어 그대로 유지한다.
const DISPATCH_FIELDS = [
  {
    id: 'reserved_date',
    label: '예약일시',
    type: 'datetime',
    question: '예약시간을 말씀해주세요? (예: 내일오후 3시출발, 23일 2시 도착)',
    // 되묻기 목록(카카오)에서 쓰는 짧은 이름 — 문장 안에 나열되므로 괄호 예시를 빼야 읽힌다.
    shortLabel: '탁송 일시(즉시 또는 시간)',
  },
  {
    id: 'origin_address',
    label: '출발지 주소',
    type: 'address',
    kind: 'origin',
    question: '차량을 픽업할 출발지 주소를 알려주세요?',
    shortLabel: '출발지 주소',
  },
  {
    id: 'origin_contact',
    label: '출발지 연락처',
    type: 'phone',
    question: '출발지 담당자 연락처를 알려주세요? (예: 010-1234-5678)',
    shortLabel: '출발지 연락처',
  },
  {
    id: 'vehicle_number',
    label: '차량번호',
    type: 'vehicle',
    question: '차량번호를 알려주세요? (출발지 도착 후 확인 가능하면 "다음" 또는 "없어"라고 답해주셔도 됩니다)',
    shortLabel: '차량번호',
  },
  {
    id: 'destination_address',
    label: '도착지 주소',
    type: 'address',
    kind: 'destination',
    question: '차량을 인도할 도착지 주소를 알려주세요?',
    shortLabel: '도착지 주소',
  },
  {
    id: 'destination_contact',
    label: '도착지 연락처',
    type: 'phone',
    question: '도착지 담당자 연락처를 알려주세요? (예: 010-1234-5678)',
    shortLabel: '도착지 연락처',
  },
];

// 카카오 접수 폼 경로는 이 넷만 필수로 본다. 연락처는 폼에 없어도 접수가 되기 때문이다
// (실사용 로그에서 양쪽 연락처가 모두 있는 폼은 93%) — 없다고 되묻기 시작하면 나머지 7%가
// 접수를 못 한다. 웹 위젯은 대화로 하나씩 받으므로 연락처까지 전부 묻는다.
const KAKAO_REQUIRED_FIELD_IDS = ['origin_address', 'destination_address', 'vehicle_number', 'reserved_date'];

function getField(id) {
  return DISPATCH_FIELDS.find((f) => f.id === id) || null;
}

// 되묻기 목록에 쓸 짧은 이름. 없는 id는 걸러낸다(호출부가 임의 문자열을 넘겨도 안전하게).
function shortLabelsFor(fieldIds) {
  return (fieldIds || [])
    .map((id) => {
      const f = getField(id);
      return f ? (f.shortLabel || f.label) : null;
    })
    .filter(Boolean);
}

// 다음에 물어볼 필드 — 값이 비어 있는 첫 필드. 웹 위젯의 getNextMissingField와 같은 규칙이다.
// skip에 담긴 id는 이미 "없다"고 답한 항목이라 건너뛴다(차량번호 "없어" 등).
function nextMissingField(values, options = {}) {
  const skip = new Set(options.skip || []);
  const fields = options.fields || DISPATCH_FIELDS;
  for (const field of fields) {
    if (skip.has(field.id)) continue;
    const v = values ? values[field.id] : null;
    if (v === undefined || v === null || String(v).trim() === '') return field;
  }
  return null;
}

module.exports = {
  DISPATCH_FIELDS,
  KAKAO_REQUIRED_FIELD_IDS,
  getField,
  shortLabelsFor,
  nextMissingField,
};
