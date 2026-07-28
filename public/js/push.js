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

  document.addEventListener('DOMContentLoaded', async function () {
    var btn = document.getElementById('pushToggleBtn');
    if (!btn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { btn.style.display = 'none'; return; }
    try {
      var sub = await getSubscription();
      btn.textContent = sub ? '🔔 알림 켜짐' : '🔕 알림 받기';
      btn.addEventListener('click', async function () {
        var current = await getSubscription();
        if (current) { await unsubscribe(); btn.textContent = '🔕 알림 받기'; }
        else { await subscribe(); btn.textContent = '🔔 알림 켜짐'; }
      });
    } catch (e) { btn.style.display = 'none'; }
  });
})();
