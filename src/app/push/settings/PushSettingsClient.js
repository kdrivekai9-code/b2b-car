'use client';

import { useEffect } from 'react';

export default function PushSettingsClient({ currentUser, branches }) {
  const isAdmin = currentUser && currentUser.role === 'admin';

  useEffect(() => {
    // 기존 push.js가 window 로드 후 document 이벤트로 초기화하므로 동적으로 로드한다.
    const script = document.createElement('script');
    script.src = '/js/push.js';
    script.defer = true;
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  return (
    <>
      <div className="card">
        <div id="pushStatus" className="page-sub">알림 구독 상태를 확인 중...</div>

        <div className="section-title small">알림 받을 이벤트</div>
        <div className="row">
          <div className="field"><label className="checkline"><input type="checkbox" id="notifyOrderEvents" defaultChecked /> 오더 등록/수정 알림</label></div>
          <div className="field"><label className="checkline"><input type="checkbox" id="notifyDriverAssign" defaultChecked /> 기사 배정 알림</label></div>
          {isAdmin && (
            <div className="field"><label className="checkline"><input type="checkbox" id="notifyAgentCall" defaultChecked /> 상담원 호출 알림 (AI 챗봇)</label></div>
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

            {branches.length > 0 && (
              <>
                <div className="section-title small">알림 받을 지사</div>
                <div className="row">
                  <div className="field"><label className="checkline"><input type="checkbox" id="notifyAllBranches" defaultChecked /> 전체 지사</label></div>
                  {branches.map((b) => (
                    <div className="field" key={b.id}><label className="checkline"><input type="checkbox" className="notifyBranch" data-id={b.id} /> {b.name}</label></div>
                  ))}
                </div>
              </>
            )}
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
