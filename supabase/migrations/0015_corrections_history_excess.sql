-- 시나리오 9(정정)·10(입고·발주 이력)·11(초과량 투영) 관련 스키마·RPC.

-- ---------------------------------------------------------------------------
-- 시나리오 11: 감사 로그가 아니라 quantity_events 자체에 "현재" 초과량을 둔다.
-- 재계산할 때마다 덮어써서, 정정으로 초과가 해소되면 0으로, 재계산을 여러 번 해도 값이
-- 늘어나지 않는다. 실제 변경 이력은 값이 바뀔 때만 audit_events에 남긴다.
-- ---------------------------------------------------------------------------
alter table quantity_events
  add column if not exists excess_qty_base numeric(14,3) not null default 0,
  add column if not exists revises_event_id uuid references quantity_events(id);

-- ---------------------------------------------------------------------------
-- 시나리오 10: 추천 종결 이유. 물류 상태(status)와 별개로 이력 화면에만 노출한다.
-- ---------------------------------------------------------------------------
alter table recommendations
  add column if not exists closed_reason text
    check (closed_reason in ('received', 'cancelled', 'not_needed'));

-- ---------------------------------------------------------------------------
-- recompute_product_state 재정의: 초과량은 투영 컬럼에 덮어쓰고, 종결 이유를 함께 판정한다.
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
  last_zero_kind text := null;
  actor_id_for_audit uuid;
begin
  for ev in
    select id, kind, qty_base, occurred_at, recorded_seq, excess_qty_base, created_by
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
      if ev.excess_qty_base is distinct from extra then
        update quantity_events set excess_qty_base = extra where id = ev.id;
        insert into audit_events (entity_type, entity_id, actor_id, action, before, after)
          values ('quantity_event', ev.id, ev.created_by, 'excess_recomputed',
            jsonb_build_object('excess_qty_base', ev.excess_qty_base),
            jsonb_build_object('excess_qty_base', extra));
      end if;
      if pending = 0 then last_zero_kind := 'receipt'; end if;
    elsif ev.kind = 'order_cancel' then
      applied := least(pending, ev.qty_base);
      pending := pending - applied;
      if pending = 0 then last_zero_kind := 'order_cancel'; end if;
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

  -- 대기량이 0이 된 진행 중 추천을 닫는다. 마지막으로 0을 만든 사건이 입고였는지 취소였는지로
  -- 종결 이유를 구분한다(FR-30, 시나리오 10).
  update recommendations
    set status = 'received', closed_at = now(),
      closed_reason = case when last_zero_kind = 'order_cancel' then 'cancelled' else 'received' end
    where product_id = p_product_id and status = 'waiting' and pending = 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 시나리오 9: 원천 사건 정정. 수량·단위·발생일시 수정 또는 오입력 무효화만 다룬다.
