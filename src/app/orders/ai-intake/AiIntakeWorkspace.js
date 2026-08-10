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

  return (
    <>
      <AiIntakeClient
        initialSession={initialSession}
        initialMessages={initialMessages}
        initialDraft={initialDraft}
        defaultGreeting="오더접수 내용을 붙여넣거나, 궁금하신 점을 질문해주세요."
        onOrderPrefill={(parsed) => setPrefill(parsed || null)}
        serverTurnEnabled={serverTurnEnabled}
      />

      <div style={{ marginTop: 16 }}>
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="card-section-head">
            <div>
              <span className="section-kicker">ORDER BINDING</span>
              <h2>AI 파싱 결과 자동 반영 폼</h2>
            </div>
          </div>
          <p className="page-sub" style={{ margin: 0 }}>
            채팅에서 오더 접수로 인식된 항목은 아래 오더 폼에 자동 입력됩니다. 필요한 값은 직접 수정 후 등록할 수 있습니다.
          </p>
        </div>
        <OrderForm
          initialData={initData}
          chatSessionId={initialSession ? Number(initialSession.id) : undefined}
          externalPrefill={prefill}
        />
      </div>
    </>
  );
}
