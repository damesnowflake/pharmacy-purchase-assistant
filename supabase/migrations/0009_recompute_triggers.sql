-- FR-28: "판매·입고·실사·발주·휴일·발주조건 변경 시 관련 추천을 갱신한다." 0005/0006에서는
-- register_stock_count와 commit_sales_import(0007)만 recompute_queue에 등록했다. 나머지
-- 쓰기 경로(입고, 발주 확정/취소, 품목·거래처 조건 변경)도 등록하도록 함수를 다시 정의한다.
-- 판매·실사만 회귀 재학습이 필요하고(need_training=true), 나머지는 추천 재계산만 필요하다
-- (need_training=false) — forecast-batch가 need_training 값을 보고 판단한다.

create or replace function enqueue_recompute(p_product_id uuid, p_need_training boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into recompute_queue (product_id, required_revision, need_training, status)
  values (p_product_id, 1, p_need_training, 'pending')
  on conflict (product_id) do update set
    required_revision = recompute_queue.required_revision + 1,
    need_training = recompute_queue.need_training or excluded.need_training,
    status = case when recompute_queue.status = 'processing' then recompute_queue.status else 'pending' end,
    updated_at = now();
end;
$$;

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
  actor := current_active_profile();

  payload_hash := md5(p_occurred_at::text || p_items::text);
  cached := check_idempotency(p_request_id, actor.user_id, 'register_receipt', payload_hash);
  if cached is not null then
    return cached;
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = '22023';
  end if;

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
    perform enqueue_recompute(v_product_id, false);

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

  -- occurred_at은 발주일(날짜)과 확정 시각(시:분:초, 한국시간)을 합친 값이다. 발주일만 쓰면
  -- 자정으로 고정되어, 같은 날 그보다 먼저 등록된 입고보다 이 발주가 시간순으로 앞서게
  -- 계산되어 대기량이 잘못 산출될 수 있다 (§8 사건 순서는 occurred_at로 정렬).
  insert into quantity_events (
    product_id, kind, qty_base, input_qty, input_unit, input_factor,
    occurred_at, supplier_id, recommendation_id, created_by
  ) values (
    p_product_id, 'order', v_qty_base, p_qty, p_unit, v_factor,
    (p_order_date + (now() at time zone 'Asia/Seoul')::time) at time zone 'Asia/Seoul',
    p_supplier_id, p_recommendation_id, actor.user_id
  ) returning id into event_id;

  if p_recommendation_id is not null then
    update recommendations set status = 'waiting', version = version + 1
      where id = p_recommendation_id;
  end if;

  perform recompute_product_state(p_product_id);
  perform enqueue_recompute(p_product_id, false);

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
  perform enqueue_recompute(p_product_id, false);

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

  perform enqueue_recompute(p_product_id, false);

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('quantity_event', event_id, actor.user_id, 'register_stock_count',
      jsonb_build_object('qty', p_qty, 'day_boundary', p_day_boundary));

  cached := jsonb_build_object('event_id', event_id);
  insert into request_receipts (request_id, actor_id, operation, payload_hash, result_json)
    values (p_request_id, actor.user_id, 'register_stock_count', payload_hash, cached);

  return cached;
end;
$$;

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

  perform enqueue_recompute(p_product_id, false);

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('product', p_product_id, actor.user_id, 'save_product_settings',
      jsonb_build_object('default_moq', p_default_moq, 'default_order_step', p_default_order_step));

  return jsonb_build_object('product_id', p_product_id, 'version', current_version + 1);
end;
$$;

create or replace function save_purchase_terms(
  p_product_id uuid,
  p_supplier_id uuid,
  p_moq_base numeric,
  p_step_base numeric,
  p_preferred boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
begin
  actor := require_admin();

  if p_moq_base is null or p_moq_base <= 0 then
    raise exception 'INVALID_MOQ' using errcode = '22023';
  end if;
  if p_step_base is null or p_step_base <= 0 then
    raise exception 'INVALID_ORDER_STEP' using errcode = '22023';
  end if;

  if p_preferred then
    update purchase_terms set preferred = false
      where product_id = p_product_id and supplier_id <> p_supplier_id;
  end if;

  insert into purchase_terms (product_id, supplier_id, moq_base, step_base, preferred, updated_at)
  values (p_product_id, p_supplier_id, p_moq_base, p_step_base, coalesce(p_preferred, false), now())
  on conflict (product_id, supplier_id) do update set
    moq_base = excluded.moq_base,
    step_base = excluded.step_base,
    preferred = excluded.preferred,
    updated_at = now();

  perform enqueue_recompute(p_product_id, false);

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('purchase_terms', p_product_id, actor.user_id, 'save_purchase_terms',
      jsonb_build_object('supplier_id', p_supplier_id, 'moq_base', p_moq_base, 'step_base', p_step_base));

  return jsonb_build_object('product_id', p_product_id, 'supplier_id', p_supplier_id);
end;
$$;

create or replace function set_supplier_closed_date(
  p_supplier_id uuid,
  p_closed_date date,
  p_reason text,
  p_remove boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  affected uuid;
begin
  actor := require_admin();

  if p_remove then
    delete from supplier_closed_dates where supplier_id = p_supplier_id and closed_date = p_closed_date;
  else
    insert into supplier_closed_dates (supplier_id, closed_date, reason)
    values (p_supplier_id, p_closed_date, p_reason)
    on conflict (supplier_id, closed_date) do update set reason = excluded.reason;
  end if;

  -- 이 거래처와 거래 조건이 있는 품목의 도착일·추천이 바뀔 수 있으므로 재계산을 예약한다.
  for affected in select product_id from purchase_terms where supplier_id = p_supplier_id loop
    perform enqueue_recompute(affected, false);
  end loop;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('supplier_closed_date', p_supplier_id, actor.user_id,
      case when p_remove then 'remove_closed_date' else 'add_closed_date' end,
      jsonb_build_object('closed_date', p_closed_date, 'reason', p_reason));

  return jsonb_build_object('supplier_id', p_supplier_id, 'closed_date', p_closed_date);
end;
$$;

grant execute on function enqueue_recompute(uuid, boolean) to authenticated;
