import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';

// 지사 설정 화면이 데이터를 읽는 한 가지 방법.
//
// 열세 화면이 같은 fetch를 반복한다 — 쿠키 전달, 401 → 로그인, 404 → notFound. 화면마다
// 다시 쓰면 한 곳에서만 401 처리를 빠뜨려도 그 화면만 조용히 깨진다.
export default async function loadBranchData(id, subPath) {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/branches/${encodeURIComponent(id)}/${subPath}/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`지사 설정을 불러오지 못했습니다 (${res.status})`);
  return res.json();
}
