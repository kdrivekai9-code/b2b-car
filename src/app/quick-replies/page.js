// 빠른 답변 관리 — views/quick_replies/index.ejs의 Next 판.
//
// 저장·중지·삭제는 전부 순수 HTML form이 Express로 POST한다(프록시가 비-GET을 전부 Express로
// 보내므로 그대로 동작한다). 그래서 클라이언트 컴포넌트가 필요 없다 — 화면 하나가 통째로
// 서버 컴포넌트다.
//
// EJS는 표 안의 각 행을 <form> 하나로 묶으려고 행 밖에 form을 두고 form 속성으로 연결한다
// (<td> 안에 <form>을 넣으면 브라우저가 표 밖으로 끌어낸다). 그 구조를 그대로 옮겼다.
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';
import ConfirmForm from '../_components/ConfirmForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function QuickRepliesPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/quick-replies/admin-data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (!res.ok) throw new Error('빠른 답변을 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser, replies, categories } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/quick-replies">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">빠른 답변 관리</h1>
          <p className="page-sub">
            상담 중 반복해서 치는 문구를 등록해 두면, 채팅 입력창 옆 <strong>⚡ 버튼</strong>에서 골라 바로 넣을 수 있습니다.
            본문에 <code>{'{상담원}'}</code>을 쓰면 보낼 때 로그인한 상담원 이름으로 바뀝니다.
          </p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/chat/sessions?view=card">상담 관리로</a>
          <button className="btn" type="submit" form="quickReplyForm">등록</button>
        </div>
      </div>

      {sp.error ? <div className="error-msg">{sp.error}</div> : null}
      {sp.notice ? <div className="success-msg">{sp.notice}</div> : null}

      <div className="card">
        <form id="quickReplyForm" method="POST" action="/quick-replies">
          <div className="section-title">⚡ 빠른 답변 등록</div>
          <div className="row">
            <div className="field">
              <label htmlFor="qr_category">분류</label>
              <select id="qr_category" name="category">
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="qr_title">제목</label>
              <input type="text" id="qr_title" name="title" placeholder="예: 확인 후 답변" required />
              <p className="page-sub">목록에서 고를 때 보이는 짧은 이름입니다.</p>
            </div>
            <div className="field">
              <label htmlFor="qr_sort">정렬</label>
              <input type="number" id="qr_sort" name="sort_order" defaultValue={0} />
              <p className="page-sub">작을수록 위에 나옵니다.</p>
            </div>
          </div>
          <div className="field full">
            <label htmlFor="qr_body">문구 내용</label>
            <textarea id="qr_body" name="body" rows={3}
              placeholder="예: 안녕하세요, {상담원} 상담원입니다. 무엇을 도와드릴까요?" required />
          </div>
        </form>
      </div>

      <div className="card">
        <div className="section-title">등록된 빠른 답변 ({replies.length})</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>분류</th><th>제목</th><th>문구</th><th>정렬</th><th>사용</th><th>관리</th></tr>
            </thead>
            <tbody>
              {replies.length === 0 && (
                <tr><td colSpan={6} className="empty">등록된 빠른 답변이 없습니다.</td></tr>
              )}
              {replies.map((r) => (
                <tr key={r.id}>
                  {/* 행 전체를 하나의 form으로 묶는다 — <td> 안에 <form>을 두면 브라우저가
                      표 밖으로 끌어내 값이 안 실린다(EJS와 같은 구조). */}
                  <td>
                    <form method="POST" action={`/quick-replies/${r.id}`} id={`qrEdit${r.id}`} />
                    <select name="category" form={`qrEdit${r.id}`} defaultValue={r.category}>
                      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td><input type="text" name="title" defaultValue={r.title} form={`qrEdit${r.id}`} style={{ minWidth: 140 }} /></td>
                  <td><textarea name="body" rows={2} form={`qrEdit${r.id}`} defaultValue={r.body} style={{ minWidth: 320, width: '100%' }} /></td>
                  <td><input type="number" name="sort_order" defaultValue={r.sort_order} form={`qrEdit${r.id}`} style={{ width: 70 }} /></td>
                  <td><span className={'badge ' + (r.is_active ? 'green' : 'gray')}>{r.is_active ? '사용' : '중지'}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" type="submit" form={`qrEdit${r.id}`}>저장</button>
                    <form method="POST" action={`/quick-replies/${r.id}/toggle`} style={{ display: 'inline' }}>
                      <button className="btn small secondary" type="submit">{r.is_active ? '중지' : '사용'}</button>
                    </form>
                    <ConfirmForm message="이 빠른 답변을 삭제하시겠습니까?" method="POST" action={`/quick-replies/${r.id}/delete`} style={{ display: 'inline' }}>
                      <button className="btn small danger" type="submit">삭제</button>
                    </ConfirmForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
