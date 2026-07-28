-- Vertex AI OAuth access token을 서버리스 인스턴스 간 공유 캐싱하기 위한 테이블.
-- 콜드스타트마다 매번 새로 JWT 서명 + 토큰교환(구글 OAuth 왕복)을 하지 않도록,
-- 아직 유효한 토큰이 있으면 DB에서 재사용한다. 단일 행(id=1)만 사용한다.
create table if not exists vertex_token_cache (
  id integer primary key default 1,
  access_token text not null,
  expires_at timestamptz not null
);