-- 입고·실사는 직원·관리자, 발주(order/order_cancel)는 관리자만 수정할 수 있다 — 이 권한은
-- 화면뿐 아니라 여기 서버에서도 검사한다.
-- ---------------------------------------------------------------------------
create or replace function revise_quantity_event(
  p_request_id uuid,
  p_event_id uuid,
  p_expected_version bigint,
  p_void boolean,
  p_new_qty numeric default null,
  p_new_unit text default null,
  p_new_occurred_at timestamptz default null,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  payload_hash text;
  cached jsonb;
  old_ev public.quantity_events;
  v_factor numeric(14,6);
  v_qty_base numeric(14,3);
  v_allows_fraction boolean;
  new_id uuid;
begin
  actor := current_active_profile();

  payload_hash := md5(
    p_event_id::text || coalesce(p_expected_version::text,'') || p_void::text ||
    coalesce(p_new_qty::text,'') || coalesce(p_new_unit,'') || coalesce(p_new_occurred_at::text,'') ||
    coalesce(p_reason,'')
  );
  cached := check_idempotency(p_request_id, actor.user_id, 'revise_quantity_event', payload_hash);
  if cached is not null then
    return cached;
  end if;

  select * into old_ev from quantity_events where id = p_event_id for update;
  if old_ev.id is null then
    raise exception 'EVENT_NOT_FOUND' using errcode = '22023';
  end if;
  if not old_ev.active then
    raise exception 'EVENT_ALREADY_VOIDED' using errcode = '40001';
  end if;
  if old_ev.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;

  if old_ev.kind in ('order', 'order_cancel') then
    actor := require_admin();
  end if;

  perform 1 from products where id = old_ev.product_id for update;

  if p_void then
    update quantity_events set active = false, version = version + 1 where id = p_event_id;
    insert into audit_events (entity_type, entity_id, actor_id, action, before, after)
      values ('quantity_event', p_event_id, actor.user_id, 'void_quantity_event',
        to_jsonb(old_ev), jsonb_build_object('reason', p_reason));
    new_id := null;
  else
    if p_new_qty is null or p_new_qty <= 0 then
      raise exception 'INVALID_QUANTITY' using errcode = '22023';
    end if;
    if p_new_occurred_at is null then
      raise exception 'INVALID_OCCURRED_AT' using errcode = '22023';
    end if;

    if old_ev.kind = 'count' then
      v_factor := 1;
      v_qty_base := p_new_qty;
    else
      select factor_to_base into v_factor from product_units
        where product_id = old_ev.product_id and unit_code = coalesce(p_new_unit, old_ev.input_unit);
      if v_factor is null then
        raise exception 'UNKNOWN_UNIT' using errcode = '22023';
      end if;
      select allows_fraction into v_allows_fraction from products where id = old_ev.product_id;
      v_qty_base := p_new_qty * v_factor;
      if not v_allows_fraction and v_qty_base <> trunc(v_qty_base) then
        raise exception 'FRACTION_NOT_ALLOWED' using errcode = '22023';
      end if;
    end if;

    update quantity_events set active = false, version = version + 1 where id = p_event_id;

    insert into quantity_events (
      batch_id, product_id, kind, qty_base, input_qty, input_unit, input_factor,
      occurred_at, recorded_seq, supplier_id, recommendation_id, day_boundary, active, version,
      created_by, revises_event_id
    ) values (
      old_ev.batch_id, old_ev.product_id, old_ev.kind, v_qty_base, p_new_qty,
      coalesce(p_new_unit, old_ev.input_unit), v_factor,
      p_new_occurred_at, default, old_ev.supplier_id, old_ev.recommendation_id, old_ev.day_boundary,
      true, 1, actor.user_id, old_ev.id
    ) returning id into new_id;

    insert into audit_events (entity_type, entity_id, actor_id, action, before, after)
      values ('quantity_event', p_event_id, actor.user_id, 'revise_quantity_event',
        to_jsonb(old_ev),
        jsonb_build_object('new_event_id', new_id, 'qty_base', v_qty_base, 'occurred_at', p_new_occurred_at, 'reason', p_reason));
  end if;

  perform recompute_product_state(old_ev.product_id);
  perform enqueue_recompute(old_ev.product_id, old_ev.kind in ('count'));

  cached := jsonb_build_object(
    'old_event_id', p_event_id,
    'new_event_id', new_id,
    'pending_qty', (select pending_qty from product_state where product_id = old_ev.product_id)
  );
  insert into request_receipts (request_id, actor_id, operation, payload_hash, result_json)
    values (p_request_id, actor.user_id, 'revise_quantity_event', payload_hash, cached);

  return cached;
end;
$$;

-- ---------------------------------------------------------------------------
-- 시나리오 10: 이력 조회. 추천 ID 없는 사건(수동 입고·수동 발주)도 포함하고, 상품·담당자
-- 표시 이름을 함께 반환한다. 검색·기간·페이지는 클라이언트에서 인자로 넘긴다.
-- ---------------------------------------------------------------------------
create or replace function list_movement_history(
  p_search text default '',
  p_from date default null,
  p_to date default null,
  p_kind quantity_event_kind default null,
  p_limit int default 50,
  p_offset int default 0
) returns table (
  event_id uuid,
  product_id uuid,
  product_name text,
  product_spec text,
  base_unit text,
  kind quantity_event_kind,
  occurred_at timestamptz,
  input_qty numeric,
  input_unit text,
  qty_base numeric,
  excess_qty_base numeric,
  supplier_id uuid,
  supplier_name text,
  recommendation_id uuid,
  closed_reason text,
  active boolean,
  revises_event_id uuid,
  created_by uuid,
  created_by_name text,
  version bigint,
  total_count bigint
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  normalized text := lower(regexp_replace(coalesce(p_search, ''), '\s+', '', 'g'));
begin
  actor := current_active_profile();

  return query
  with base as (
    select
      qe.id as event_id, qe.product_id, p.name as product_name, p.spec as product_spec,
      p.base_unit, qe.kind, qe.occurred_at, qe.input_qty, qe.input_unit, qe.qty_base,
      qe.excess_qty_base, qe.supplier_id, s.name as supplier_name, qe.recommendation_id,
      r.closed_reason, qe.active, qe.revises_event_id, qe.created_by, pr.display_name as created_by_name,
      qe.version
    from quantity_events qe
    join products p on p.id = qe.product_id
    left join suppliers s on s.id = qe.supplier_id
    left join recommendations r on r.id = qe.recommendation_id
    left join profiles pr on pr.user_id = qe.created_by
    where (p_kind is null or qe.kind = p_kind)
      and (p_from is null or qe.occurred_at >= p_from::timestamptz)
      and (p_to is null or qe.occurred_at < (p_to + 1)::timestamptz)
      and (
        normalized = '' or
        lower(regexp_replace(p.name || coalesce(p.spec, ''), '\s+', '', 'g')) like '%' || normalized || '%'
      )
  )
  select b.*, count(*) over() as total_count
  from base b
  order by b.occurred_at desc
  limit greatest(p_limit, 0) offset greatest(p_offset, 0);
end;
$$;

-- 초과 입고 현재 투영값 (시나리오 11). 관리자만 조회.
create or replace function list_excess_receipts()
returns table (
  event_id uuid,
  product_id uuid,
  product_name text,
  product_spec text,
  base_unit text,
  occurred_at timestamptz,
  input_qty numeric,
  excess_qty_base numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform require_admin();
  return query
  select qe.id, qe.product_id, p.name, p.spec, p.base_unit, qe.occurred_at, qe.input_qty, qe.excess_qty_base
  from quantity_events qe
  join products p on p.id = qe.product_id
  where qe.kind = 'receipt' and qe.active and qe.excess_qty_base > 0
  order by qe.occurred_at desc;
end;
$$;

-- 시나리오 10 item 5: 담당자 표시용 최소 정보만 (profiles 전체 공개 금지).
create or replace function list_active_staff()
returns table (user_id uuid, display_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform current_active_profile();
  return query select p.user_id, p.display_name from profiles p where p.active order by p.display_name;
end;
$$;

grant execute on function
  revise_quantity_event(uuid, uuid, bigint, boolean, numeric, text, timestamptz, text),
  list_movement_history(text, date, date, quantity_event_kind, int, int),
  list_excess_receipts(),
  list_active_staff()
to authenticated;
