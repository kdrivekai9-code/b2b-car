-- 레이턴시 개선: chat_sessions 조회/정렬용 인덱스, 오더 텍스트 검색용 trigram 인덱스.
-- 지금은 데이터가 적어 체감 차이가 없지만, 데이터가 쌓일수록 풀스캔을 막아준다.

create index concurrently if not exists idx_chat_sessions_user_id on chat_sessions(user_id);
create index concurrently if not exists idx_chat_sessions_status on chat_sessions(status);

-- 오더 리스트 검색(OID/출발지/도착지, LIKE '%...%')이 인덱스를 탈 수 있도록 trigram 인덱스 추가.
create extension if not exists pg_trgm;
create index concurrently if not exists idx_orders_oid_trgm on orders using gin (oid gin_trgm_ops);
create index concurrently if not exists idx_orders_origin_address_trgm on orders using gin (origin_address gin_trgm_ops);
create index concurrently if not exists idx_orders_destination_address_trgm on orders using gin (destination_address gin_trgm_ops);

-- 참고: knowledge_base.embedding용 pgvector ivfflat 인덱스는 아직 데이터가 너무 적어(현재 12건)
-- 지금 만들면 오히려 정확도가 떨어지는 퇴화된 인덱스가 되므로 의도적으로 보류함.
-- 지식 항목이 수백 건 이상으로 늘어난 뒤 별도로 추가할 것:
--   create index concurrently if not exists idx_knowledge_base_embedding
--     on knowledge_base using ivfflat (embedding vector_cosine_ops) with (lists = <sqrt(행수) 근처 값>);
