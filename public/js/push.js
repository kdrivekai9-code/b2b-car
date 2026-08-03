// 브라우저 푸시 알림 구독/해지 공통 스크립트 (Web Push, 무료 — 기기/브라우저 단위로 저장)
(function () {
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    return Uint8Array.from(rawData.split('').map(function (c) { return c.charCodeAt(0); }));
  }

  async function getSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    var reg = await navigator.serviceWorker.register('/sw.js');
    return reg.pushManager.getSubscription();
  }

  async function subscribe(prefs) {
    var reg = await navigator.serviceWorker.ready;
    var keyRes = await fetch('/push/vapid-public-key');
    var publicKey = await keyRes.text();
    var sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign(sub.toJSON(), prefs || {})),
    });
    return sub;
  }

  async function unsubscribe() {
    var sub = await getSubscription();
    if (sub) {
      await fetch('/push/unsubscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  }

  window.__push = { getSubscription: getSubscription, subscribe: subscribe, unsubscribe: unsubscribe };

  function showToast(message) {
    var el = document.createElement('div');
    el.className = 'toast toast-top';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('toast-hide'); }, 2500);
    setTimeout(function () { el.remove(); }, 3000);
  }

  // 브라우저 알림 권한이 이미 차단된 상태에서 pushManager.subscribe()를 호출하면 거부(reject)되지
  // 않고 그대로 멈춰버리는(응답도 거부도 없는) 경우가 실제로 확인됐다 — 버튼이 영원히 "처리 중"
  // 상태로 멎어버리는 원인. 타임아웃으로 강제 종료해 항상 사용자에게 피드백이 가도록 한다.
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); }),
    ]);
  }

  // 'DOMContentLoaded'에만 걸어두면 안 된다 — Next.js AppShell은 이 스크립트를
  // <Script strategy="afterInteractive">로 불러오는데, 이는 페이지가 이미 하이드레이션된
  // "이후"에 실행되도록 예약되는 전략이라 DOMContentLoaded가 이미 지나간 뒤 실행되는 경우가
  // 실제로 있었다(로컬 :3001 Next 개발서버에서 재현 — 리스너가 아예 안 붙어서 버튼을 눌러도
  // 완전히 무반응이었다). 이미 로드가 끝난 뒤라면 즉시 실행하도록 분기한다.
  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  whenReady(async function () {
    var btn = document.getElementById('pushToggleBtn');
    if (!btn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { btn.style.display = 'none'; return; }
    try {
      var sub = await getSubscription();
      btn.textContent = sub ? '🔔 알림 켜짐' : '🔕 알림 받기';
      btn.addEventListener('click', async function () {
        // 이전에는 subscribe()/unsubscribe() 실패(대표적으로 브라우저에서 알림 권한을 이미
        // 차단해둔 경우 pushManager.subscribe()가 거부됨)를 아무 데서도 잡지 않아서, 버튼을
        // 눌러도 아무 반응 없이 조용히 실패하는 문제가 있었다 — 클릭했는데 아무 일도 안
        // 일어난다는 사용자 리포트로 확인됨. 실패 원인별로 안내 문구를 보여주도록 수정.
        btn.disabled = true;
        try {
          var current = await getSubscription();
          if (current) {
            await withTimeout(unsubscribe(), 10000);
            btn.textContent = '🔕 알림 받기';
            showToast('알림을 껐습니다.');
          } else if (Notification.permission === 'denied') {
            // 이미 차단된 상태면 subscribe()를 시도조차 하지 않는다 — 브라우저에 따라 이 경우
            // subscribe()가 거부되지 않고 계속 멈춰있는 걸 직접 확인했다.
            showToast('브라우저 알림이 차단되어 있습니다. 브라우저 설정에서 이 사이트의 알림을 허용해주세요.');
          } else {
            await withTimeout(subscribe(), 10000);
            btn.textContent = '🔔 알림 켜짐';
            showToast('알림을 받도록 설정했습니다.');
          }
        } catch (e) {
          if (Notification.permission === 'denied') {
            showToast('브라우저 알림이 차단되어 있습니다. 브라우저 설정에서 이 사이트의 알림을 허용해주세요.');
          } else if (e && e.message === 'timeout') {
            showToast('알림 설정 요청이 응답하지 않습니다. 잠시 후 다시 시도해주세요.');
          } else {
            showToast('알림 설정 중 오류가 발생했습니다: ' + (e && e.message));
          }
        } finally {
          btn.disabled = false;
        }
      });
    } catch (e) { btn.style.display = 'none'; }
  });
})();
