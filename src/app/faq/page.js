import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function FaqPage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/faq/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (!res.ok) throw new Error('FAQ 데이터를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/faq">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">FAQ 문의</h1>
          <p className="page-sub">궁금하신 내용을 입력하시면 등록된 지식 항목 중 가장 관련 있는 답변을 찾아드립니다.</p>
        </div>
      </div>

      <div className="card ai-chat-card faq-chat-card">
        <div className="ai-chat-header">💬 FAQ 챗봇</div>
        <div className="ai-chat-messages" id="faqMessages">
          <div className="ai-chat-bubble ai-bot">안녕하세요! 탁송 관련 궁금하신 점을 입력해주세요.</div>
        </div>
        <div className="ai-chat-input-row">
          <textarea id="faqQuestionInput" placeholder="예: 탁송 취소는 언제까지 가능한가요?" style={{ minHeight: 60 }}></textarea>
          <button type="button" className="btn" id="faqAskBtn">질문하기</button>
        </div>
      </div>

      <script src="/js/faq-chat.js" defer></script>
    </AppShell>
  );
}
