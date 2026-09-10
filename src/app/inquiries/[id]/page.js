// 문의 상세 — views/inquiries/detail.ejs의 Next 판.
//
// 상태 변경과 오더 전환은 순수 HTML form이 Express로 POST한다(프록시가 비-GET을 전부
// Express로 보낸다). 오더 전환은 되돌릴 수 없어 확인창을 세운다 — EJS도 그랬다.
import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import ConfirmForm from '../../_components/ConfirmForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STATUSES = ['new', 'in_progress', 'waiting_customer', 'answered', 'converted_to_order', 'closed'];
const won = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원';

// 값이 없을 때 빈 칸을 두면 "0"인지 "모름"인지 구분이 안 된다 — EJS와 같이 '-'로 채운다.
function Field({ label, children, full }) {
  return (
    <div className={'field' + (full ? ' full' : '')}>
      <label>{label}</label>
      <div>{children === null || children === undefined || children === '' ? '-' : children}</div>
    </div>
  );
}

export default async function InquiryDetailPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/inquiries/${encodeURIComponent(id)}/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error('문의를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, inquiry, ferryLegs } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/inquiries">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">문의 상세 #{inquiry.id}</h1>
          <p className="page-sub">등록일 {inquiry.created_at} · 요청자 {inquiry.user_name || '-'}</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/inquiries">목록으로</a>
          {!inquiry.converted_order_id ? (
            <ConfirmForm message="이 문의를 오더로 전환하시겠습니까?" method="POST"
              action={`/inquiries/${inquiry.id}/convert-order`} style={{ display: 'inline' }}>
              <button className="btn" type="submit">오더로 전환</button>
            </ConfirmForm>
          ) : (
            <a className="btn" href={`/orders/${inquiry.converted_order_id}`}>
              전환된 오더 보기 ({inquiry.converted_oid || inquiry.converted_order_id})
            </a>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="row">
          <Field label="상태"><b>{inquiry.status}</b></Field>
          <Field label="카테고리">{inquiry.category}</Field>
          <Field label="지사">{inquiry.branch_name}</Field>
          <Field label="법인">{inquiry.corporation_name}</Field>
        </div>
        <form method="POST" action={`/inquiries/${inquiry.id}/status`} className="row"
          style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <div className="field">
            <label>상태 변경</label>
            <select name="status" defaultValue={inquiry.status}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="field" style={{ maxWidth: 140 }}>
            <button className="btn secondary" type="submit">저장</button>
          </div>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 10 }}>
        <div className="section-title">문의 원문</div>
        <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{inquiry.inquiry_text}</p>
      </div>

      <div className="card">
        <div className="section-title">요금 문의 분석 정보</div>
        <div className="row">
          <Field label="원본 출발지">{inquiry.origin_text}</Field>
          <Field label="원본 도착지">{inquiry.destination_text}</Field>
          <Field label="차종">{inquiry.vehicle_type}</Field>
        </div>
        <div className="row">
          <Field label="확정 출발지">{inquiry.resolved_origin}</Field>
          <Field label="확정 도착지">{inquiry.resolved_destination}</Field>
        </div>
        <div className="row">
          <Field label="예상 거리(km)">{inquiry.estimated_distance_km}</Field>
          <Field label="총 예상 요금">{inquiry.estimated_fare != null ? won(inquiry.estimated_fare) : null}</Field>
          <Field label="도선료">{inquiry.estimated_ferry_fare != null ? won(inquiry.estimated_ferry_fare) : null}</Field>
          <Field label="요금 기준">{inquiry.fare_source}</Field>
        </div>
        <div className="row">
          <Field label="배편 필요 가능성">
            <span className={'badge ' + (inquiry.has_ferry_leg ? 'red' : 'green')}>
              {inquiry.has_ferry_leg ? '높음' : '없음'}
            </span>
          </Field>
          <Field label="선박 구간" full>
            {ferryLegs && ferryLegs.length
              ? ferryLegs.map((leg, idx) => (
                <div key={idx} style={{ marginBottom: 6, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                  <b>{idx + 1})</b>{' '}
                  출발항: {leg.fromPort || '확인중'} / 도착항: {leg.toPort || '확인중'}
                  {leg.summary ? ` · ${leg.summary}` : ''}
                </div>
              ))
              : null}
          </Field>
        </div>
      </div>
    </AppShell>
  );
}
