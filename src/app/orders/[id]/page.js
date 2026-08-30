import { headers } from 'next/headers';
import CallmanerPhotos from './CallmanerPhotos';
import DriverLocationMap from './DriverLocationMap';
import { redirect } from 'next/navigation';
import AppShell from '../../_components/AppShell';
import OrderForm from '../new/OrderForm';
import OrderDetailAdminPanels from './OrderDetailAdminPanels';
import OrderVocPanel from './OrderVocPanel';
import OrderExtraChargesPanel from './OrderExtraChargesPanel';
import OdometerSummary from './OdometerSummary';

// 오더 상세페이지를 기존 접수폼(OrderForm.js, /orders/new)의 edit 모드로 재사용 —
// views/orders/detail.ejs는 수정이 아예 불가능한 읽기전용 화면이었다. 모든 역할(admin/
// branch_manager/client)이 이제 자기 소속 오더를 직접 수정할 수 있다. OrderForm 안의
// 03번 자리(경로 미리보기 대신 기사배정 정보 + 오더수정이력, OrderSidePanel.js)는 역할과
// 무관하게 항상 보인다(기사배정 "수정"만 admin/branch_manager 전용). 상태변경/관리자메모는
// 여전히 admin/branch_manager 전용(OrderDetailAdminPanels.js). 사진은 역할별 열람 권한
// (canViewPhotos, branch_photo_settings 기준)에 따라 아래에서 공통으로 보여준다.
// NEXT_ORDER_DETAIL_EDIT_ENABLED=true일 때만 도달(src/proxy.js).
export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const STATUS_COLORS = {
  '오더등록': 'gray', '대기': 'gray', '대기(확인중)': 'amber', '접수': 'blue',
  '접수(배차중)': 'blue', '기사배정': 'amber', '운행시작': 'teal', '문의': 'purple', '사고': 'red',
  '과태료': 'red', '취소요청': 'red', '취소': 'dark', '완료': 'green',
};

export default async function OrderDetailPage({ params }) {
  const { id } = await params;
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/orders/${id}/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });

  if (res.status === 401) redirect('/login');
  if (res.status === 403) {
    return (
      <>
        <h1 className="page-title">403 · 접근 권한 없음</h1>
        <p className="page-sub">이 오더에 접근할 권한이 없습니다.</p>
        <a className="btn secondary" href="/orders">← 오더 리스트로</a>
      </>
    );
  }
  if (res.status === 404) {
    return (
      <>
        <h1 className="page-title">오더를 찾을 수 없습니다</h1>
        <a className="btn secondary" href="/orders">← 오더 리스트로</a>
      </>
    );
  }
  if (!res.ok) throw new Error('오더 상세를 불러오지 못했습니다 (' + res.status + ')');

  const data = await res.json();
  const { order, currentUserRole } = data;
  const isAdminOrBranchManager = currentUserRole === 'admin' || currentUserRole === 'branch_manager';

  return (
    <AppShell currentUser={data.currentUser} activePath="/orders">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">
            오더 상세 · {order.oid}
            {order.callmaner_conf_slip && (
              <>
                {'  '}
                <span className="callmaner-conf-slip">콜마너접수번호 : {order.callmaner_conf_slip}</span>
              </>
            )}
          </h1>
          <p className="page-sub">
            <span className={`badge ${STATUS_COLORS[order.status] || 'gray'}`}>{order.status}</span>
            {/* 나눠 접수한 건이면 몇 건 중 몇 번째인지 밝힌다 — 나누고 나면 두 건이 서로 남남이라,
                이 표시가 없으면 한쪽만 보고 "이게 전부"라고 판단하게 된다.
                views/orders/detail.ejs에도 같은 배지가 있다. */}
            {order.split_group_id && order.split_total > 1 && (
              <span className="badge purple">분리접수 {order.split_seq}/{order.split_total}건</span>
            )}
            &nbsp; {order.branch_name} · {order.group_name || '-'} · 등록일시 {order.created_at}
          </p>
        </div>
        <div className="page-head-actions">
          {/* 이 페이지는 서버 컴포넌트라 OrderForm.js의 submitting state(저장 중 비활성화)를
              여기서 반영할 수 없다 — 순수 HTML form 속성으로 그 폼(id="order-edit-form")을
              가리키기만 하고, 실제 중복제출 방지는 OrderForm.js의 submittingRef가 담당한다
              (사용자 요청: 하단 취소 버튼 삭제 + 저장 버튼을 "오더수정"으로 바꿔 상단으로 이동). */}
          <button type="submit" form="order-edit-form" className="btn">오더수정</button>
          <a className="btn secondary" href="/orders">&larr; 오더 리스트로</a>
        </div>
      </div>

      <OrderForm initialData={data} mode="edit" orderId={id} />

      {data.canViewPhotos && (
        <div className="card" style={{ marginTop: 18 }}>
          <h2>📷 기사 업로드 사진</h2>
          {data.photos.length === 0 ? (
            <p className="page-sub" style={{ margin: 0 }}>업로드된 사진이 없습니다.</p>
          ) : (
            <>
              <div className="upload-gallery">
                {data.photos.map((p) => (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer"><img src={p.url} alt="업로드된 사진" /></a>
                ))}
              </div>
              {/* 기사가 계기판 사진과 함께 적어둔 값. views/orders/detail.ejs에도 같은 요약이 있다. */}
              <OdometerSummary photos={data.photos} />
            </>
          )}
        </div>
      )}

      {/* 기사 위치 — 관리자·지사뿐 아니라 고객도 자기 오더의 기사 위치를 본다(사용자 지시).
          "지금 어디쯤이에요?"가 상담 문의의 큰 몫이라, 화면에서 스스로 확인하면 그만큼 줄어든다.
          배차 전·완료 후에는 컴포넌트가 스스로 아무것도 그리지 않는다. */}
      <div style={{ marginTop: 18 }}>
        <DriverLocationMap orderId={id} status={data.order.status} />
      </div>

      {/* 콜마너 탁송사진 — 썸네일 깨짐 처리(onError)를 위해 클라이언트 컴포넌트로 뺐다.
          이 파일은 서버 컴포넌트라 이벤트 핸들러를 넘길 수 없다. */}
      {data.canViewPhotos && <CallmanerPhotos photos={data.callmanerPhotos} />}

      {/* VOC 접수는 역할 무관 공통 — 실제로 사고/과태료/클레임을 겪는 쪽은 고객사라
          고객사도 자기 오더에 직접 접수할 수 있어야 한다(서버 권한은 loadOrderForVoc가
          scopeFilter로 자기 지사·법인 오더인지 확인). 관리자는 여기서 접수 내용을 그대로 본다. */}
      <div style={{ marginTop: 18 }}>
        <OrderVocPanel data={data} orderId={id} />
      </div>

      {isAdminOrBranchManager && (
        <div style={{ marginTop: 18 }}>
          {/* 기타 정산 내역은 거래처에 청구할 금액이라 고객에게는 보이지 않는다 — 서버도
              같은 기준으로 막는다(POST /:id/extra-charges). */}
          <OrderExtraChargesPanel data={data} orderId={id} />
          <OrderDetailAdminPanels data={data} orderId={id} />
        </div>
      )}
    </AppShell>
  );
}
