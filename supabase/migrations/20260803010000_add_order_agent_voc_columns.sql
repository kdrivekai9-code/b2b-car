-- 오더 담당자 지정("내가 담당하기")과 VOC(사고/과태료/클레임) 접수 기록
alter table orders add column if not exists assigned_agent_id integer references users(id);
alter table orders add column if not exists voc_accident_note text;
alter table orders add column if not exists voc_fine_note text;
alter table orders add column if not exists voc_claim_note text;
