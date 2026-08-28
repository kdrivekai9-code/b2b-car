'use client';

import { useEffect } from 'react';

export default function PushSettingsClient({ currentUser, branches }) {
  const isAdmin = currentUser && currentUser.role === 'admin';

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
        const sub = await window.__push.getSubscription();
        statusEl.textContent = sub ? '✅ 이 브라우저는 알림을 받도록 설정되어 있습니다.' : '이 브라우저는 아직 알림을 받지 않습니다.';
        subscribeBtn.style.display = sub ? 'none' : '';
        unsubscribeBtn.style.display = sub ? '' : 'none';
      }
      await refreshStatus();

      subscribeBtn.addEventListener('click', async () => {
        const notifyAgentCallEl = document.getElementById('notifyAgentCall');
        const notifySystemAlertEl = document.getElementById('notifySystemAlert');
        const branchScope = document.getElementById('branchScope');
        const prefs = {
          notify_order_events: document.getElementById('notifyOrderEvents').checked,
          notify_driver_assign: document.getElementById('notifyDriverAssign').checked,
          notify_agent_call: notifyAgentCallEl ? notifyAgentCallEl.checked : true,
          notify_system_alert: notifySystemAlertEl ? notifySystemAlertEl.checked : true,
          branch_id: branchScope ? (branchScope.value || null) : null,
        };
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
          <div className="field"><label className="checkline"><input type="checkbox" id="notifyOrderEvents" defaultChecked /> 오더 등록/수정 알림</label></div>
          <div className="field"><label className="checkline"><input type="checkbox" id="notifyDriverAssign" defaultChecked /> 기사 배정 알림</label></div>
          {isAdmin && (
            <>
              <div className="field"><label className="checkline"><input type="checkbox" id="notifyAgentCall" defaultChecked /> 상담원 호출 알림 (AI 챗봇)</label></div>
              {/* 장애 알림은 기본으로 켠다 — 켜야 의미가 있고, 없으면 연동이 멈춰도 아무도 모른다.
                  EJS 화면(views/push_settings.ejs)에도 같은 항목이 있다. 한쪽만 두면 그 화면으로
                  구독한 사람에게는 장애 알림이 안 간다. */}
              <div className="field"><label className="checkline"><input type="checkbox" id="notifySystemAlert" defaultChecked /> 시스템 장애 알림 (연동 오류 · 동기화 지연)</label></div>
            </>
          )}
        </div>

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
