-- 오더 식별자 필드명을 uid(User ID와 혼동 우려) -> oid(Order ID)로 변경
alter table orders rename column uid to oid;
update orders set oid = replace(oid, 'UID', 'OID') where oid like 'UID%';
