// 오더 등록 직후 콜마너 오더접수(fire-and-forget) 결과를 짧게 폴링해서, 실패했을 때만
// 화면에 팝업으로 알려준다. 성공/미사용 지사는 조용히 넘어간다(요청 범위가 "실패 알림"이라).
(function () {
  // 오더 상세페이지는 서버 렌더 시점의 order.callmaner_last_error로 이 배지를 이미 그려두지만
  // (새로고침하면 항상 보임), 폴링 도중 새로고침 없이 막 실패를 감지한 경우에도 같은 배지가
  // 바로 나타나도록 만들어 둔다(className으로 중복 삽입 방지).
  // 화면에 이미 뜬 실패와 방금 감지한 실패가 같은 것인지 비교하기 위한 지문 — 상태를 다시
  // '접수'로 바꿔 재시도했을 때(routes/orders.js registerOrderWithCallmaner의 재시도 경로)
  // 코드/메시지가 달라지면 "새 실패"로 취급해야 한다.
  function errorSignature(message, code) {
    return (code || '') + '|' + (message || '');
  }

  // code는 콜마너가 실제로 응답한 에러코드(정의서 rc, 예: E0 / HTTP 500) — 우리 쪽 사전검증
  // 실패(좌표 누락 등)는 요청이 나가지 않아 코드가 없으므로 그 줄을 아예 그리지 않는다.
  // 이미 배지가 있으면 새로 만들지 않고 내용만 갈아끼운다 — 재시도로 에러가 바뀐 경우 예전
  // 코드가 화면에 그대로 남아 있으면 안 된다(예전에는 배지가 있으면 그냥 return했다).
  function showBadge(message, code) {
    var badge = document.querySelector('.callmaner-error-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'callmaner-error-badge';
      badge.setAttribute('role', 'alert');
      document.body.appendChild(badge);
    }
    badge.textContent = '';
    badge.setAttribute('data-error-signature', errorSignature(message, code));
    var strong = document.createElement('strong');
    strong.textContent = '⚠️ 콜마너 연동 실패';
    badge.appendChild(strong);
    if (code) {
      var codeEl = document.createElement('div');
      codeEl.className = 'callmaner-error-code';
      codeEl.textContent = '에러코드 ' + code;
      badge.appendChild(codeEl);
    }
    var body = document.createElement('div');
    body.textContent = message;
    badge.appendChild(body);
  }

  // 콜마너 등록은 fire-and-forget이라 상태변경/오더등록 직후에는 결과가 아직 없다 —
  // 그동안 화면에 아무 표시도 없어서 "배너가 늦게 뜬다"로 보였다. 진행 중임을 알려주고,
  // 결과(성공/실패)가 확인되면 지운다. pending은 서버가 이미 내려주던 값인데 쓰이지 않고 있었다.
  function showPending() {
    if (document.querySelector('.callmaner-pending-badge')) return;
    var el = document.createElement('div');
    el.className = 'callmaner-pending-badge';
    el.setAttribute('role', 'status');
    el.textContent = '⏳ 콜마너 등록 확인 중…';
    document.body.appendChild(el);
  }

  function clearPending() {
    var el = document.querySelector('.callmaner-pending-badge');
    if (el) el.remove();
  }

  // 폴링 창을 다 써도 결과가 안 나온 경우 — 조용히 사라지면 사용자는 등록이 됐는지 알 수 없다.
  function showPendingTimedOut() {
    var el = document.querySelector('.callmaner-pending-badge');
    if (!el) { showPending(); el = document.querySelector('.callmaner-pending-badge'); }
    if (el) el.textContent = '⏳ 콜마너 등록 결과를 아직 확인하지 못했습니다. 잠시 후 새로고침해주세요.';
  }

  function showPopup(message, code, onClose) {
    var overlay = document.createElement('div');
    overlay.className = 'callmaner-alert-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;max-width:420px;width:calc(100% - 32px);padding:20px 22px;box-shadow:0 12px 32px rgba(0,0,0,.25);';

    var title = document.createElement('div');
    title.textContent = '⚠️ 콜마너 연동 실패';
    title.style.cssText = 'font-weight:700;font-size:16px;margin-bottom:8px;color:#c0392b;';

    var codeEl = null;
    if (code) {
      codeEl = document.createElement('div');
      codeEl.textContent = '에러코드 ' + code;
      codeEl.style.cssText = 'display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:700;color:#922b21;background:#fdecea;border:1px solid #f1948a;border-radius:4px;padding:2px 8px;margin-bottom:10px;';
    }

    var body = document.createElement('div');
    body.textContent = message;
    body.style.cssText = 'font-size:14px;line-height:1.5;color:#333;white-space:pre-wrap;margin-bottom:16px;';

    var hint = document.createElement('div');
    hint.textContent = '오더는 정상 등록되었으나, 콜마너 배차 시스템에는 자동 등록되지 않았습니다. 필요 시 콜마너에 수동으로 등록해주세요.';
    hint.style.cssText = 'font-size:12px;color:#777;line-height:1.4;margin-bottom:16px;';

    var btn = document.createElement('button');
    btn.textContent = '확인';
    btn.type = 'button';
    btn.style.cssText = 'display:block;margin-left:auto;padding:8px 18px;border:0;border-radius:6px;background:#c0392b;color:#fff;font-size:14px;cursor:pointer;';
    btn.onclick = function () { overlay.remove(); if (onClose) onClose(); };

    box.appendChild(title);
    if (codeEl) box.appendChild(codeEl);
    box.appendChild(body);
    box.appendChild(hint);
    box.appendChild(btn);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  // onDone은 폴링이 끝났을 때(실패 팝업을 띄웠든, 성공/미사용이라 조용히 끝났든, 시도 횟수를
  // 다 썼든) 정확히 한 번 호출된다 — 호출부가 이 콜백을 기다렸다가 화면 이동을 하면, 페이지
  // 전환 때문에 폴링이 끊겨 팝업이 뜰 기회를 놓치는 걸 막을 수 있다.
  function poll(orderId, options) {
    var onDone = (options && options.onDone) || function () {};
    if (!orderId) { onDone(); return; }
    // lib/callmaner.js의 API 타임아웃이 10초라, 예전 기본값(6회 × 1.5초 = 마지막 폴링 7.5초)은
    // 콜마너가 늦게 응답하거나 타임아웃으로 끝난 경우를 놓쳤다 — 그러면 DB에는 에러가 남았는데
    // 화면에는 새로고침 전까지 아무것도 안 떴다. 타임아웃 + 여유를 덮도록 창을 늘린다(0~16.5초).
    var maxAttempts = (options && options.maxAttempts) || 12;
    var intervalMs = (options && options.intervalMs) || 1500;
    var attempts = 0;

    // 폴링 시작 시점에 화면이 이미 보여주고 있던 실패의 지문 — 오더 상세는 서버 렌더 시점의
    // callmaner_last_error로 배지를 미리 그려두므로, 실패한 오더를 열 때마다 폴링이 같은 실패를
    // 다시 발견한다. 그때 팝업까지 띄우면 열 때마다 팝업을 닫아야 해서, 이미 보여주던 것과
    // 같은 실패면 상시 표시되는 배지만 남긴다. 반대로 지문이 다르면(상태를 '접수'로 바꿔
    // 재시도한 뒤의 새 실패) 또는 배지가 아예 없었으면 "방금 생긴 소식"이라 팝업으로 알린다.
    var initialBadge = document.querySelector('.callmaner-error-badge');
    var shownSignature = initialBadge ? initialBadge.getAttribute('data-error-signature') : null;

    function tick() {
      fetch('/orders/' + orderId + '/callmaner-status.json')
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (!data || !data.enabled) { clearPending(); onDone(); return; } // 콜마너 미사용 지사 - 아무 것도 하지 않음
          if (data.error) {
            clearPending();
            var isAlreadyShown = shownSignature === errorSignature(data.error, data.errorCode);
            showBadge(data.error, data.errorCode);
            if (isAlreadyShown) { onDone(); return; }
            showPopup(data.error, data.errorCode, onDone); // 팝업의 "확인"을 눌러야 onDone(페이지 이동 등) 진행
            return;
          }
          if (data.confSlip) { clearPending(); onDone(); return; } // 정상 등록 - 팝업 없음(요청 범위 밖)
          // 아직 결과가 없다 — 등록 요청이 진행 중임을 화면에 알린다.
          showPending();
          attempts += 1;
          if (attempts < maxAttempts) setTimeout(tick, intervalMs);
          else { showPendingTimedOut(); onDone(); }
        })
        .catch(function () { clearPending(); onDone(); });
    }
    tick();
  }

  window.__callmanerAlert = { poll: poll, showPopup: showPopup, showBadge: showBadge };
})();
