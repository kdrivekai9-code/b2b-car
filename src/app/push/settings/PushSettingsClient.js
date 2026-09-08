'use client';

import { useEffect } from 'react';

export default function PushSettingsClient({ currentUser, branches, eventTypes = [] }) {
  const isAdmin = currentUser && currentUser.role === 'admin';
  const isClient = currentUser && currentUser.role === 'client';

  useEffect(() => {
    // legacy views/push_settings.ejs 하단 인라인 스크립트가 하던 구독상태 표시 + 켜기/끄기
    // 버튼 연결 — Next 버전엔 마크업만 있고 이 부분이 빠져 있어서 버튼을 눌러도 구독/해지
    // 자체가 안 되고 상단 "확인 중..." 문구도 그대로 멈춰 있었다.
    const script = document.createElement('script');
    script.src = '/js/push.js';
    script.defer = true;
    script.onload = async () => {
      const statusEl = document.getElementById('pushStatus');
      const subscribeBtn = document.getElementById('pushSubscribeBtn');
      const unsubscribeBtn = document.getElementById('pushUnsubscribeBtn');
      if (!statusEl || !window.__push) return;

      async function refreshStatus() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          statusEl.textContent = '이 브라우저는 푸시 알림을 지원하지 않습니다.';
          subscribeBtn.style.display = 'none';
          unsubscribeBtn.style.display = 'none';
          return;
        }
        // 구독 조회가 실패하면(서비스워커 등록 실패·비공개 모드 등) 화면이 "확인 중..."에
        // 영원히 멎는다 — 고장난 것으로 보인다(EJS 화면도 같은 처리를 한다).
        let sub = null;
        try {
          sub = await window.__push.getSubscription();
        } catch (e) {
          statusEl.textContent = '알림 구독 상태를 확인할 수 없습니다. 브라우저 설정에서 알림을 허용했는지 확인해주세요.';
          return;
        }
        // 구독 중에도 이 버튼을 숨기지 않는다. 이름이 "알림 켜기 / 설정 저장"이고, 종류별
        // 선택을 저장하는 유일한 버튼이다 — 숨기면 골라도 저장할 방법이 없다(예전에는
        // 구독 중이면 사라져서, 세부 설정을 넣는 순간 저장이 불가능해질 자리였다).
        subscribeBtn.style.display = '';
        unsubscribeBtn.style.display = sub ? '' : 'none';
        if (!sub) {
          // 다른 기기에서 받고 있으면 그렇다고 말한다(EJS 화면과 같은 문구) — "이 브라우저"만
          // 말하면 알림이 오는데도 안 온다고 적힌 것으로 읽힌다.
          let otherCount = 0;
          try {
            const st = await fetch('/push/status', { credentials: 'same-origin' });
            if (st.ok) otherCount = (await st.json()).otherDevices || 0;
          } catch (e) { /* 못 세도 아래 문구는 나간다 */ }
          statusEl.textContent = otherCount
            ? `이 브라우저에서는 받지 않습니다. 다른 브라우저·기기 ${otherCount}대에서 받는 중입니다.`
            : '이 브라우저는 아직 알림을 받지 않습니다.';
          return;
        }

        // 저장된 값을 되읽어 체크 상태를 맞춘다. 이게 없으면 화면은 늘 "전부 켜짐"으로 보이고,
        // 종류를 골라 저장해도 다시 들어오면 전부 켜진 것처럼 나온다 — 저장이 안 된 줄로 읽힌다.
        let saved = null;
        try {
          const res = await fetch(`/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`, { credentials: 'same-origin' });
          if (res.ok) saved = await res.json();
        } catch (e) { /* 상태를 못 읽어도 화면은 열려야 한다 */ }

        statusEl.textContent = (saved && saved.effective === false)
          ? '⚠️ 구독은 있지만 켜진 알림이 없어 실제로는 오지 않습니다.'
          : '✅ 이 브라우저는 알림을 받도록 설정되어 있습니다.';

        if (saved && saved.sub) {
          const oe = document.getElementById('notifyOrderEvents');
          if (oe) oe.checked = Number(saved.sub.notify_order_events) === 1;
          // event_types가 비어 있으면 전부 켜짐이다(고르지 않았다는 뜻 — routes/push.js 주석).
          const picked = String(saved.sub.event_types || '').split(',').map((v) => v.trim()).filter(Boolean);
          document.querySelectorAll('#eventTypeRow .evt').forEach((el) => {
            el.checked = picked.length === 0 || picked.includes(el.value);
          });
        }
      }
      await refreshStatus();

      subscribeBtn.addEventListener('click', async () => {
        const notifyDriverAssignEl = document.getElementById('notifyDriverAssign');
        const notifyAgentCallEl = document.getElementById('notifyAgentCall');
        const notifySystemAlertEl = document.getElementById('notifySystemAlert');
        const notifyPlateMismatchEl = document.getElementById('notifyPlateMismatch');
        const branchScope = document.getElementById('branchScope');
        const prefs = {
          notify_order_events: document.getElementById('notifyOrderEvents').checked,
          // 고객 화면에는 이 체크박스가 없다(관리자용 지사 범위 알림) — 널 가드 없이 읽으면
          // 구독 버튼이 통째로 죽는다. EJS와 같은 처리다.
          notify_driver_assign: notifyDriverAssignEl ? notifyDriverAssignEl.checked : true,
          notify_agent_call: notifyAgentCallEl ? notifyAgentCallEl.checked : true,
          notify_system_alert: notifySystemAlertEl ? notifySystemAlertEl.checked : true,
          notify_plate_mismatch: notifyPlateMismatchEl ? notifyPlateMismatchEl.checked : true,
          branch_id: branchScope ? (branchScope.value || null) : null,
        };
        // 고른 종류를 함께 보낸다(EJS 화면과 같은 규칙) — 이 줄이 없으면 골라도 저장되지 않는다.
        const evtEls = document.querySelectorAll('#eventTypeRow .evt');
        if (evtEls.length) {
          prefs.event_types = Array.prototype.filter.call(evtEls, (el) => el.checked).map((el) => el.value);
        }
        await window.__push.subscribe(prefs);
        await refreshStatus();
      });
      unsubscribeBtn.addEventListener('click', async () => {
        await window.__push.unsubscribe();
        await refreshStatus();
      });
    };
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  useEffect(() => {
    // legacy views/push_settings.ejs의 인라인 스크립트가 하던 알림음 미리듣기 연결(저장된
    // on/off·소리종류 복원, 변경 시 저장, 미리듣기 클릭 시 재생)을 Next 버전으로 이식한
    // 부분 — 마크업만 옮겨지고 이 wiring이 빠져 있어서 미리듣기 버튼이 완전히 무반응이었다.
    if (!isAdmin) return undefined;
    const script = document.createElement('script');
    script.src = '/js/agent-alert-sound.js';
    script.defer = true;
    script.onload = () => {
      const enabledEl = document.getElementById('agentSoundEnabled');
      const toneEl = document.getElementById('agentSoundTone');
      const previewBtn = document.getElementById('agentSoundPreviewBtn');
      if (!enabledEl || !window.AgentAlertSound) return;
      enabledEl.checked = window.AgentAlertSound.isEnabled();
      toneEl.value = window.AgentAlertSound.getTone();
      enabledEl.addEventListener('change', () => window.AgentAlertSound.setEnabled(enabledEl.checked));
      toneEl.addEventListener('change', () => window.AgentAlertSound.setTone(toneEl.value));
      previewBtn.addEventListener('click', () => window.AgentAlertSound.play(toneEl.value));
    };
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, [isAdmin]);

  useEffect(() => {
    // legacy의 "브라우저 알림(백그라운드에서도 표시)" 섹션 wiring 이식 — Next JSX에는 이
    // 섹션 자체가 없어서 새로 추가함(아래 return의 browserNotify* 마크업).
    if (!isAdmin) return undefined;
    const script = document.createElement('script');
    script.src = '/js/agent-browser-notify.js';
    script.defer = true;
    script.onload = () => {
      const api = window.AgentBrowserNotify;
      const permRow = document.getElementById('browserNotifyPermRow');
      const permBtn = document.getElementById('browserNotifyPermBtn');
      const toggleRow = document.getElementById('browserNotifyToggleRow');
      const toggleEl = document.getElementById('browserNotifyEnabled');
      const deniedRow = document.getElementById('browserNotifyDeniedRow');
      if (!api || !permRow) return;

      function refresh() {
        const perm = api.permission();
        permRow.style.display = perm === 'default' ? '' : 'none';
        toggleRow.style.display = perm === 'granted' ? '' : 'none';
        deniedRow.style.display = perm === 'denied' ? '' : 'none';
        if (perm === 'granted') toggleEl.checked = api.isEnabled();
      }
      refresh();

      permBtn.addEventListener('click', () => { api.requestPermission().then(refresh); });
      toggleEl.addEventListener('change', () => api.setEnabled(toggleEl.checked));
    };
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, [isAdmin]);

  return (
    <>
      <div className="card">
        <div id="pushStatus" className="page-sub">알림 구독 상태를 확인 중...</div>

        <div className="section-title small">알림 받을 이벤트</div>
        <div className="row">
          {/* 고객에게는 종류가 하나다. 서버는 이 값을 notify_order_events로 읽는다
              (lib/push.js notifyUser). 기사 배정 알림은 지사 범위로 도는 관리자용이라 뺀다. */}
          {isClient ? (
            <div className="field"><label className="checkline"><input type="checkbox" id="notifyOrderEvents" defaultChecked /> <strong>내 오더 진행 알림</strong> (전체 스위치)</label></div>
          ) : (
            <>
              <div className="field"><label className="checkline"><input type="checkbox" id="notifyOrderEvents" defaultChecked /> 오더 등록/수정 알림</label></div>
              <div className="field"><label className="checkline"><input type="checkbox" id="notifyDriverAssign" defaultChecked /> 기사 배정 알림</label></div>
            </>
          )}
          {isAdmin && (
            <>
              <div className="field"><label className="checkline"><input type="checkbox" id="notifyAgentCall" defaultChecked /> 상담원 호출 알림 (AI 챗봇)</label></div>
              {/* 장애 알림은 기본으로 켠다 — 켜야 의미가 있고, 없으면 연동이 멈춰도 아무도 모른다.
                  EJS 화면(views/push_settings.ejs)에도 같은 항목이 있다. 한쪽만 두면 그 화면으로
                  구독한 사람에게는 장애 알림이 안 간다. */}
              <div className="field"><label className="checkline"><input type="checkbox" id="notifySystemAlert" defaultChecked /> 시스템 장애 알림 (연동 오류 · 동기화 지연)</label></div>
              <div className="field"><label className="checkline"><input type="checkbox" id="notifyPlateMismatch" defaultChecked /> 번호판 상이 알림 (접수 번호 ≠ 운행시작 사진)</label></div>
            </>
          )}
        </div>

        {/* 종류별 선택(고객). 목록·이름은 통보 모듈이 주인이다 — page.js가 넘긴다.
            전부 체크한 상태는 "고르지 않음"과 같게 저장한다(NULL) — 종류가 늘어나면 새 종류까지
            자동으로 받는다. 하나도 안 고르면 위 전체 스위치를 끈 것과 같다.
            EJS 화면(views/push_settings.ejs)에도 같은 블록이 있다 — 한쪽만 고치면 플래그를
            되돌렸을 때 세부 설정이 사라진다. */}
        {isClient && eventTypes.length > 0 && (
          <>
            <p className="page-sub" style={{ margin: '2px 0 6px' }}>
              받고 싶은 종류만 고를 수 있습니다. 전체 스위치를 끄면 아래 선택과 무관하게 오지 않습니다.
            </p>
            <div className="row" id="eventTypeRow">
              {eventTypes.map((t) => (
                <div className="field" key={t.key}>
                  <label className="checkline">
                    <input type="checkbox" className="evt" value={t.key} defaultChecked /> {t.label}
                  </label>
                </div>
              ))}
            </div>
          </>
        )}

        {isAdmin && (
          <>
            <div className="section-title small">알림음 설정</div>
            <div className="row">
              <div className="field"><label className="checkline"><input type="checkbox" id="agentSoundEnabled" /> 알림음 켜기</label></div>
              <div className="field">
                <label>소리 종류</label>
                <select id="agentSoundTone">
                  <option value="beep">비프음</option>
                  <option value="chime">차임벨</option>
                  <option value="urgent">긴급(3연타)</option>
                </select>
              </div>
              <div className="field" style={{ alignSelf: 'flex-end' }}>
                <button className="btn secondary small" type="button" id="agentSoundPreviewBtn">🔊 미리듣기</button>
              </div>
            </div>

            <div className="section-title small">브라우저 알림 (백그라운드에서도 표시)</div>
            <p className="page-sub" style={{ marginTop: -6 }}>이 브라우저 탭이 백그라운드에 있거나 다른 창에 가려져 있어도, 상담원 호출이 오면 OS 알림창으로 띄웁니다.</p>
            <div className="row">
              <div className="field" id="browserNotifyPermRow" style={{ display: 'none' }}>
                <button className="btn small" type="button" id="browserNotifyPermBtn">🔔 브라우저 알림 허용하기</button>
              </div>
              <div className="field" id="browserNotifyToggleRow" style={{ display: 'none' }}>
                <label className="checkline"><input type="checkbox" id="browserNotifyEnabled" /> 브라우저 알림 켜기</label>
              </div>
              <div className="field" id="browserNotifyDeniedRow" style={{ display: 'none' }}>
                <span className="page-sub" style={{ margin: 0 }}>브라우저 설정에서 알림이 차단되어 있습니다. 주소창 왼쪽의 사이트 설정에서 알림을 허용해주세요.</span>
              </div>
            </div>
          </>
        )}

        {branches.length > 0 && (
          <>
            <div className="section-title small">지사 범위</div>
            <div className="field">
              <select id="branchScope" defaultValue="">
                <option value="">전체 지사</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          </>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button className="btn" type="button" id="pushSubscribeBtn">알림 켜기</button>
          <button className="btn secondary" type="button" id="pushUnsubscribeBtn" style={{ display: 'none' }}>알림 끄기</button>
        </div>
      </div>
    </>
  );
}
