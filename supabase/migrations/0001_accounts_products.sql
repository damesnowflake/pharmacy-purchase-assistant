-- 계정·품목·거래처. 데이터베이스_설계.md "테이블과 제약" 참고.
-- 마이그레이션 순서: ① 계정·품목 ② 판매 ③ 수량 기록·캐시 ④ 예측·휴일 ⑤ 권한·RPC

create extension if not exists "pgcrypto";

create type user_role as enum ('admin', 'staff');

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role user_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table profiles is '업무 역할과 활성 상태만 저장한다. 비밀번호는 auth.users가 관리한다.';

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  spec text not null default '',
  category text,
  base_unit text not null,
  allows_fraction boolean not null default false,
  observed_from date not null,
  active boolean not null default true,
  default_moq numeric(14,3) check (default_moq is null or default_moq > 0),
  default_order_step numeric(14,3) check (default_order_step is null or default_order_step > 0),
  created_by uuid references profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1
);
comment on column products.observed_from is '관측 가능 시작일. 첫 판매일과 혼동하지 않는다.';

create unique index products_name_spec_active_idx on products (name, spec) where active;

create table product_aliases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  source text not null,
  source_code text,
  alias text not null,
  normalized_alias text not null,
  spec text,
  created_at timestamptz not null default now()
);
create unique index product_aliases_source_code_uidx on product_aliases (source, source_code)
  where source_code is not null;
create index product_aliases_normalized_idx on product_aliases (normalized_alias);

create table product_units (
  product_id uuid not null references products(id) on delete cascade,
  unit_code text not null,
  factor_to_base numeric(14,6) not null check (factor_to_base > 0),
  primary key (product_id, unit_code)
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  minimum_drug_amount numeric(14,2) not null default 200000 check (minimum_drug_amount >= 0),
  minimum_other_amount numeric(14,2) not null default 50000 check (minimum_other_amount >= 0),
  promotion_note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 1
);
comment on column suppliers.minimum_drug_amount is '의약품 최소주문금액 참고 기본값 20만원 (소프트웨어_요구사항_명세서.md FR-18).';
comment on column suppliers.minimum_other_amount is '의약외품 최소주문금액 참고 기본값 5만원.';

create table purchase_terms (
  product_id uuid not null references products(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  moq_base numeric(14,3) not null check (moq_base > 0),
  step_base numeric(14,3) not null check (step_base > 0),
  preferred boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (product_id, supplier_id)
);
-- 선호 거래처는 품목당 최대 1개
create unique index purchase_terms_one_preferred_idx on purchase_terms (product_id) where preferred;

create table supplier_closed_dates (
  supplier_id uuid not null references suppliers(id) on delete cascade,
  closed_date date not null,
  reason text,
  primary key (supplier_id, closed_date)
);

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger products_set_updated_at before update on products
  for each row execute function set_updated_at();
create trigger suppliers_set_updated_at before update on suppliers
  for each row execute function set_updated_at();
create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();
