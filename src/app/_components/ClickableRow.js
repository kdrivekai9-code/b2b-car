'use client';

import { useRouter } from 'next/navigation';

// 행 전체를 눌러 상세로 가는 표 행 — EJS의 `<tr onclick="location.href=...">`를 옮긴 것.
//
// 왜 부품으로 두나(2026-09-11 실사용 지적): 문의 관리 목록이 Next로 이식되면서 이 동작이
// 빠졌다. 그런데 `cursor: pointer`는 그대로 남아서 **눌리는 것처럼 보이는데 아무 일도 안
// 일어났다** — 고장으로 읽힌다. 목록에서 요약이 잘려 보이므로 상세로 가는 길이 곧 그 화면의
// 쓸모다. 화면마다 다시 만들면 다음 이식에서 또 빠진다.
//
// 안쪽의 링크·버튼은 그대로 동작해야 한다 — 그 위에서 누른 클릭은 가로채지 않는다.
export default function ClickableRow({ href, children, ...props }) {
  const router = useRouter();
  return (
    <tr
      {...props}
      style={{ cursor: 'pointer', ...(props.style || {}) }}
      onClick={(e) => {
        if (e.target.closest('a, button, input, select, textarea, label')) return;
        router.push(href);
      }}
    >
      {children}
    </tr>
  );
}
