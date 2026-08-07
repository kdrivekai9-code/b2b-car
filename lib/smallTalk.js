// 인사·자기소개 같은 스몰토크 응답 — 웹 챗봇(routes/orders.js)과 카카오 상담톡
// (routes/kakaoConsult.js)이 같은 규칙을 쓰도록 공용 모듈로 분리했다.
//
// 왜 필요한가: 이게 없으면 "안녕하세요"가 FAQ 지식검색으로 흘러가고, 유사도 문턱을 넘는
// 아무 항목이나 걸려 엉뚱한 답이 나간다(실제로 카카오에서 인사에 "공지사항 메뉴는…" 안내가
// 발송됐다). 검색 전에 먼저 걸러내는 것이 핵심이다.

function isGreeting(text) {
  return /^(?:안녕(?:하세요)?|안녕하십니까|반갑습니다|하이|hi|hello|헬로|좋은\s?(?:아침|오후|저녁))[!！?.\s]*$/i.test(text);
}

// 업무 단어가 섞여 있으면 스몰토크가 아니라 실제 문의로 본다("취소 방법 알려줘" 같은 것이
// 자기소개 패턴에 걸리는 것을 막는다).
function hasBusinessKeyword(text) {
  return /(오더|접수|출발|도착|경유|요금|결제|주소|연락처|배정|기사|등록|취소|수정|공지|푸시|알림|지사)/i.test(text);
}

// FAQ 검색 전에 스몰토크를 우선 처리해 "답변을 찾지 못했습니다" 같은 어색한 실패 응답을 줄인다.
function getSmalltalkMessage(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  if (!hasBusinessKeyword(normalized) && /(넌\s*누구(?:니|야)?|너(는|가)?\s*누구(?:니|야)?|누구(?:니|야)|정체|자기소개|소개해\s*줘|봇이야|ai야)/i.test(normalized)) {
    return '저는 탁송·대리운전(프리미엄) 오더 접수와 업무 안내를 도와드리는 AI 챗봇입니다. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.';
  }

  if (!hasBusinessKeyword(normalized) && /(뭘\s*할\s*수\s*있|무엇을\s*도와|어떤\s*업무|사용법|어떻게\s*써|도움\s*줘)/i.test(normalized)) {
    return '오더 접수 내용 자동 입력(탁송·대리운전), FAQ 안내, 처리 어려운 요청의 상담원 연결을 도와드릴 수 있습니다. 원하시는 내용을 말씀해주세요.';
  }

  if (/(^|\s)(안녕(?:하세요)?|하이|hello|hi|헬로|반가워)(\s|$)/i.test(normalized)) {
    return '안녕하세요. 오더 접수 내용을 입력하시거나, 궁금한 점을 질문해주세요.';
  }

  return null;
}

module.exports = { isGreeting, hasBusinessKeyword, getSmalltalkMessage };
