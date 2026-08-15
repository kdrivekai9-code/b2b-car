(function () {
  function create(options) {
    var textarea = options.textarea;
    var messages = options.messages;
    var aiConnectionEl = options.aiConnectionEl;
    var aiConnectionTextEl = options.aiConnectionTextEl;
    var chatInputCollapsedHeight = options.chatInputCollapsedHeight || 64;
    var getLastBotRow = options.getLastBotRow || function () { return null; };
    var setLastBotRow = options.setLastBotRow || function () {};

    function scrollMessagesToBottom() {
      messages.scrollTop = messages.scrollHeight;
    }

    function collapseChatInput() {
      textarea.style.height = chatInputCollapsedHeight + 'px';
    }

    function clearGuidePlaceholder() {
      textarea.placeholder = '';
    }

    function setAiConnectionStatus(state, detail) {
      if (!aiConnectionEl || !aiConnectionTextEl) return;
      aiConnectionEl.classList.remove('online', 'offline');
      aiConnectionEl.removeAttribute('title');
      if (state === 'online') {
        aiConnectionEl.classList.add('online');
        aiConnectionTextEl.textContent = 'AI 연결 정상';
        aiConnectionEl.title = 'AI 연결 정상';
        return;
      }
      if (state === 'offline') {
        aiConnectionEl.classList.add('offline');
        var reasonText = detail && detail.message ? detail.message : 'AI 연결 실패';
        aiConnectionTextEl.textContent = 'AI 연결 실패';
        aiConnectionEl.title = reasonText;
        aiConnectionEl.setAttribute('aria-label', 'AI 연결 실패: ' + reasonText);
        return;
      }
      aiConnectionTextEl.textContent = 'AI 연결 확인중';
      aiConnectionEl.title = 'AI 연결 확인중';
    }

    // 강조 구간은 굵게, 주소(http)는 누를 수 있는 링크로. Next 버전은
    // src/app/orders/ai-intake/formatChatText.js에 같은 규칙이 있다 — 한쪽만 고치면 갈라진다.
    //
    // 링크 처리가 필요한 이유: 능동 통보 본문 끝에 사진 모아보기 주소가 한 줄 붙는데, 텍스트
    // 노드로만 그리면 고객이 누를 수 없다(카카오는 평문 주소를 알아서 링크로 만들어준다).
    function appendTextWithAutoBold(container, text) {
      var raw = String(text == null ? '' : text);
      var re = /https?:\/\/[^\s<>"']+|\*\*[^*\n]+\*\*|'[^'\n]+'|\d{1,3}(?:,\d{3})*원|\d+(?:\.\d+)?km/g;
      var last = 0;
      var match;
      while ((match = re.exec(raw)) !== null) {
        var index = match.index;
        var token = match[0];
        var isUrl = token.indexOf('http') === 0;
        if (isUrl) {
          // 문장 끝의 마침표·닫는괄호까지 주소로 빨아들이지 않는다.
          var trimmed = token.replace(/[.,;:)\]}]+$/, '');
          if (trimmed !== token) {
            token = trimmed;
            re.lastIndex = index + token.length;
          }
        }
        if (index > last) container.appendChild(document.createTextNode(raw.slice(last, index)));
        if (isUrl) {
          var a = document.createElement('a');
          a.href = token;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = token;
          container.appendChild(a);
        } else {
          var strong = document.createElement('strong');
          strong.textContent = token.indexOf('**') === 0 ? token.slice(2, -2) : token;
          container.appendChild(strong);
        }
        last = index + token.length;
      }
      if (last < raw.length) container.appendChild(document.createTextNode(raw.slice(last)));
    }

    function parseKstDateTime(raw) {
      if (!raw) return null;
      if (raw instanceof Date) return raw;
      var s = String(raw).trim();
      var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/);
      if (!m) {
        var d = new Date(s);
        return isNaN(d.getTime()) ? null : d;
      }
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0);
    }

    function pad2(n) {
      return String(n).padStart(2, '0');
    }

    function formatBubbleTime(raw) {
      var d = parseKstDateTime(raw) || new Date();
      var hour = d.getHours();
      var minute = d.getMinutes();
      var ampm = hour < 12 ? '오전' : '오후';
      var hour12 = hour % 12 || 12;
      return ampm + ' ' + pad2(hour12) + ':' + pad2(minute);
    }

    function formatRecentDateTime(raw) {
      var d = parseKstDateTime(raw);
      if (!d) return '';
      return String(d.getMonth() + 1) + '.' + String(d.getDate());
    }

    function streamPlainText(container, text, onDone) {
      var raw = String(text == null ? '' : text);
      if (!raw) {
        if (typeof onDone === 'function') onDone();
        return;
      }
      var idx = 0;
      var step = Math.max(1, Math.ceil(raw.length / 120));
      (function tick() {
        idx = Math.min(raw.length, idx + step);
        container.textContent = raw.slice(0, idx);
        scrollMessagesToBottom();
        if (idx >= raw.length) {
          if (typeof onDone === 'function') onDone();
          return;
        }
        setTimeout(tick, 14);
      })();
    }

    function appendBubbleRow(bubbleDiv, who, timeText) {
      var row = document.createElement('div');
      row.className = 'ai-chat-row ' + (who === 'user' ? 'ai-row-user' : 'ai-row-start');
      var timeEl = document.createElement('span');
      timeEl.className = 'bubble-time';
      timeEl.textContent = timeText;
      if (who === 'user') {
        row.appendChild(timeEl);
        row.appendChild(bubbleDiv);
      } else {
        row.appendChild(bubbleDiv);
        row.appendChild(timeEl);
      }
      messages.appendChild(row);
      return row;
    }

    // 첨부 사진(콜마너 탁송사진) 썸네일 + 원본 링크. 링크는 콜마너 CDN을 가리키고 만료될 수
    // 있어, 썸네일이 깨지면(onerror) 이미지만 숨기고 링크 글자는 남긴다 — 사진을 못 보더라도
    // "사진이 있었다"는 사실과 주소는 남아야 한다.
    // innerHTML을 쓰지 않는다(이 파일의 다른 렌더러와 같은 이유 — 서버가 준 값이 그대로 들어온다).
    function appendAttachments(parent, attachments) {
      if (!Array.isArray(attachments) || !attachments.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'ai-chat-attachments';
      attachments.forEach(function (item, idx) {
        var url = item && item.url ? String(item.url) : '';
        if (!url) return;
        var link = document.createElement('a');
        link.className = 'ai-chat-attachment';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        var img = document.createElement('img');
        img.src = url;
        img.alt = (item && item.caption) ? String(item.caption) : ('첨부 사진 ' + (idx + 1));
        img.addEventListener('error', function () { img.style.display = 'none'; });
        link.appendChild(img);
        var cap = document.createElement('span');
        cap.textContent = (item && item.caption) ? String(item.caption) : ('사진 ' + (idx + 1));
        link.appendChild(cap);
        wrap.appendChild(link);
      });
      if (wrap.childNodes.length) parent.appendChild(wrap);
    }

    function addBubble(text, who, createdAt, isQuestion, attachments) {
      var div = document.createElement('div');
      div.className = 'ai-chat-bubble ' + (who === 'user' ? 'ai-user' : (who === 'agent' ? 'ai-agent' : (who === 'system' ? 'ai-system' : 'ai-bot')));
      if (who === 'bot' && isQuestion) div.className += ' ai-bot-question';
      var timeText = formatBubbleTime(createdAt);

      if (who === 'agent') {
        var label = document.createElement('span');
        label.className = 'bubble-label';
        label.textContent = '상담원';
        div.appendChild(label);
        var agentBody = document.createElement('div');
        agentBody.textContent = text;
        div.appendChild(agentBody);
      } else if (who === 'system') {
        // 법인 공유 피드 알림 등 — 봇 답변 특유의 타이핑 애니메이션 없이 바로 보여준다(내 질문에
        // 대한 실시간 응답이 아니라는 걸 속도로도 구분).
        var systemBody = document.createElement('div');
        appendTextWithAutoBold(systemBody, String(text == null ? '' : text));
        div.appendChild(systemBody);
        appendAttachments(div, attachments);
      } else if (who === 'bot') {
        var botBody = document.createElement('div');
        var rawText = String(text == null ? '' : text);
        streamPlainText(botBody, rawText, function () {
          botBody.textContent = '';
          appendTextWithAutoBold(botBody, rawText);
          collapseChatInput();
          scrollMessagesToBottom();
        });
        div.appendChild(botBody);
      } else {
        var userText = document.createElement('span');
        userText.textContent = text;
        div.appendChild(userText);
      }

      var row = appendBubbleRow(div, who, timeText);
      if (who === 'bot') {
        var previousBotRow = getLastBotRow();
        if (previousBotRow) {
          var prevTimeEl = previousBotRow.querySelector('.bubble-time');
          if (prevTimeEl) prevTimeEl.style.display = 'none';
        }
        setLastBotRow(row);
      }
      if (who !== 'user') collapseChatInput();
      scrollMessagesToBottom();
    }

    return {
      scrollMessagesToBottom: scrollMessagesToBottom,
      collapseChatInput: collapseChatInput,
      clearGuidePlaceholder: clearGuidePlaceholder,
      setAiConnectionStatus: setAiConnectionStatus,
      formatRecentDateTime: formatRecentDateTime,
      addBubble: addBubble,
    };
  }

  window.AiIntakeRender = { create: create };
})();