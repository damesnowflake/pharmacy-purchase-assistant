-- 판매 자료. 데이터베이스_설계.md, 상세_알고리즘_설계.md §2, §9.

create type sales_import_mode as enum ('full_period', 'incremental');
create type sales_import_status as enum ('staging', 'applied', 'superseded', 'failed');

create table sales_imports (
  id uuid primary key default gen_random_uuid(),
  file_hash text not null,
  period_start date not null,
  period_end date not null,
  mode sales_import_mode not null,
  status sales_import_status not null default 'staging',
  object_path text,
  parser_version text not null,
  actor_id uuid not null references profiles(user_id),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  check (period_start <= period_end)
);
-- applied 상태의 파일 해시 중복 금지 (FR-07)
create unique index sales_imports_file_hash_applied_uidx on sales_imports (file_hash)
  where status = 'applied';

create table sales_import_rows (
  import_id uuid not null references sales_imports(id) on delete cascade,
  batch_no int not null,
  row_no int not null,
  product_id uuid references products(id),
  sale_date date not null,
  net_qty numeric(14,3) not null,
  raw_row jsonb,
  error_code text,
  primary key (import_id, batch_no, row_no)
);
comment on table sales_import_rows is '임시 적재 테이블. 적용 후 신속 정리하며 최대 30일 보관한다.';

create table sales_coverage (
  sale_date date primary key,
  import_id uuid not null references sales_imports(id),
  revision bigint not null default 1,
  status text not null check (status in ('complete', 'partial'))
);
comment on table sales_coverage is '실제로 확정된 전체 자료 기간만 complete로 기록한다.';

create table sales_daily (
  product_id uuid not null references products(id) on delete cascade,
  sale_date date not null,
  net_qty numeric(14,3) not null,
  import_id uuid not null references sales_imports(id),
  revision bigint not null default 1,
  primary key (product_id, sale_date)
);
comment on table sales_daily is '0행은 생략 가능. 순판매수량은 반품으로 음수 가능.';
create index sales_daily_sale_date_idx on sales_daily (sale_date);

create table sales_rollups (
  product_id uuid primary key references products(id) on delete cascade,
  retired_through date not null,
  retired_net_qty numeric(18,3) not null default 0,
  revision bigint not null default 1
);
comment on table sales_rollups is '이 날짜까지 삭제한 일별 판매 누적. 백업이 아니라 현재 계산의 입력이다.';
