-- 권한(RLS)과 원자적 업무 RPC. 시스템_구조_설계.md "인증과 서버 경계", "API와 트랜잭션",
-- 데이터베이스_설계.md "DB 권한", "저장 과정" 참고.
--
-- 원칙:
--  * 전체 업무 테이블 RLS 활성화, anon 권한 제거.
--  * 읽기는 RLS(활성 계정 확인)로, 쓰기는 SECURITY DEFINER RPC로만 허용한다.
--  * RPC는 호출자의 활성 여부·역할을 매 호출마다 DB에서 다시 확인한다 (요청 본문의 role/등록자 신뢰 안 함).
--  * search_path를 고정하고 완전한 스키마명을 사용한다.

revoke all on schema public from anon;
grant usage on schema public to authenticated;

-- ---------------------------------------------------------------------------
-- 호출자 확인 helper
-- ---------------------------------------------------------------------------
create or replace function current_active_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.profiles;
begin
  select * into p from public.profiles where user_id = auth.uid();
  if p.user_id is null then
    raise exception 'PROFILE_NOT_FOUND' using errcode = '28000';
  end if;
  if not p.active then
    raise exception 'ACCOUNT_INACTIVE' using errcode = '28000';
  end if;
  return p;
end;
$$;

create or replace function require_admin()
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p public.profiles;
begin
  p := current_active_profile();
  if p.role <> 'admin' then
    raise exception 'FORBIDDEN_ADMIN_ONLY' using errcode = '42501';
  end if;
  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS: 참조/설정 테이블 — 활성 계정 조회 허용, 쓰기는 RPC 전용 (쓰기 정책 없음 = 거부)
-- ---------------------------------------------------------------------------
alter table profiles enable row level security;
create policy profiles_select_own on profiles for select
  using (user_id = auth.uid());

alter table products enable row level security;
create policy products_select_active_profile on products for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table product_aliases enable row level security;
create policy product_aliases_select on product_aliases for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table product_units enable row level security;
create policy product_units_select on product_units for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table suppliers enable row level security;
create policy suppliers_select on suppliers for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table purchase_terms enable row level security;
create policy purchase_terms_select on purchase_terms for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table supplier_closed_dates enable row level security;
create policy supplier_closed_dates_select on supplier_closed_dates for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table holiday_dates enable row level security;
create policy holiday_dates_select on holiday_dates for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table holiday_sync_runs enable row level security;
create policy holiday_sync_runs_select on holiday_sync_runs for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

-- ---------------------------------------------------------------------------
-- RLS: 업무 자료 — 활성 계정 조회 허용 (직원 포함, 공유 업무 화면이므로)
-- ---------------------------------------------------------------------------
alter table sales_imports enable row level security;
create policy sales_imports_select on sales_imports for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table sales_coverage enable row level security;
create policy sales_coverage_select on sales_coverage for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table sales_daily enable row level security;
create policy sales_daily_select on sales_daily for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table sales_rollups enable row level security;
create policy sales_rollups_select on sales_rollups for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table quantity_events enable row level security;
create policy quantity_events_select on quantity_events for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table inventory_anchors enable row level security;
create policy inventory_anchors_select on inventory_anchors for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table product_state enable row level security;
create policy product_state_select on product_state for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table forecast_models enable row level security;
create policy forecast_models_select on forecast_models for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table recommendations enable row level security;
create policy recommendations_select on recommendations for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active));

alter table audit_events enable row level security;
create policy audit_events_select on audit_events for select
  using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.active and p.role = 'admin'));

-- request_receipts, sales_import_rows, recompute_queue: 클라이언트 직접 조회 불필요. RLS만 켜고 정책 없음(전면 거부).
alter table request_receipts enable row level security;
alter table sales_import_rows enable row level security;
alter table recompute_queue enable row level security;

