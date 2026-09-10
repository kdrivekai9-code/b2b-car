'use client';

import { useRef, useState } from 'react';

// 고객 통보 사건 블록 — views/partials/customer_notification_events.ejs의 Next 판.
//
// 지사(/branches/:id/customer-notifications)와 법인(/groups/:id/customer-notifications) 화면이
// 함께 쓴다. 복사해두면 변수 칩 하나를 늘려도 한쪽만 고쳐 갈라진다 — 이 저장소에서 실제로
// 반복된 사고라 EJS도 파티셜로 두었다.
//
// 클라이언트인 이유 셋: 변수 칩(커서 위치에 토큰 삽입), 사진첨부 칩 색, 즉시/N분 뒤 전환.
const STYLES = `
  .notify-event-block { padding: 16px 0; border-bottom: 1px solid var(--border, #e5e7eb); }
  .notify-event-block:last-child { border-bottom: 0; }
  .notify-event-block textarea { width: 100%; font-family: inherit; }
  .notify-event-block code { background: rgba(127, 127, 127, 0.12); padding: 1px 4px; border-radius: 3px; }
  .checkline.inline { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; }
  .var-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .var-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 10px; border: 1px solid var(--border, #e5e7eb); border-radius: 999px;
    background: var(--card, #fff); color: var(--text, #374151);
    font-size: 12px; font-weight: 600; cursor: pointer; line-height: 1.6;
  }
  .var-chip:hover { background: rgba(127, 127, 127, 0.08); }
  .var-chip.toggle input { margin: 0; }
  .var-chip.toggle.on { background: #dcf5f1; border-color: #99ddd3; color: #0f766e; }
  .var-chip.disabled { opacity: .45; cursor: not-allowed; }
  .notify-preview { margin-top: 8px; }
  .notify-preview-label { font-size: 11.5px; font-weight: 700; color: var(--muted, #6b7280); }
  .notify-preview pre {
    margin: 4px 0 0; padding: 10px 12px; border-radius: 8px;
    background: rgba(127, 127, 127, 0.08); font-family: inherit; font-size: 13px;
    line-height: 1.6; white-space: pre-wrap; word-break: break-all;
  }
`;

function EventBlock({ event: e, variables, photoSettingsUrl }) {
  const textareaRef = useRef(null);
  const delayRef = useRef(null);
  const [later, setLater] = useState(e.delayMinutes !== 0);
  const [attach, setAttach] = useState(!!e.attachPhotos);

  // 토큰 이름을 외우게 하지 않으려는 것이다 — 토큰은 ASCII라 한글 라벨만 보고는 알 수 없다.
  function insertToken(token) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (typeof el.setRangeText === 'function' && start !== null) el.setRangeText(token, start, end, 'end');
    else el.value += token;
    el.focus();
  }

  return (
    <div className="notify-event-block">
      <div className="row">
        <div className="field">
          <label className="checkline">
            <input type="checkbox" name={`enabled_${e.key}`} value="1" defaultChecked={!!e.enabled} />
            {' '}<strong>{e.label}</strong> 통보 사용
          </label>
          <p className="page-sub">{e.hint}</p>
        </div>
        <div className="field">
          <label>보내는 시점</label>
          <div className="delay-minutes-input">
            <label className="checkline inline">
              <input type="radio" name={`delay_mode_${e.key}`} value="now" checked={!later}
                onChange={() => {
                  setLater(false);
                  if (delayRef.current) delayRef.current.value = '0';
                }} />
              {' '}즉시
            </label>
            <label className="checkline inline">
              <input type="radio" name={`delay_mode_${e.key}`} value="later" checked={later}
                onChange={() => {
                  setLater(true);
                  const el = delayRef.current;
                  if (el) { if (el.value === '0') el.value = '1'; el.focus(); }
                }} />
              {' '}상태 변경 후
            </label>
            {/* 시간칸은 "상태 변경 후"일 때만 보인다. 감출 때도 DOM에서 빼지 않는다 —
                제거하거나 disabled로 두면 값이 전송되지 않아 서버 검증(0~120 정수 필수)에
                걸린다. 그래서 hidden + readOnly로만 잠근다(EJS와 같은 이유). */}
            <span className="delay-later-only" hidden={!later}>
              <input ref={delayRef} type="number" name={`delay_${e.key}`} defaultValue={e.delayMinutes}
                min={0} max={120} step={1} required readOnly={!later} />
              <span>분 뒤</span>
            </span>
          </div>
          <p className="page-sub">보내기 직전에 상태를 한 번 더 확인해서, 그사이 상황이 바뀌었으면 보내지 않습니다.</p>
        </div>
      </div>
      <div className="field">
        <label>문구</label>
        <div className="var-chip-row">
          {variables.map((v) => (
            <button type="button" className="var-chip" title={v.hint} key={v.token}
              onClick={() => insertToken(v.token)}>{v.label}</button>
          ))}
          {e.photoSupported ? (
            // 사진은 텍스트가 아니라 별도 발송이라(카카오는 이미지 메시지, 웹은 첨부) 문구
            // 안에 위치를 지정할 수 없다 — 그래서 토큰이 아니라 스위치다.
            <label className={'var-chip toggle' + (attach ? ' on' : '')}>
              <input type="checkbox" name={`attach_photos_${e.key}`} value="1"
                checked={attach} onChange={(ev) => setAttach(ev.target.checked)} />
              {' '}📷 사진첨부
            </label>
          ) : (
            <span className="var-chip disabled" title="배차 시점에는 아직 탁송사진이 없습니다">📷 사진첨부</span>
          )}
        </div>
        <textarea ref={textareaRef} id={`message_${e.key}`} name={`message_${e.key}`} rows={6}
          required defaultValue={e.template} />
        {e.photoSupported && (
          <p className="page-sub">
            사진첨부를 켜면 카카오는 사진 메시지로, 웹 챗봇은 썸네일+링크로 함께 보냅니다.
            지사 <a href={photoSettingsUrl}>사진 설정</a>에서 &quot;고객 열람 허용&quot;이 꺼져 있으면 나가지 않습니다.
          </p>
        )}
        <div className="notify-preview">
          <span className="notify-preview-label">예시 (저장하면 갱신됩니다)</span>
          <pre>{e.preview}</pre>
        </div>
      </div>
    </div>
  );
}

export default function NotificationEvents({ events, variables, photoSettingsUrl }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      {events.map((e) => (
        <EventBlock key={e.key} event={e} variables={variables} photoSettingsUrl={photoSettingsUrl} />
      ))}
    </>
  );
}
