import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';

// 법인 설정 화면이 데이터를 읽는 한 가지 방법 — 지사(loadBranchData)와 짝을 이룬다.
// query는 화면의 searchParams를 그대로 넘길 때 쓴다(계정 화면의 ?edit=처럼 **서버가 읽는**
// 값이 있는 경우). subPath에 물음표를 붙여 넘기면 경로가 `/accounts?edit=5/data.json`으로
// 깨진다 — 처음에 그렇게 썼다가 잡았다.
export default async function loadGroupData(id, subPath, query) {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const qs = query ? new URLSearchParams(query).toString() : '';
  const url = `${proto}://${host}/groups/${encodeURIComponent(id)}/${subPath}/data.json${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`법인 설정을 불러오지 못했습니다 (${res.status})`);
  return res.json();
}
