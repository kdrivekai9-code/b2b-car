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
    await navigator.serviceWorker.register('/sw.js');
    // **ready를 기다린다.** register()가 돌려주는 등록은 아직 활성화 전일 수 있고, 그 상태에서
    // pushManager.getSubscription()이 null을 주는 브라우저가 있다(사파리에서 겪었다) —
    // 구독이 있는데 "아직 알림을 받지 않습니다"로 보인다. subscribe()는 이미 ready를 쓴다.
    var reg = await navigator.serviceWorker.ready;
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

  // 차단 안내 문구.
  //
  // "브라우저 설정에서 허용해주세요"만으로는 사파리에서 길을 못 찾는다 — 크롬은 주소창 왼쪽
  // 자물쇠지만 사파리는 메뉴의 설정 > 웹사이트 > 알림에 있다. 한 번 "허용 안 함"을 누르면
  // 사파리가 그것을 기억해서, 그 목록에서 바꾸기 전까지는 버튼을 눌러도 계속 막힌다.
  function blockedMessage() {
    var isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      return '브라우저 알림이 차단되어 있습니다. 사파리 메뉴 > 설정 > 웹사이트 > 알림에서 이 사이트를 "허용"으로 바꿔주세요.';
    }
    return '브라우저 알림이 차단되어 있습니다. 주소창 왼쪽의 사이트 설정에서 알림을 허용해주세요.';
  }

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

  // 라벨은 **서버 판정**을 따른다.
  //
  // 브라우저 구독 유무만 보면 두 화면이 다른 말을 한다: 오더 알림 설정에서 체크를 끄고
  // 저장하면 구독은 남고 플래그만 0이 되는데(그러면 알림은 안 온다), 여기 라벨은 계속
  // "🔔 알림 켜짐"이었다(실사용 지적 2026-09-08). /push/status의 effective가 "실제로 알림이
  // 갈 수 있는가"를 알려준다 — 역할마다 기준이 달라 서버가 판정한다.
  //
  // 서버에 못 물어보면(네트워크 실패) 브라우저 구독 유무로 되돌아간다. 라벨 하나 때문에
  // 버튼이 사라지는 쪽이 더 나쁘다.
  async function isNotifyOn(sub) {
    if (!sub) return false;
    try {
      var res = await fetch('/push/status?endpoint=' + encodeURIComponent(sub.endpoint), { credentials: 'same-origin' });
      if (!res.ok) return true;
      var d = await res.json();
      return !!d.effective;
    } catch (e) {
      return true;
    }
  }

  whenReady(async function () {
    var btn = document.getElementById('pushToggleBtn');
    if (!btn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { btn.style.display = 'none'; return; }
    try {
      var sub = await getSubscription();
      btn.textContent = (await isNotifyOn(sub)) ? '🔔 알림 켜짐' : '🔕 알림 받기';
      btn.addEventListener('click', async function () {
        // 이전에는 subscribe()/unsubscribe() 실패(대표적으로 브라우저에서 알림 권한을 이미
        // 차단해둔 경우 pushManager.subscribe()가 거부됨)를 아무 데서도 잡지 않아서, 버튼을
        // 눌러도 아무 반응 없이 조용히 실패하는 문제가 있었다 — 클릭했는데 아무 일도 안
        // 일어난다는 사용자 리포트로 확인됨. 실패 원인별로 안내 문구를 보여주도록 수정.
        btn.disabled = true;
        try {
          var current = await getSubscription();
          // 구독은 있는데 설정에서 꺼둔 상태(라벨이 "알림 받기")라면, 누른 뜻은 "끄기"가 아니라
          // "켜기"다. 다시 구독하면 서버가 플래그를 켜짐으로 되돌린다(routes/push.js subscribe는
          // 지정되지 않은 칸을 1로 저장한다) — 여기서 끄면 누를 때마다 꺼지기만 한다.
          if (current && !(await isNotifyOn(current))) {
            await withTimeout(subscribe(), 10000);
            btn.textContent = '🔔 알림 켜짐';
            showToast('알림을 받도록 설정했습니다.');
          } else if (current) {
            await withTimeout(unsubscribe(), 10000);
            btn.textContent = '🔕 알림 받기';
            showToast('알림을 껐습니다.');
          } else if (Notification.permission === 'denied') {
            // 이미 차단된 상태면 subscribe()를 시도조차 하지 않는다 — 브라우저에 따라 이 경우
            // subscribe()가 거부되지 않고 계속 멈춰있는 걸 직접 확인했다.
            showToast(blockedMessage());
          } else {
            await withTimeout(subscribe(), 10000);
            btn.textContent = '🔔 알림 켜짐';
            showToast('알림을 받도록 설정했습니다.');
          }
        } catch (e) {
          if (Notification.permission === 'denied') {
            showToast(blockedMessage());
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
