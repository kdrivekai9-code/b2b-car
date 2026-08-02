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

    function appendTextWithAutoBold(container, text) {
      var raw = String(text == null ? '' : text);
      var re = /\*\*[^*\n]+\*\*|'[^'\n]+'|\d{1,3}(?:,\d{3})*원|\d+(?:\.\d+)?km/g;
      var last = 0;
      var match;
      while ((match = re.exec(raw)) !== null) {
        var index = match.index;
        if (index > last) container.appendChild(document.createTextNode(raw.slice(last, index)));
        var strong = document.createElement('strong');
        strong.textContent = match[0].indexOf('**') === 0 ? match[0].slice(2, -2) : match[0];
        container.appendChild(strong);
        last = index + match[0].length;
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

    function addBubble(text, who, createdAt, isQuestion) {
      var div = document.createElement('div');
      div.className = 'ai-chat-bubble ' + (who === 'user' ? 'ai-user' : (who === 'agent' ? 'ai-agent' : 'ai-bot'));
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