-- 기사 챗봇 — 오더에 매인 기사 대화.
--
-- 핵심 결정은 "대화를 오더에 맨다"는 것 하나다. 기사는 하루에 여러 건을 돌고, 상담원은 여러
-- 기사를 동시에 상대한다. 대화가 사람 단위면 "그 차 어디예요"가 어느 건인지 매번 되물어야
-- 하고, 영수증은 어느 오더 것인지 알 수 없다. 오더에 매면 그 질문이 사라진다.
--
-- 새 표를 만들지 않고 chat_sessions/chat_messages를 그대로 쓴다. 고객 대화에서 이미 쓰이는
-- 상담원 배정·읽음 표시·실시간 중계가 전부 그 표에 붙어 있어서, 새 표를 파면 그걸 통째로 다시
-- 만들어야 한다. channel에 값 하나('driver')를 더하는 것으로 갈린다.

-- 어느 오더의 대화인가. 고객 대화는 비어 있을 수 있다 — 접수 전에 시작되기 때문이다.
alter table chat_sessions add column if not exists order_id bigint references orders(id);

-- 대화 상대인 기사.
alter table chat_sessions add column if not exists driver_id bigint references drivers(id);

-- 한 오더·한 기사에 대화는 하나만. 둘이 생기면 전달사항이 갈려서, 상담원이 보낸 말이
-- 기사에게 안 보이는 일이 생긴다.
create unique index if not exists chat_sessions_order_driver_idx
  on chat_sessions(order_id, driver_id) where channel = 'driver';

-- 상담 목록이 오더로 대화를 찾는다.
create index if not exists chat_sessions_order_idx on chat_sessions(order_id)
  where order_id is not null;

-- 콜마너 사번 ↔ 우리 기사 명부를 잇는 유일한 열쇠.
--
-- 지금 drivers에는 (id, branch_id, name, phone, status)뿐이라 콜마너가 배차한 기사와 우리
-- 명부를 이을 방법이 없다. orders.callmaner_driver_sabun에 배차될 때마다 사번이 쌓이므로,
-- 명부를 통째로 받지 않아도 배차된 기사부터 이어붙일 수 있다.
alter table drivers add column if not exists callmaner_sabun text;
create unique index if not exists drivers_sabun_idx
  on drivers(callmaner_sabun) where callmaner_sabun is not null;

-- 영수증이 어느 대화에서 올라왔는지. 정산에서 "이 금액의 근거"를 되짚을 때 쓴다.
-- 금액만 있고 사진이 어디 있는지 모르면, 청구를 다투는 자리에서 아무것도 못 한다.
alter table order_extra_charges add column if not exists chat_message_id bigint;
