import { headers } from 'next/headers';
import { redirect, notFound } from 'next/navigation';

// 법인 설정 화면이 데이터를 읽는 한 가지 방법 — 지사(loadBranchData)와 짝을 이룬다.
export default async function loadGroupData(id, subPath) {
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const res = await fetch(`${proto}://${host}/groups/${encodeURIComponent(id)}/${subPath}/data.json`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`법인 설정을 불러오지 못했습니다 (${res.status})`);
  return res.json();
}
