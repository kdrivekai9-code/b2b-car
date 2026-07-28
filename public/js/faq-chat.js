// FAQ 챗봇: 질문을 서버(/faq/ask)로 보내 RAG 검색 결과를 말풍선으로 표시한다.
(function () {
  const messages = document.getElementById('faqMessages');
  const input = document.getElementById('faqQuestionInput');
  const askBtn = document.getElementById('faqAskBtn');
  if (!messages || !input || !askBtn) return;

  function addBubble(text, who) {
    const div = document.createElement('div');
    div.className = 'ai-chat-bubble ' + (who === 'user' ? 'ai-user' : 'ai-bot');
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function ask() {
    const question = input.value.trim();
    if (!question) return;
    addBubble(question, 'user');
    input.value = '';
    askBtn.disabled = true;

    fetch('/faq/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ question }),
    })
      // 서버 전역 에러 핸들러가 JSON이 아닌 응답을 보낼 가능성에 대비해 안전하게 파싱한다
      // (실제 에러 대신 "JSON이 아니다"라는 파싱 에러가 노출되는 문제가 다른 곳에서 있었음).
      .then((res) => res.json().catch(() => ({ error: '서버 응답을 읽는 중 문제가 발생했습니다. (상태 코드: ' + res.status + ')' })))
      .then((data) => {
        askBtn.disabled = false;
        if (data.error) { addBubble('오류: ' + data.error, 'bot'); return; }
        if (!data.matches || data.matches.length === 0) {
          addBubble('죄송합니다, 관련된 답변을 찾지 못했습니다. 상담원에게 문의해주세요.', 'bot');
          return;
        }
        data.matches.forEach((m) => {
          addBubble('[' + m.category + '] ' + m.answer, 'bot');
        });
      })
      .catch((err) => {
        askBtn.disabled = false;
        var detail = err && err.message ? ' (' + err.message + ')' : '';
        addBubble('오류가 발생했습니다.' + detail + ' 다시 시도해주세요.', 'bot');
      });
  }

  askBtn.addEventListener('click', ask);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
})();
