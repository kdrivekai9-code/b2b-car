import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import { fetchExpressJson } from '../../_lib/internalFetch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function ChatGuidePage() {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetchExpressJson('/chat/guide/data.json', { proto, host, cookie: hdrs.get('cookie') });
  if (res.status === 401) redirect('/login');
  if (res.status === 403) throw new Error('권한이 없습니다.');
  if (!res.ok) throw new Error('상담 운영안 정보를 불러오지 못했습니다 (' + res.status + ')');

  const { currentUser } = await res.json();

  return (
    <AppShell currentUser={currentUser} activePath="/chat/guide">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">상담 운영안 (담당자 지정형)</h1>
          <p className="page-sub">짧은 규칙, 예외 처리, 템플릿을 한 페이지로 정리한 팀 공지입니다.</p>
        </div>
        <div className="page-head-actions">
          <a className="btn secondary" href="/chat/sessions">상담 관리로 이동</a>
        </div>
      </div>

      <div className="card">
        <div className="section-title">1. 짧은 규칙</div>
        <ol>
          <li>한 세션은 한 명의 담당자만 고객에게 응답한다.</li>
          <li>비담당자는 고객 채널에 직접 답하지 않고 내부 공유만 한다.</li>
          <li>담당자가 없으면 고객 응답을 시작하지 않는다. 먼저 담당자 지정부터 한다.</li>
          <li>담당자 변경은 인수인계 문구를 남긴 뒤 진행한다.</li>
          <li>첫 응답 목표는 3분 이내, 내부 확인이 길어지면 중간 안내를 보낸다.</li>
        </ol>

        <div className="section-title small">운영 상태 기준</div>
        <p className="page-sub" style={{ marginBottom: 8 }}>대기 → 담당자 지정 → 응대중 → 내부확인중(필요시) → 종료</p>

        <div className="section-title">2. 예외 처리</div>
        <ol>
          <li>담당자 부재: 2분 내 미지정이면 팀 리더가 강제 지정한다.</li>
          <li>긴급/클레임: 일반 순서보다 우선 배정한다.</li>
          <li>전문영역 불일치: 담당자 변경을 허용하되, 변경 사유와 현재 상태를 함께 남긴다.</li>
          <li>장기 무응답: SLA 초과 시 리더가 재배정하고 고객에게 지연 안내를 보낸다.</li>
        </ol>

        <div className="section-title">3. 템플릿</div>

        <div className="route-stop" style={{ marginBottom: 10 }}>
          <h3 className="route-stop-title"><span className="route-marker">선점</span> 담당자 지정 알림</h3>
          <div className="page-sub" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>제가 이 건 담당하겠습니다. (담당자: 홍길동, 첫 회신 예정: 3분 이내)</div>
        </div>

        <div className="route-stop" style={{ marginBottom: 10 }}>
          <h3 className="route-stop-title"><span className="route-marker">인계</span> 담당자 변경 인수인계</h3>
          <div className="page-sub" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{`세션번호:
요청 요약:
현재 조치:
미해결 이슈:
고객에게 약속한 시간:
다음 액션:
특이사항:`}</div>
        </div>

        <div className="route-stop" style={{ marginBottom: 10 }}>
          <h3 className="route-stop-title"><span className="route-marker">고객</span> 내부확인 지연 안내</h3>
          <div className="page-sub" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>현재 내부 확인 중이며, OO분 이내로 다시 안내드리겠습니다. 기다려주셔서 감사합니다.</div>
        </div>

        <div className="route-stop">
          <h3 className="route-stop-title"><span className="route-marker">종료</span> 처리 완료 안내</h3>
          <div className="page-sub" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>요청하신 내용이 처리 완료되었습니다. 추가로 필요한 사항이 있으면 언제든 말씀해주세요.</div>
        </div>

        <div className="section-title">4. 운영 메타</div>
        <div className="session-meta" style={{ marginBottom: 10 }}>
          <span>운영 문서 버전: <b>v1.0</b></span>
          <span>최종 수정일: <b>2026-07-25</b></span>
          <span>운영 책임자: <b>상담운영 리더</b></span>
        </div>

        <div className="section-title small">SLA 요약</div>
        <div className="route-summary-grid" style={{ marginBottom: 4 }}>
          <div className="route-summary-item">
            <div className="label">담당자 지정</div>
            <div className="value">2분 이내</div>
          </div>
          <div className="route-summary-item">
            <div className="label">첫 고객 응답</div>
            <div className="value">3분 이내</div>
          </div>
          <div className="route-summary-item">
            <div className="label">중간 안내</div>
            <div className="value">10분 간격</div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
