-- 시나리오 3(추천 버전 확인)·12(추천 없는 발주·추가 발주) 관련 confirm_order 갱신.
-- 시그니처에 p_expected_recommendation_version을 추가하므로 새 이름으로 만들고 구 오버로드는
-- 제거한다 (모호한 PostgREST 오버로드 방지).

drop function if exists confirm_order(uuid, uuid, uuid, uuid, numeric, text, date);

create or replace function confirm_order(
  p_request_id uuid,
  p_recommendation_id uuid,
  p_expected_recommendation_version bigint,
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
  sibling_rec_id uuid;
begin
  actor := require_admin();

  payload_hash := md5(
    coalesce(p_recommendation_id::text,'') || coalesce(p_expected_recommendation_version::text,'') ||
    p_product_id::text || coalesce(p_supplier_id::text,'') || p_qty::text || p_unit || p_order_date::text
  );
  cached := check_idempotency(p_request_id, actor.user_id, 'confirm_order', payload_hash);
  if cached is not null then
    return cached;
  end if;

  if p_qty is null or p_qty <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;
  if p_supplier_id is null then
    raise exception 'INVALID_SUPPLIER' using errcode = '22023';
  end if;
  if not exists (select 1 from suppliers where id = p_supplier_id and active) then
    raise exception 'SUPPLIER_NOT_FOUND' using errcode = '22023';
  end if;

  select factor_to_base into v_factor from product_units
    where product_id = p_product_id and unit_code = p_unit;
  if v_factor is null then
    raise exception 'UNKNOWN_UNIT' using errcode = '22023';
  end if;
  v_qty_base := p_qty * v_factor;

  perform 1 from products where id = p_product_id and active for update;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
  end if;

  if p_recommendation_id is not null then
    select * into rec from recommendations where id = p_recommendation_id for update;
    if rec.id is null then
      raise exception 'RECOMMENDATION_NOT_FOUND' using errcode = '22023';
    end if;
    if rec.product_id <> p_product_id then
      raise exception 'RECOMMENDATION_PRODUCT_MISMATCH' using errcode = '22023';
    end if;
    if rec.status <> 'review' then
      raise exception 'RECOMMENDATION_ALREADY_DECIDED' using errcode = '40001';
    end if;
    if rec.decision <> 'active' then
      raise exception 'RECOMMENDATION_NOT_ACTIVE' using errcode = '40001';
    end if;
    if p_expected_recommendation_version is null or rec.version <> p_expected_recommendation_version then
      raise exception 'VERSION_CONFLICT' using errcode = '40001';
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
  else
    -- 추천 없이(수동/추가) 주문했더라도, 같은 품목에 이미 열려 있는 활성 추천이 있다면
    -- 실제 주문과 모순되지 않도록 함께 대기 상태로 넘긴다. 근거(basis_json)는 바꾸지 않는다 —
    -- 계산 당시 근거는 그대로 이력에 남긴다.
    select id into sibling_rec_id from recommendations
      where product_id = p_product_id and status = 'review'
      for update skip locked;
    if sibling_rec_id is not null then
      update recommendations set status = 'waiting', version = version + 1
        where id = sibling_rec_id;
    end if;
  end if;

  perform recompute_product_state(p_product_id);
  perform enqueue_recompute(p_product_id, false);

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('quantity_event', event_id, actor.user_id, 'confirm_order',
      jsonb_build_object('qty_base', v_qty_base, 'supplier_id', p_supplier_id,
        'recommendation_id', p_recommendation_id, 'manual', p_recommendation_id is null));

  cached := jsonb_build_object(
    'order_event_id', event_id,
    'pending_qty', (select pending_qty from product_state where product_id = p_product_id)
  );
  insert into request_receipts (request_id, actor_id, operation, payload_hash, result_json)
    values (p_request_id, actor.user_id, 'confirm_order', payload_hash, cached);

  return cached;
end;
$$;

grant execute on function
  confirm_order(uuid, uuid, bigint, uuid, uuid, numeric, text, date)
to authenticated;
