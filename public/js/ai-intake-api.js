(function () {
  function jsonOrEmpty(res) {
    return res.json().catch(function () { return {}; });
  }

  function postJson(url, payload, extraOptions) {
    var options = extraOptions || {};
    return fetch(url, {
      method: options.method || 'POST',
      keepalive: !!options.keepalive,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, options.headers || {}),
      body: JSON.stringify(payload || {}),
    });
  }

  function postForm(url, body, extraOptions) {
    var options = extraOptions || {};
    return fetch(url, {
      method: options.method || 'POST',
      keepalive: !!options.keepalive,
      headers: Object.assign({ 'X-Requested-With': 'fetch', 'Content-Type': 'application/x-www-form-urlencoded' }, options.headers || {}),
      body: body,
    });
  }

  window.AiIntakeApi = {
    pingActivity: function () {
      return fetch('/orders/ai-intake/activity', {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch' },
      });
    },

    checkHealth: function () {
      return fetch('/orders/ai-intake/health', {
        method: 'GET',
        headers: { 'X-Requested-With': 'fetch' },
      }).then(function (res) {
        return res.json().catch(function () { return { ok: false }; }).then(function (data) {
          return { ok: !!(res.ok && data && data.ok), status: res.status, data: data || {} };
        });
      });
    },

    createInquiryRecord: function (payload) {
      return postJson('/inquiries', payload).then(function (res) {
        return jsonOrEmpty(res).then(function (data) {
          return data && data.id ? Number(data.id) : null;
        });
      });
    },

    updateInquiryEstimate: function (inquiryId, payload) {
      return postJson('/inquiries/' + inquiryId + '/estimate', payload).then(function () {
        return true;
      });
    },

    fetchFarePreview: function (queryString) {
      return fetch('/orders/fare-preview?' + queryString)
        .then(function (res) { return res.json(); })
        .catch(function () { return null; });
    },

    submitOrderForm: function (action, params) {
      return postForm(action, params).then(function (res) {
        if (!res.ok) {
          return jsonOrEmpty(res).then(function (data) {
            throw new Error(data.error || '등록에 실패했습니다. (서버 응답 코드: ' + res.status + ')');
          });
        }
        return res.json();
      });
    },

    appendAdditionalRequest: function (orderId, text) {
      return postJson('/orders/' + orderId + '/additional-request', { text: text })
        .then(function (res) {
          if (!res.ok) {
            return jsonOrEmpty(res).then(function (data) {
              throw new Error(data.error || '요청사항 추가에 실패했습니다.');
            });
          }
          return res.json();
        });
    },

    precheckSubmit: function (params) {
      return postForm('/orders/ai-intake/submit-precheck', params, { keepalive: true }).then(function (res) {
        if (res.status === 404) return { ok: true, skipped: true };
        var contentType = String(res.headers.get('content-type') || '').toLowerCase();
        var isJson = contentType.indexOf('application/json') >= 0;
        if (!isJson) {
          if (res.status === 401 || res.redirected) return { ok: false, error: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.' };
          return { ok: false, error: '등록 가능 여부 확인 응답 형식이 올바르지 않습니다. (HTTP ' + res.status + ')' };
        }
        return jsonOrEmpty(res).then(function (data) {
          if (res.ok && data && data.ok) return { ok: true };
          if (res.status === 401) {
            return { ok: false, error: (data && (data.error || data.message)) || '로그인 세션이 만료되었습니다. 다시 로그인해주세요.' };
          }
          return { ok: false, error: (data && (data.error || data.message)) || ('등록 가능 여부를 확인하지 못했습니다. (HTTP ' + res.status + ')') };
        });
      }).catch(function () {
        return { ok: false, error: '등록 가능 여부를 확인하지 못했습니다. 네트워크 상태를 확인해주세요.' };
      });
    },

    classifyReply: function (text, phaseName, candidateLabels, fieldChoices) {
      return postJson('/orders/ai-intake/classify-reply', {
        text: text,
        phase: phaseName,
        candidates: candidateLabels || [],
        fieldChoices: fieldChoices || [],
      }, { headers: { 'Content-Type': 'application/json' } })
        .then(function (res) { return res.json(); })
        .catch(function () { return { action: 'unclear' }; });
    },

    parseText: function (text, pendingField) {
      return postJson('/orders/ai-intake/parse', {
        text: text,
        pendingField: pendingField,
      }).then(function (res) {
        return res.json().catch(function () {
          return { error: '서버 응답을 읽는 중 문제가 발생했습니다. (상태 코드: ' + res.status + ')' };
        });
      });
    },

    createChatSession: function () {
      return fetch('/chat/session', { method: 'POST' })
        .then(function (res) { return res.json(); });
    },

    postChatUserMessage: function (sessionId, text) {
      return postJson('/chat/' + sessionId + '/user-message', { text: text }, { headers: { 'Content-Type': 'application/json' } })
        .then(function (res) { return res.json(); });
    },

    postChatBotMessage: function (sessionId, payload) {
      return postJson('/chat/' + sessionId + '/bot-message', payload, {
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
      }).then(function (res) {
        return res.json().catch(function () {
          return { error: '서버 응답을 읽는 중 문제가 발생했습니다. (상태 코드: ' + res.status + ')' };
        }).then(function (data) {
          if (!res.ok) throw new Error((data && (data.error || data.message)) || ('상태 코드 ' + res.status));
          return data;
        });
      });
    },

    // 배차 주문 도우미(콜마너 MCP 도구 호출) — 봇이 처리 못하던 요청(주문 조회/변경/취소 등)을
    // 상담원 연결로 넘기기 전에 먼저 시도한다. 실패/처리불가면 { handled: false }가 돌아온다.
    dispatchAgent: function (sessionId, text) {
      return postJson('/chat/' + sessionId + '/dispatch-agent', { text: text }, { headers: { 'Content-Type': 'application/json' } })
        .then(function (res) {
          return jsonOrEmpty(res).then(function (data) {
            if (!res.ok) return { handled: false, reason: 'http_' + res.status };
            return data || { handled: false };
          });
        })
        .catch(function () { return { handled: false, reason: 'network' }; });
    },

    // 배차 지연 확인 — 기사 미배정으로 5분 이상 지난 주문이 있으면 요금 인상 질문을 돌려준다.
    checkDispatchDelay: function (sessionId) {
      return postJson('/chat/' + sessionId + '/dispatch-delay-check', {}, { headers: { 'Content-Type': 'application/json' } })
        .then(function (res) { return jsonOrEmpty(res); })
        .then(function (data) { return data || { offer: false }; })
        .catch(function () { return { offer: false }; });
    },

    fetchChatMessages: function (sessionId, sinceId) {
      return fetch('/chat/' + sessionId + '/messages?since=' + sinceId)
        .then(function (res) { return res.json(); });
    },

    deleteSessionHistory: function (sessionId) {
      return fetch('/orders/ai-intake/sessions/' + encodeURIComponent(sessionId) + '/delete', {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch' },
      }).then(function (res) {
        return res.text().then(function (raw) {
          var data = {};
          try { data = raw ? JSON.parse(raw) : {}; } catch (e) {}
          if (!res.ok) {
            var detail = (data && data.error) || (raw ? raw.slice(0, 200) : ('상태 코드 ' + res.status));
            throw new Error(detail);
          }
          return data;
        });
      });
    },

    fetchRecentSessions: function (params) {
      return fetch('/orders/ai-intake/sessions?' + params.toString())
        .then(function (res) { return res.json(); });
    },

    closeChatSession: function (sessionId) {
      if (!sessionId) return Promise.resolve();
      return postJson('/chat/' + sessionId + '/bot-message', { closeSession: true }, { headers: { 'Content-Type': 'application/json' } });
    },
  };
})();