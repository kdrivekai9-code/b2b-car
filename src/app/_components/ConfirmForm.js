'use client';

// 되돌릴 수 없는 동작(삭제·세션 종료·덮어쓰기) 앞에 확인창을 세운다.
//
// 왜 부품으로 두나: 서버 컴포넌트는 onSubmit 같은 핸들러를 붙일 수 없다. 그래서 EJS의
// `onsubmit="return confirm(...)"`이 이식 과정에서 **조용히 사라졌다** — 공지 삭제, 지식베이스
// 삭제, 분류 삭제, 계정 접속 종료 다섯 화면이 확인 없이 바로 실행되고 있었다(2026-09-10 실측).
// 화면마다 작은 클라이언트 컴포넌트를 새로 만들면 다음 이식에서 또 빠진다.
//
// form 자체를 감싸므로 쓰는 쪽은 <form>을 <ConfirmForm>으로 바꾸기만 하면 된다.
export default function ConfirmForm({ message, children, ...props }) {
  return (
    <form
      {...props}
      onSubmit={(e) => {
        // 메시지가 없으면 확인을 묻지 않는다 — 실수로 빈 값이 와도 동작 자체는 막지 않는다.
        if (message && !window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </form>
  );
}
