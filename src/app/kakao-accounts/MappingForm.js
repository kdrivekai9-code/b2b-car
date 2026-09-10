'use client';

import { useEffect, useRef, useState } from 'react';

// 채널 매핑 등록 폼 — views/kakao_accounts/index.ejs의 <script> 세 덩어리를 옮겼다.
//
// 이 화면에서 클라이언트 동작이 모여 있는 곳이라 폼만 따로 뺐다:
//   1. 최근 세션에서 키 가져오기(고르면 두 칸을 채우고, 이름·연락처를 기억한다)
//   2. "미등록계정"을 고르면 저장 대신 사용자 등록 화면으로 보낸다
//   3. 지사를 고르면 그 지사의 법인만 남긴다(서버에서도 같은 검증을 한다)
export default function MappingForm({ recentSessions, users, branches, groups, paymentMethods, error }) {
  const formRef = useRef(null);
  const [serviceKey, setServiceKey] = useState('');
  const [externalUserKey, setExternalUserKey] = useState('');
  const [branchId, setBranchId] = useState('');
  const [userId, setUserId] = useState('');
  // "미등록계정"으로 넘길 때 쓸 값 — 세션을 고른 순간의 이름·연락처를 기억해둔다.
  const picked = useRef({ name: '', phone: '' });

  // 등록 실패는 배너로도 보이지만 "이미 등록된 사용자입니다" 같은 안내는 놓치기 쉬워
  // 팝업으로도 띄운다(사용자 확정 요청). EJS는 이걸 인라인 스크립트로 했는데, 그러다
  // 반사형 XSS를 막으려고 toScriptJson까지 필요했다 — React는 값으로 넘기므로 그 위험이 없다.
  useEffect(() => {
    if (error) window.alert(error);
  }, [error]);

  const visibleGroups = groups.filter((g) => !branchId || String(g.branch_id) === String(branchId));

  return (
    <form
      id="kakaoAccountForm"
      ref={formRef}
      method="POST"
      action="/kakao-accounts"
      onSubmit={(e) => {
        // "미등록계정"이면 저장을 시도하지 않는다(담당 계정이 없어 서버가 막는다) —
        // 이름·연락처·지사를 채워 사용자 등록 화면으로 보낸다. 새 계정을 만든 뒤
        // return_to로 이 화면에 돌아와 그 계정을 담당으로 고르면 된다.
        if (userId !== '__unregistered__') return;
        e.preventDefault();
        const params = new URLSearchParams();
        if (picked.current.name) params.set('name', picked.current.name);
        if (picked.current.phone) params.set('phone', picked.current.phone);
        if (branchId) params.set('branch_id', branchId);
        params.set('return_to', '/kakao-accounts');
        window.location.href = '/users/new?' + params.toString();
      }}
    >
      <div className="section-title">🔗 채널 매핑 등록</div>

      <div className="row">
        <div className="field">
          <label>service_key (발신프로필 키)</label>
          <input type="text" name="service_key" placeholder="예: b85d2bbb95062ed615…"
            value={serviceKey} onChange={(e) => setServiceKey(e.target.value)} />
          <p className="page-sub">이 값만 넣으면 <strong>채널 전체</strong>에 적용됩니다.</p>
        </div>
        <div className="field">
          <label>고객 키 (external_user_key)</label>
          <input type="text" name="external_user_key" placeholder="특정 고객만 지정할 때"
            value={externalUserKey} onChange={(e) => setExternalUserKey(e.target.value)} />
          <p className="page-sub">함께 넣으면 <strong>그 고객만</strong> 적용되고, 채널 전체 매핑보다 우선합니다.</p>
        </div>
      </div>

      {recentSessions.length > 0 && (
        <div className="field full">
          <label htmlFor="sessionKeyPicker">최근 카카오 세션에서 키 가져오기</label>
          <select
            id="sessionKeyPicker"
            defaultValue=""
            onChange={(e) => {
              const s = recentSessions.find((x) => String(x.id) === e.target.value);
              setServiceKey(s ? s.kakao_service_key || '' : '');
              setExternalUserKey(s ? s.external_user_key || '' : '');
              picked.current = { name: (s && s.external_name) || '', phone: (s && s.external_phone) || '' };
            }}
          >
            <option value="">직접 입력</option>
            {recentSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.external_name ? s.external_name + ' · ' : ''}#{s.id} · {s.created_at} ·
                {' '}service={String(s.kakao_service_key).slice(0, 12)}… user={s.external_user_key || '-'}
              </option>
            ))}
          </select>
          <p className="page-sub">고르면 위 두 칸이 자동으로 채워집니다. 이미 채널 매핑이 된 고객은 이 목록에서 빠집니다.</p>
        </div>
      )}

      <div className="row">
        <div className="field">
          <label>담당 계정 <span className="req">*</span></label>
          <select name="user_id" id="userIdSelect" required value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">계정을 선택하세요</option>
            <option value="__unregistered__">미등록계정 — 새 사용자로 등록</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.login_id})</option>)}
          </select>
          <p className="page-sub">
            이 계정 이름으로 오더가 등록되고, 주문 조회 권한도 이 계정 기준입니다.
            아직 b2b-car 계정이 없는 고객이면 <strong>미등록계정</strong>을 고르세요 —
            등록을 누르면 이름·연락처를 채운 사용자 등록 화면으로 이동합니다.
          </p>
        </div>
        <div className="field">
          <label>지사 <span className="req">*</span></label>
          <select name="branch_id" required value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">지사를 선택하세요</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label>요청 법인 <span className="req">*</span></label>
          <select name="requester_group_id" required defaultValue="">
            <option value="">법인을 선택하세요</option>
            {visibleGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <p className="page-sub">청구·귀속 기준일 뿐 아니라 주문 조회 경계이기도 합니다 — 같은 담당 계정을 여러 법인 매핑이 함께 써도, 이 값이 있어야 서로의 접수 건이 섞이지 않습니다.</p>
        </div>
        <div className="field">
          <label>결제수단</label>
          <select name="payment_method_id" defaultValue="">
            <option value="">지정 안 함</option>
            {paymentMethods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <div className="field full">
        <label className="checkline">
          <input type="checkbox" name="auto_register" value="1" defaultChecked />
          접수 폼을 받으면 <strong>오더를 자동 등록</strong>한다
        </label>
        <p className="page-sub">
          자동 등록된 오더는 상태가 <strong>오더등록</strong>이고 콜마너에도 <strong>대기</strong>로 접수되어,
          담당자가 확인하기 전에 배차가 돌지 않습니다(웹 챗봇과 동일). 꺼두면 파싱만 하고 상담원에게 인계합니다 —
          꺼져 있어도 <strong>주문 조회·변경·취소(배차 도우미)는 동작</strong>합니다.
        </p>
      </div>
    </form>
  );
}