-- ---------------------------------------------------------------------------
-- 테이블 권한(GRANT): RLS 정책은 이미 부여된 권한을 "제한"할 뿐 권한을 만들어주지 않는다.
-- authenticated 역할에 SELECT를 명시적으로 부여해야 위 정책들이 실제로 동작한다.
-- 쓰기는 SECURITY DEFINER RPC(함수 소유자 권한으로 실행)로만 하므로 INSERT/UPDATE/DELETE는
-- authenticated에게 부여하지 않는다.
-- ---------------------------------------------------------------------------
grant select on
  profiles, products, product_aliases, product_units, suppliers, purchase_terms,
  supplier_closed_dates, holiday_dates, holiday_sync_runs,
  sales_imports, sales_coverage, sales_daily, sales_rollups,
  quantity_events, inventory_anchors, product_state, forecast_models,
  recommendations, audit_events
to authenticated;

-- ---------------------------------------------------------------------------
-- 멱등성 helper: 같은 request_id·같은 내용 재시도는 기존 결과 반환, 다른 내용이면 충돌.
-- ---------------------------------------------------------------------------
create or replace function check_idempotency(
  p_request_id uuid, p_actor_id uuid, p_operation text, p_payload_hash text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.request_receipts;
begin
  select * into existing from public.request_receipts where request_id = p_request_id;
  if existing.request_id is not null then
    if existing.payload_hash <> p_payload_hash or existing.operation <> p_operation then
      raise exception 'REQUEST_CONFLICT' using errcode = '40001';
    end if;
    return existing.result_json;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- register_receipt: 입고 등록 (IR-13, FR-13~14). 여러 품목을 한 트랜잭션으로 처리한다.
-- items: [{product_id, quantity, unit}]
-- ---------------------------------------------------------------------------
create or replace function register_receipt(
  p_request_id uuid,
  p_occurred_at timestamptz,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  payload_hash text;
  cached jsonb;
  batch uuid := gen_random_uuid();
  item jsonb;
  v_product_id uuid;
  v_qty numeric(14,3);
  v_unit text;
  v_factor numeric(14,6);
  v_qty_base numeric(14,3);
  v_allows_fraction boolean;
  results jsonb := '[]'::jsonb;
  ordered_product_ids uuid[];
begin
  actor := current_active_profile(); -- 직원·관리자 모두 허용

  payload_hash := md5(p_occurred_at::text || p_items::text);
  cached := check_idempotency(p_request_id, actor.user_id, 'register_receipt', payload_hash);
  if cached is not null then
    return cached;
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = '22023';
  end if;

  -- 동시 입고·발주 직렬화를 위해 품목 ID 순서로 잠근다.
  select array_agg(distinct (i->>'product_id')::uuid order by (i->>'product_id')::uuid)
    into ordered_product_ids
    from jsonb_array_elements(p_items) i;

  perform 1 from products where id = any(ordered_product_ids) for update;

  for item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (item->>'product_id')::uuid;
    v_qty := (item->>'quantity')::numeric;
    v_unit := item->>'unit';

    if v_qty is null or v_qty <= 0 then
      raise exception 'INVALID_QUANTITY: %', item using errcode = '22023';
    end if;

    select factor_to_base into v_factor from product_units
      where product_id = v_product_id and unit_code = v_unit;
    if v_factor is null then
      raise exception 'UNKNOWN_UNIT: product=% unit=%', v_product_id, v_unit using errcode = '22023';
    end if;

    select allows_fraction into v_allows_fraction from products where id = v_product_id;
    v_qty_base := v_qty * v_factor;
    if not v_allows_fraction and v_qty_base <> trunc(v_qty_base) then
      raise exception 'FRACTION_NOT_ALLOWED: product=%', v_product_id using errcode = '22023';
    end if;

    insert into quantity_events (
      batch_id, product_id, kind, qty_base, input_qty, input_unit, input_factor,
      occurred_at, created_by
    ) values (
      batch, v_product_id, 'receipt', v_qty_base, v_qty, v_unit, v_factor,
      p_occurred_at, actor.user_id
    );

    perform recompute_product_state(v_product_id);

    results := results || jsonb_build_object(
      'product_id', v_product_id,
      'qty_base', v_qty_base,
      'pending_qty', (select pending_qty from product_state where product_id = v_product_id)
    );
  end loop;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('quantity_events_batch', batch, actor.user_id, 'register_receipt', p_items);

  cached := jsonb_build_object('batch_id', batch, 'items', results);
  insert into request_receipts (request_id, actor_id, operation, payload_hash, result_json)
    values (p_request_id, actor.user_id, 'register_receipt', payload_hash, cached);

  return cached;
end;
$$;

-- ---------------------------------------------------------------------------
-- recompute_product_state: 품목의 대기량을 원천 사건에서 다시 계산한다 (상세_알고리즘_설계.md §8).
-- 최초 버전은 전체 사건 재실행이다. 성능이 필요해지면 체크포인트를 추가한다.
-- ---------------------------------------------------------------------------
create or replace function recompute_product_state(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pending numeric(14,3) := 0;
  ev record;
  applied numeric(14,3);
  extra numeric(14,3);
  last_seq bigint := 0;
begin
  for ev in
    select id, kind, qty_base, occurred_at, recorded_seq
    from quantity_events
    where product_id = p_product_id and active
    order by occurred_at, recorded_seq
  loop
    last_seq := ev.recorded_seq;
    if ev.kind = 'order' then
      pending := pending + ev.qty_base;
    elsif ev.kind = 'receipt' then
      applied := least(pending, ev.qty_base);
      pending := pending - applied;
      extra := ev.qty_base - applied;
      -- 초과/미연결 입고는 audit_events에 남겨 관리자 화면에서 조회한다.
      if extra > 0 then
        insert into audit_events (entity_type, entity_id, actor_id, action, after)
        select 'quantity_event', ev.id, created_by, 'excess_receipt', jsonb_build_object('extra', extra)
        from quantity_events where id = ev.id
        on conflict do nothing;
      end if;
    elsif ev.kind = 'order_cancel' then
      applied := least(pending, ev.qty_base);
      pending := pending - applied;
    end if;
    -- count, stock_adjustment는 pending에 영향 없음
  end loop;

  insert into product_state (product_id, pending_qty, data_revision, last_event_seq, last_settled_at, updated_at)
  values (p_product_id, pending, 1, last_seq, now(), now())
  on conflict (product_id) do update set
    pending_qty = excluded.pending_qty,
    data_revision = product_state.data_revision + 1,
    last_event_seq = excluded.last_event_seq,
    last_settled_at = now(),
    updated_at = now();

  -- 대기량이 0이 된 진행 중 추천은 입고 반영으로 닫는다 (FR-30).
  update recommendations
    set status = 'received', closed_at = now()
    where product_id = p_product_id and status = 'waiting' and pending = 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- register_stock_count: 실사 등록 (IR-14, FR-15).
-- day_boundary: 'end_of_day' | 'mid_day'
-- ---------------------------------------------------------------------------
create or replace function register_stock_count(
  p_request_id uuid,
  p_product_id uuid,
  p_qty numeric,
  p_occurred_at timestamptz,
  p_day_boundary text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  payload_hash text;
  cached jsonb;
  event_id uuid;
begin
  actor := current_active_profile();

  if p_qty is null or p_qty < 0 then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;
  if p_day_boundary not in ('end_of_day', 'mid_day') then
    raise exception 'INVALID_DAY_BOUNDARY' using errcode = '22023';
  end if;

  payload_hash := md5(p_product_id::text || p_qty::text || p_occurred_at::text || p_day_boundary);
  cached := check_idempotency(p_request_id, actor.user_id, 'register_stock_count', payload_hash);
  if cached is not null then
    return cached;
  end if;

  perform 1 from products where id = p_product_id for update;

  insert into quantity_events (
    product_id, kind, qty_base, input_qty, input_unit, input_factor,
    occurred_at, day_boundary, created_by
  ) values (
    p_product_id, 'count', p_qty, p_qty, 'base', 1, p_occurred_at, p_day_boundary, actor.user_id
  ) returning id into event_id;

  -- 실사 기준점 갱신은 forecast-batch(Edge Function)가 담당한다.
  -- 여기서는 원천 사건만 기록하고 재계산은 recompute_queue에 예약한다.
  insert into recompute_queue (product_id, required_revision, need_training)
  values (p_product_id, 1, false)
  on conflict (product_id) do update set
    required_revision = recompute_queue.required_revision + 1,
    status = 'pending',
    updated_at = now();

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('quantity_event', event_id, actor.user_id, 'register_stock_count',
      jsonb_build_object('qty', p_qty, 'day_boundary', p_day_boundary));

  cached := jsonb_build_object('event_id', event_id);
  insert into request_receipts (request_id, actor_id, operation, payload_hash, result_json)
    values (p_request_id, actor.user_id, 'register_stock_count', payload_hash, cached);

  return cached;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_order: 발주 완료 표시 (IR-15, FR-29). 관리자만 허용.
-- ---------------------------------------------------------------------------
create or replace function confirm_order(
  p_request_id uuid,
  p_recommendation_id uuid,
  p_product_id uuid,
  p_supplier_id uuid,
  p_qty numeric,
  p_unit text,
  p_order_date date
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  payload_hash text;
  cached jsonb;
  v_factor numeric(14,6);
  v_qty_base numeric(14,3);
  event_id uuid;
  rec public.recommendations;
begin
  actor := require_admin();

  payload_hash := md5(coalesce(p_recommendation_id::text,'') || p_product_id::text || p_qty::text || p_unit || p_order_date::text);
  cached := check_idempotency(p_request_id, actor.user_id, 'confirm_order', payload_hash);
  if cached is not null then
    return cached;
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;

  select factor_to_base into v_factor from product_units
    where product_id = p_product_id and unit_code = p_unit;
  if v_factor is null then
    raise exception 'UNKNOWN_UNIT' using errcode = '22023';
  end if;
  v_qty_base := p_qty * v_factor;

  perform 1 from products where id = p_product_id for update;

  if p_recommendation_id is not null then
    select * into rec from recommendations where id = p_recommendation_id for update;
    if rec.id is null then
      raise exception 'RECOMMENDATION_NOT_FOUND' using errcode = '22023';
    end if;
    if rec.status <> 'review' then
      raise exception 'RECOMMENDATION_ALREADY_DECIDED' using errcode = '40001';
    end if;
  end if;

  insert into quantity_events (
    product_id, kind, qty_base, input_qty, input_unit, input_factor,
    occurred_at, supplier_id, recommendation_id, created_by
  ) values (
    p_product_id, 'order', v_qty_base, p_qty, p_unit, v_factor,
    p_order_date::timestamptz, p_supplier_id, p_recommendation_id, actor.user_id
  ) returning id into event_id;

  if p_recommendation_id is not null then
    update recommendations set status = 'waiting', version = version + 1
      where id = p_recommendation_id;
  end if;

  perform recompute_product_state(p_product_id);

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('quantity_event', event_id, actor.user_id, 'confirm_order',
      jsonb_build_object('qty_base', v_qty_base, 'supplier_id', p_supplier_id));

  cached := jsonb_build_object(
    'order_event_id', event_id,
    'pending_qty', (select pending_qty from product_state where product_id = p_product_id)
  );
  insert into request_receipts (request_id, actor_id, operation, payload_hash, result_json)
    values (p_request_id, actor.user_id, 'confirm_order', payload_hash, cached);

  return cached;
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_order: 발주 취소 (남은 대기량을 줄이는 현재 시점 사건). 관리자만 허용.
-- ---------------------------------------------------------------------------
create or replace function cancel_order(
  p_request_id uuid,
  p_product_id uuid,
  p_qty numeric,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  payload_hash text;
  cached jsonb;
  event_id uuid;
begin
  actor := require_admin();

  payload_hash := md5(p_product_id::text || p_qty::text || coalesce(p_reason,''));
  cached := check_idempotency(p_request_id, actor.user_id, 'cancel_order', payload_hash);
  if cached is not null then
    return cached;
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;

  perform 1 from products where id = p_product_id for update;

  insert into quantity_events (
    product_id, kind, qty_base, input_qty, input_unit, input_factor, occurred_at, created_by
  ) values (
    p_product_id, 'order_cancel', p_qty, p_qty, 'base', 1, now(), actor.user_id
  ) returning id into event_id;

  perform recompute_product_state(p_product_id);

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('quantity_event', event_id, actor.user_id, 'cancel_order', jsonb_build_object('qty', p_qty, 'reason', p_reason));

  cached := jsonb_build_object(
    'cancel_event_id', event_id,
    'pending_qty', (select pending_qty from product_state where product_id = p_product_id)
  );
  insert into request_receipts (request_id, actor_id, operation, payload_hash, result_json)
    values (p_request_id, actor.user_id, 'cancel_order', payload_hash, cached);

  return cached;
end;
$$;

-- ---------------------------------------------------------------------------
-- save_product_settings: 품목/거래처 조건 설정 (IR-06, FR-17). 관리자만 허용.
-- ---------------------------------------------------------------------------
create or replace function save_product_settings(
  p_product_id uuid,
  p_expected_version bigint,
  p_default_moq numeric,
  p_default_order_step numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  current_version bigint;
begin
  actor := require_admin();

  select version into current_version from products where id = p_product_id for update;
  if current_version is null then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
  end if;
  if current_version <> p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;
  if p_default_moq is not null and p_default_moq <= 0 then
    raise exception 'INVALID_MOQ' using errcode = '22023';
  end if;
  if p_default_order_step is not null and p_default_order_step <= 0 then
    raise exception 'INVALID_ORDER_STEP' using errcode = '22023';
  end if;

  update products set
    default_moq = p_default_moq,
    default_order_step = p_default_order_step,
    version = version + 1
  where id = p_product_id;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('product', p_product_id, actor.user_id, 'save_product_settings',
      jsonb_build_object('default_moq', p_default_moq, 'default_order_step', p_default_order_step));

  return jsonb_build_object('product_id', p_product_id, 'version', current_version + 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- 아직 구현하지 않은 RPC: 판매 파일 반영(원자적 기간 교체)과 예측/공휴일 배치는
-- 실제 CatPOS 표본·공휴일 API 키 확인 후 구현한다 (docs/미확인_항목.md 참고).
-- 자리표시자는 명시적으로 예외를 던져 미완성 기능이 조용히 성공한 것처럼 보이지 않게 한다.
-- ---------------------------------------------------------------------------
create or replace function begin_sales_import(p_period_start date, p_period_end date, p_file_hash text, p_mode sales_import_mode)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform current_active_profile();
  raise exception 'NOT_IMPLEMENTED: 실제 CatPOS 표본 확인 후 구현 (docs/미확인_항목.md)' using errcode = '0A000';
end;
$$;

create or replace function commit_sales_import(p_import_id uuid, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform current_active_profile();
  raise exception 'NOT_IMPLEMENTED: 실제 CatPOS 표본 확인 후 구현 (docs/미확인_항목.md)' using errcode = '0A000';
end;
$$;

-- ---------------------------------------------------------------------------
-- 함수 실행 권한: authenticated에게만 부여하고 anon은 차단한다.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
grant execute on function
  register_receipt(uuid, timestamptz, jsonb),
  register_stock_count(uuid, uuid, numeric, timestamptz, text),
  confirm_order(uuid, uuid, uuid, uuid, numeric, text, date),
  cancel_order(uuid, uuid, numeric, text),
  save_product_settings(uuid, bigint, numeric, numeric),
  begin_sales_import(date, date, text, sales_import_mode),
  commit_sales_import(uuid, bigint)
to authenticated;
