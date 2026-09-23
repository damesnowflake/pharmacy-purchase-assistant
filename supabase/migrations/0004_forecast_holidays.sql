-- 예측 모델, 추천, 공휴일. 데이터베이스_설계.md, 상세_알고리즘_설계.md §4~7.

create table forecast_models (
  product_id uuid primary key references products(id) on delete cascade,
  model_version text not null,
  training_start date not null,
  training_end date not null,
  n_observed int not null,
  n_missing int not null,
  coefficients jsonb not null,
  mae numeric(14,4),
  wape numeric(10,4),
  warning_codes text[] not null default '{}',
  input_revision bigint not null,
  computed_at timestamptz not null default now()
);
comment on table forecast_models is '현재 모델 하나만 유지한다. 거래 근거에 쓰인 요약은 추천 기록에 보존한다.';

create type recommendation_status as enum ('review', 'waiting', 'received');
create type recommendation_decision as enum ('active', 'deferred', 'excluded');

create table recommendations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  status recommendation_status not null default 'review',
  decision recommendation_decision not null default 'active',
  arrival_date date not null,
  recommended_qty numeric(14,3) not null,
  basis_json jsonb not null,
  input_revision bigint not null,
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
comment on column recommendations.basis_json is '판매자료 기준일, 기준점 종류/수량, 도착일까지 수요, 7일 수요, MOQ·단위·모델버전·경고. 원본 180일 배열은 저장하지 않는다.';
-- 품목별 미종결 추천 최대 1개 (status가 received가 아닌 것)
create unique index recommendations_one_open_per_product_idx on recommendations (product_id)
  where status <> 'received';

create table holiday_dates (
  holiday_date date not null,
  name text not null,
  source text not null,
  primary key (holiday_date, source, name)
);

create table holiday_sync_runs (
  id uuid primary key default gen_random_uuid(),
  year int not null,
  status text not null check (status in ('success', 'failed', 'empty_confirmed')),
  fetched_at timestamptz not null default now(),
  coverage_start date,
  coverage_end date,
  last_error text
);
comment on table holiday_sync_runs is '정상 빈 결과(empty_confirmed)와 조회 실패(failed)를 구분한다.';

create table recompute_queue (
  product_id uuid primary key references products(id) on delete cascade,
  required_revision bigint not null,
  need_training boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'error')),
  lease_until timestamptz,
  attempts int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
comment on table recompute_queue is '같은 품목 작업은 합쳐서 처리한다. 실행 중 추가 변경 시 다음 계산을 남긴다.';
