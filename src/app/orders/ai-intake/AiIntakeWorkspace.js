'use client';

import { useMemo, useState } from 'react';
import AiIntakeClient from './AiIntakeClient';
import OrderForm from '../new/OrderForm';

function toDraftPrefill(initialDraft) {
  const fields = (initialDraft && initialDraft.fields) || null;
  if (!fields || typeof fields !== 'object') return null;
  return {
    origin_address: fields.origin_address || '',
    origin_detail_address: fields.origin_detail_address || '',
    origin_contact: fields.origin_contact || '',
    destination_address: fields.destination_address || '',
    destination_detail_address: fields.destination_detail_address || '',
    destination_contact: fields.destination_contact || '',
    vehicle_type: fields.vehicle_type || '',
    vehicle_number: fields.vehicle_number || '',
    reserved_date: fields.reserved_date || '',
    reserved_time: fields.reserved_time || '',
    memo_customer: fields.memo_customer || '',
    memo_billing: fields.memo_billing || '',
  };
}

export default function AiIntakeWorkspace({
  initData,
  initialSession,
  initialMessages,
  initialDraft,
  serverTurnEnabled,
}) {
  const initialPrefill = useMemo(() => toDraftPrefill(initialDraft), [initialDraft]);
  const [prefill, setPrefill] = useState(initialPrefill);

  // 좌: 대화, 우: 접수 폼. 래퍼가 없으면 세로로 쌓인다(2026-09-11 지적).
  // 칸 나누기는 public/css/style.css의 .ai-intake-workspace에 있다 — 1300px 이하에서는
  // 그대로 세로로 쌓인다(폼이 두 칸이라 좁은 화면에서 옆에 붙이면 가로로 넘친다).
  return (
    <div className="ai-intake-workspace">
      <AiIntakeClient
        initialSession={initialSession}
        initialMessages={initialMessages}
        initialDraft={initialDraft}
        defaultGreeting="오더접수 내용을 붙여넣거나, 궁금하신 점을 질문해주세요."
        onOrderPrefill={(parsed) => setPrefill(parsed || null)}
        serverTurnEnabled={serverTurnEnabled}
      />

      <div className="ai-intake-workspace-order">
        {/* 카드 한 장을 통째로 쓰던 안내였는데, 옆으로 붙이고 나니 접수 폼이 그만큼
            아래로 밀렸다. 한 줄로 줄인다. */}
        <p className="page-sub" style={{ margin: '0 0 10px' }}>
          채팅에서 오더 접수로 인식된 항목은 아래 폼에 자동 입력됩니다. 필요한 값은 직접 수정 후 등록할 수 있습니다.
        </p>
        <OrderForm
          initialData={initData}
          chatSessionId={initialSession ? Number(initialSession.id) : undefined}
          externalPrefill={prefill}
        />
      </div>
    </div>
  );
}
