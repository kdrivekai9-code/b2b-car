// 챗봇/통보 메시지의 **강조**/'인용'/금액(원)/거리(km) 구간을 굵게 표시하고, 주소(http)는
// 누를 수 있는 링크로 만든다.
// public/js/ai-intake-render.js의 appendTextWithAutoBold와 같은 규칙을 쓴다(레거시 EJS
// 챗봇 화면에는 이미 있던 처리인데, 이 React 버전(Next.js /orders/ai-intake)에는 없어서
// **텍스트** 마커가 그대로 노출되고 있었다).
//
// 링크 처리를 넣은 이유: 능동 통보 본문 끝에 사진 모아보기 주소가 한 줄 붙는데, 여기서는
// 텍스트 노드로만 그려서 고객이 누를 수 없었다(카카오는 평문 주소를 알아서 링크로 만든다).
const LINK_SRC = 'https?:\\/\\/[^\\s<>"\']+';
const BOLD_SRC = "\\*\\*[^*\\n]+\\*\\*|'[^'\\n]+'|\\d{1,3}(?:,\\d{3})*원|\\d+(?:\\.\\d+)?km";

// /g 정규식은 lastIndex를 들고 다녀서 모듈 상수로 공유하면 호출 사이에 상태가 샌다 —
// 호출마다 새로 만든다.
function tokenizer(bold) {
  return new RegExp(bold ? `${LINK_SRC}|${BOLD_SRC}` : LINK_SRC, 'g');
}

function isUrl(token) {
  return /^https?:\/\//.test(token);
}

// 문장 끝의 마침표·닫는괄호까지 주소로 빨아들이지 않는다.
function trimUrlTail(token) {
  return token.replace(/[.,;:)\]}]+$/, '');
}

// bold: false면 링크만 만든다(상담원 화면 — 고객 화면과 달리 강조 서식을 쓰지 않는다).
export function renderChatText(text, options = {}) {
  const bold = options.bold !== false;
  const raw = String(text == null ? '' : text);
  const re = tokenizer(bold);
  const nodes = [];
  let last = 0;
  let match;
  let key = 0;
  while ((match = re.exec(raw)) !== null) {
    const index = match.index;
    let token = match[0];
    if (isUrl(token)) {
      const trimmed = trimUrlTail(token);
      if (trimmed !== token) {
        token = trimmed;
        re.lastIndex = index + token.length;
      }
    }
    if (index > last) nodes.push(raw.slice(last, index));
    if (isUrl(token)) {
      nodes.push(
        <a key={`l${key++}`} href={token} target="_blank" rel="noopener noreferrer">{token}</a>
      );
    } else {
      const content = token.indexOf('**') === 0 ? token.slice(2, -2) : token;
      nodes.push(<strong key={`b${key++}`}>{content}</strong>);
    }
    last = index + token.length;
  }
  if (last < raw.length) nodes.push(raw.slice(last));
  return nodes;
}
