-- 수량 사건(입고/발주/실사)과 재계산 가능한 캐시. 데이터베이스_설계.md, 상세_알고리즘_설계.md §6~9.

create type quantity_event_kind as enum ('receipt', 'order', 'count', 'order_cancel', 'stock_adjustment');

create table quantity_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid,
  product_id uuid not null references products(id),
  kind quantity_event_kind not null,
  qty_base numeric(14,3) not null,
  input_qty numeric(14,3) not null,
  input_unit text not null,
  input_factor numeric(14,6) not null,
  occurred_at timestamptz not null,
  recorded_seq bigint generated always as identity,
  supplier_id uuid references suppliers(id),
  recommendation_id uuid,
  day_boundary text check (day_boundary in ('end_of_day', 'mid_day')),
  active boolean not null default true,
  version bigint not null default 1,
  created_by uuid not null references profiles(user_id),
  created_at timestamptz not null default now(),
  constraint quantity_events_qty_sign check (
    (kind in ('receipt', 'order', 'order_cancel') and qty_base > 0) or
    (kind = 'count' and qty_base >= 0) or
    (kind = 'stock_adjustment' and qty_base <> 0)
  ),
  constraint quantity_events_day_boundary_only_count check (
    (kind = 'count' and day_boundary is not null) or
    (kind <> 'count' and day_boundary is null)
  )
);
create index quantity_events_product_time_idx on quantity_events (product_id, occurred_at, recorded_seq);
comment on table quantity_events is '입고 행에 발주 행 FK는 없다. 같은 사진의 여러 품목은 batch_id로만 묶는다.';

create table inventory_anchors (
  product_id uuid primary key references products(id) on delete cascade,
  source_event_id uuid references quantity_events(id),
  kind text not null check (kind in ('stock_count', 'last_receipt')),
  anchor_date date not null,
  sales_start_date date not null,
  qty_base numeric(14,3) not null,
  sales_before_start numeric(18,3) not null default 0,
  included_event_seq bigint,
  estimated_first_day_sales numeric(14,3),
  model_version text,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);
comment on table inventory_anchors is '실사/최신 입고 기준 현재 스냅샷. 과거 일별 삭제 후에도 기준일 이전 누적 판매를 재현하기 위한 값을 유지한다.';

create table product_state (
  product_id uuid primary key references products(id) on delete cascade,
  pending_qty numeric(14,3) not null default 0 check (pending_qty >= 0),
  data_revision bigint not null default 1,
  last_event_seq bigint not null default 0,
  last_settled_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table product_state is '재계산 가능한 캐시이며 입고 원천 사실을 대체하지 않는다.';

create table request_receipts (
  request_id uuid primary key,
  actor_id uuid not null references profiles(user_id),
  operation text not null,
  payload_hash text not null,
  result_json jsonb not null,
  created_at timestamptz not null default now()
);
comment on table request_receipts is '같은 request_id·같은 내용 재시도는 기존 성공 결과를 반환한다.';

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  actor_id uuid not null references profiles(user_id),
  action text not null,
  before jsonb,
  after jsonb,
  recorded_at timestamptz not null default now()
);
comment on table audit_events is '서버만 추가한다. 실제 변경만 기록한다.';
create index audit_events_entity_idx on audit_events (entity_type, entity_id, recorded_at);
