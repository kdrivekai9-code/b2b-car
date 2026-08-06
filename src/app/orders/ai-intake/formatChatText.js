// 챗봇 메시지의 **강조**/'인용'/금액(원)/거리(km) 구간을 굵게 표시한다.
// public/js/ai-intake-render.js의 appendTextWithAutoBold와 같은 정규식을 쓴다(레거시 EJS
// 챗봇 화면에는 이미 있던 처리인데, 이 React 버전(Next.js /orders/ai-intake)에는 없어서
// **텍스트** 마커가 그대로 노출되고 있었다).
const AUTO_BOLD_RE = /\*\*[^*\n]+\*\*|'[^'\n]+'|\d{1,3}(?:,\d{3})*원|\d+(?:\.\d+)?km/g;

export function renderChatText(text) {
  const raw = String(text == null ? '' : text);
  const nodes = [];
  let last = 0;
  let match;
  let key = 0;
  AUTO_BOLD_RE.lastIndex = 0;
  while ((match = AUTO_BOLD_RE.exec(raw)) !== null) {
    const index = match.index;
    if (index > last) nodes.push(raw.slice(last, index));
    const content = match[0].indexOf('**') === 0 ? match[0].slice(2, -2) : match[0];
    nodes.push(<strong key={`b${key++}`}>{content}</strong>);
    last = index + match[0].length;
  }
  if (last < raw.length) nodes.push(raw.slice(last));
  return nodes;
}
