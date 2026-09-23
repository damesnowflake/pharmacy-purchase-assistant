-- Backward-compatible RPC signatures. No business records are rewritten.
alter table recompute_queue drop constraint recompute_queue_status_check;
alter table recompute_queue add constraint recompute_queue_status_check
  check (status in ('pending','processing','done','error','blocked'));
alter table recompute_queue
  add column priority integer not null default 0,
  add column not_before timestamptz not null default now();

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
    if p_new_qty is null
      or (old_ev.kind = 'count' and p_new_qty < 0)
      or (old_ev.kind = 'stock_adjustment' and p_new_qty = 0)
      or (old_ev.kind in ('receipt','order','order_cancel') and p_new_qty <= 0) then
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
  remaining numeric;
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
  if not found then raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023'; end if;
  select coalesce(pending_qty,0) into remaining from product_state where product_id = p_product_id;
  if p_qty > coalesce(remaining,0) then
    raise exception 'INVALID_CANCEL_QUANTITY: cancellation exceeds pending quantity' using errcode = '22023';
  end if;

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

create or replace function enqueue_recompute(p_product_id uuid, p_need_training boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into recompute_queue (product_id, required_revision, need_training, status, priority, not_before)
  values (p_product_id, 1, p_need_training, 'pending', 100, now())
  on conflict (product_id) do update set
    required_revision = recompute_queue.required_revision + 1,
    need_training = recompute_queue.need_training or excluded.need_training,
    status = case when recompute_queue.status = 'processing' then recompute_queue.status else 'pending' end,
    priority = 100, not_before = now(),
    updated_at = now();
end;
$$;

create or replace function claim_recompute_batch(p_batch_size int default 20, p_lease_seconds int default 300)
returns table (product_id uuid, required_revision bigint, need_training boolean, attempts int, lease_token uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease_until timestamptz := now() + make_interval(secs => p_lease_seconds);
begin
  return query
  with candidates as (
    select rq.product_id as p_id
    from recompute_queue rq
    where (rq.status = 'pending' and rq.not_before <= now())
       or (rq.status = 'processing' and rq.lease_until < now())
    order by rq.priority desc, rq.updated_at
    limit least(greatest(p_batch_size, 0),100)
    for update skip locked
  ),
  claimed as (
    update recompute_queue rq
    set status = 'processing',
        lease_until = v_lease_until,
        lease_token = gen_random_uuid()
    from candidates c
    where rq.product_id = c.p_id
    returning rq.product_id, rq.required_revision, rq.need_training, rq.attempts, rq.lease_token
  )
  select * from claimed;
end;
$$;

create or replace function finish_recompute_item(
  p_product_id uuid, p_lease_token uuid, p_required_revision bigint,
  p_status text, p_result jsonb default '{}'::jsonb, p_error text default null
) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  job public.recompute_queue;
  model jsonb := p_result->'model';
  anchor jsonb := p_result->'anchor';
  recommendation jsonb := p_result->'recommendation';
  rec public.recommendations;
begin
  if p_status not in ('done', 'blocked', 'error') or p_status is null then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;
  -- Business RPCs lock product then queue; use the same order to avoid deadlocks.
  perform 1 from products where id = p_product_id for update;
  select * into job from recompute_queue where product_id = p_product_id for update;
  if not found or job.status <> 'processing' or p_lease_token is null
      or job.lease_token is distinct from p_lease_token then
    return 'stale';
  end if;
  if job.required_revision is distinct from p_required_revision
      or job.lease_until is null or job.lease_until <= clock_timestamp() then
    update recompute_queue set status = 'pending', lease_token = null, lease_until = null,
      updated_at = now() where product_id = p_product_id;
    return 'pending';
  end if;

  -- Validate before ALL writes, including model/anchor; stale workers publish nothing.
  if p_status <> 'error' then
    if model is not null and model <> 'null'::jsonb then
      insert into forecast_models (product_id, model_version, training_start, training_end,
        n_observed, n_missing, coefficients, warning_codes, input_revision, computed_at)
      values (p_product_id, model->>'model_version', (model->>'training_start')::date,
        (model->>'training_end')::date, (model->>'n_observed')::int, (model->>'n_missing')::int,
        model->'coefficients', array(select jsonb_array_elements_text(model->'warning_codes')),
        p_required_revision, now())
      on conflict (product_id) do update set model_version = excluded.model_version,
        training_start = excluded.training_start, training_end = excluded.training_end,
        n_observed = excluded.n_observed, n_missing = excluded.n_missing,
        coefficients = excluded.coefficients, warning_codes = excluded.warning_codes,
        input_revision = excluded.input_revision, computed_at = excluded.computed_at;
    end if;
    if anchor is not null and anchor <> 'null'::jsonb then
      insert into inventory_anchors (product_id, kind, anchor_date, sales_start_date,
        qty_base, sales_before_start, estimated_first_day_sales, model_version, revision, updated_at)
      values (p_product_id, anchor->>'kind', (anchor->>'anchor_date')::date,
        (anchor->>'anchor_date')::date, (anchor->>'qty_base')::numeric, 0,
        (anchor->>'estimated_first_day_sales')::numeric, model->>'model_version', 1, now())
      on conflict (product_id) do update set kind = excluded.kind, anchor_date = excluded.anchor_date,
        sales_start_date = excluded.sales_start_date, qty_base = excluded.qty_base,
        sales_before_start = excluded.sales_before_start,
        estimated_first_day_sales = excluded.estimated_first_day_sales,
        model_version = excluded.model_version, revision = inventory_anchors.revision + 1,
        updated_at = now();
    end if;
    if p_status = 'done' then
      select * into rec from recommendations
        where product_id = p_product_id and status <> 'received' for update;
      if recommendation is not null and recommendation <> 'null'::jsonb then
        -- A manual order may have no recommendation. Never create a duplicate review for it.
        if coalesce((select pending_qty from product_state where product_id = p_product_id), 0) = 0 then
          if rec.id is null then
            insert into recommendations (product_id, arrival_date, recommended_qty, basis_json, input_revision)
            values (p_product_id, (recommendation->>'arrival_date')::date,
              (recommendation->>'recommended_qty')::numeric, recommendation->'basis_json', p_required_revision);
          elsif rec.status = 'review' then
            update recommendations set arrival_date = (recommendation->>'arrival_date')::date,
              recommended_qty = (recommendation->>'recommended_qty')::numeric,
              basis_json = recommendation->'basis_json', input_revision = p_required_revision,
              version = version + 1 where id = rec.id;
          end if;
        end if;
      elsif rec.status = 'review' then
        update recommendations set status = 'received', closed_at = now(), closed_reason = 'not_needed',
          version = version + 1 where id = rec.id;
      end if;
    end if;
  end if;
  insert into product_state (product_id, calc_status, calc_reason, calc_input_revision, calc_computed_at)
  values (p_product_id, case p_status when 'done' then 'ready' when 'blocked' then 'blocked' else 'error' end,
    case when p_status = 'error' then p_error else p_result->>'calc_reason' end, p_required_revision, now())
  on conflict (product_id) do update set calc_status = excluded.calc_status,
    calc_reason = excluded.calc_reason, calc_input_revision = excluded.calc_input_revision,
    calc_computed_at = excluded.calc_computed_at;
  -- Missing dependencies sleep until changed input. Transient failures retry with bounded backoff.
  update recompute_queue set status = case when p_status = 'done' then 'done' when p_status = 'blocked' then 'blocked' else 'pending' end,
    lease_token = null, lease_until = null, last_error = p_error, priority = 0,
    not_before = case when p_status = 'error' then now() + make_interval(secs => least(3600, 60 * power(2, least(attempts,6))::int)) else now() end,
    attempts = case when p_status = 'error' then attempts + 1 else attempts end,
    need_training = case when p_status = 'done' then false else need_training end,
    updated_at = now() where product_id = p_product_id;
  return p_status;
end;
$$;

create or replace function commit_sales_import(
  p_import_id uuid,
  p_expected_row_count bigint
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  imp public.sales_imports;
  staged_count bigint;
  valid_count bigint;
  invalid_valid_count bigint;
  skipped_count bigint;
  affected_product_ids uuid[];
  prior_products uuid[];
  current_watermark bigint;
  d date;
begin
  actor := current_active_profile();

  select * into imp from sales_imports where id = p_import_id for update;
  if imp.id is null then
    raise exception 'IMPORT_NOT_FOUND' using errcode = '22023';
  end if;
  if imp.actor_id <> actor.user_id then
    raise exception 'FORBIDDEN_NOT_OWNER' using errcode = '42501';
  end if;

  -- 확정 응답이 유실된 뒤 재시도해도, 이미 이 import_id로 반영이 끝났다면 그때 저장해 둔
  -- 요약을 그대로 돌려준다 (같은 import를 다시 계산하거나 오류로 보지 않는다).
  if imp.status = 'applied' then
    return jsonb_build_object(
      'import_id', imp.id,
      'applied_rows', imp.applied_rows,
      'skipped_rows', imp.skipped_rows,
      'affected_products', imp.affected_products
    );
  end if;
  if imp.status <> 'staging' then
    raise exception 'IMPORT_NOT_STAGING' using errcode = '40001';
  end if;

  select count(*) into staged_count from sales_import_rows where import_id = p_import_id;
  if p_expected_row_count is not null and staged_count <> p_expected_row_count then
    raise exception 'ROW_COUNT_MISMATCH: staged=% expected=%', staged_count, p_expected_row_count
      using errcode = '40001';
  end if;
  if staged_count = 0 then
    raise exception 'EMPTY_IMPORT' using errcode = '22023';
  end if;

  -- 서버도 미해결·미연결 행을 신뢰하지 않는다: 클라이언트가 "반영 대상"으로 올린 행에
  -- 품목·날짜가 없으면(정상 화면 흐름에서는 나올 수 없는 상태) 조용히 건너뛰지 않고 거부한다.
  select count(*) into invalid_valid_count from sales_import_rows
    where import_id = p_import_id and error_code is null
      and (product_id is null or sale_date is null or sale_date < imp.period_start or sale_date > imp.period_end);
  if invalid_valid_count > 0 then
    raise exception 'INVALID_STAGED_ROWS: 반영 대상 행 중 품목·날짜가 없거나 범위를 벗어난 행이 %건 있습니다', invalid_valid_count
      using errcode = '22023';
  end if;

  select count(*) into valid_count from sales_import_rows
    where import_id = p_import_id and error_code is null and product_id is not null and sale_date is not null;
  skipped_count := staged_count - valid_count;
  if valid_count = 0 then
    raise exception 'NO_VALID_ROWS' using errcode = '22023';
  end if;

  -- 이 규모(직원 5명, 업로드 하루 1회)에서는 겹치지 않는 기간까지 정교하게 구분해 잠글 필요가
  -- 없다. 판매 확정 전체를 단일 키로 직렬화해 동시 확정 자체를 막는다.
  perform pg_advisory_xact_lock(hashtext('sales_import_commit'));

  -- 업로드를 준비하던 사이 다른 직원이 겹치는 기간을 먼저 반영했으면 알린다.
  select coalesce(max(revision), 0) into current_watermark
    from sales_coverage where sale_date between imp.period_start and imp.period_end;
  if current_watermark <> imp.coverage_watermark then
    raise exception 'CONCURRENT_MODIFICATION: 이 기간을 다른 직원이 먼저 반영했습니다. 최신 상태를 확인한 뒤 다시 시도하세요.'
      using errcode = '40001';
  end if;

  -- 재업로드에서 사라진 품목도 재계산 대상에 포함하기 위해, 교체되기 전 이 기간에 이미
  -- 있던 품목 집합을 먼저 확보한다.
  select array_agg(distinct product_id) into prior_products
    from sales_daily where sale_date between imp.period_start and imp.period_end;

  delete from sales_daily where sale_date between imp.period_start and imp.period_end;

  insert into sales_daily (product_id, sale_date, net_qty, import_id, revision)
  select product_id, sale_date, sum(net_qty), p_import_id, 1
  from sales_import_rows
  where import_id = p_import_id and error_code is null and product_id is not null and sale_date is not null
  group by product_id, sale_date;

  select array_agg(distinct product_id) into affected_product_ids
  from sales_import_rows
  where import_id = p_import_id and error_code is null and product_id is not null;

  affected_product_ids := (
    select array_agg(distinct pid) from unnest(coalesce(affected_product_ids, '{}') || coalesce(prior_products, '{}')) as pid
  );

  for d in select generate_series(imp.period_start, imp.period_end, interval '1 day')::date loop
    insert into sales_coverage (sale_date, import_id, revision, status)
    values (d, p_import_id, 1, 'complete')
    on conflict (sale_date) do update set
      import_id = excluded.import_id,
      revision = sales_coverage.revision + 1,
      status = 'complete';
  end loop;

  update sales_imports set
    status = 'applied', applied_rows = valid_count, skipped_rows = skipped_count,
    affected_products = coalesce(array_length(affected_product_ids, 1), 0)
  where id = p_import_id;

  update sales_imports set status = 'superseded'
    where id <> p_import_id
      and status = 'applied'
      and period_start <= imp.period_end and period_end >= imp.period_start;

  if affected_product_ids is not null then
    perform enqueue_recompute(pid, true) from unnest(affected_product_ids) as affected(pid);
  end if;

  -- More complete calendar coverage can make an all-zero series trainable too.
  -- Such a product need not occur in the uploaded rows, so wake it explicitly.
  perform enqueue_recompute(s.product_id, true) from product_state s
    join products p on p.id=s.product_id
    where p.active and s.calc_status='blocked' and s.calc_reason='insufficient_history'
      and not (s.product_id = any(coalesce(affected_product_ids, '{}'::uuid[])));

  delete from sales_import_rows where import_id = p_import_id;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('sales_import', p_import_id, actor.user_id, 'commit_sales_import',
      jsonb_build_object('applied_rows', valid_count, 'skipped_rows', skipped_count,
        'period_start', imp.period_start, 'period_end', imp.period_end));

  return jsonb_build_object(
    'import_id', p_import_id,
    'applied_rows', valid_count,
    'skipped_rows', skipped_count,
    'affected_products', coalesce(array_length(affected_product_ids, 1), 0)
  );
end;
$$;

create or replace function requeue_for_new_business_day()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare affected int;
begin
  -- A new day changes demand/arrival, but cannot create a missing receipt, MOQ or unit.
  insert into recompute_queue(product_id,required_revision,need_training,status,priority,not_before)
  select p.id,1,true,'pending',0,now()
  from products p join product_state ps on ps.product_id=p.id
  where p.active and ps.calc_status in ('ready','error')
  on conflict (product_id) do update set
    required_revision=recompute_queue.required_revision+1, need_training=true,
    status=case when recompute_queue.status='processing' then 'processing' else 'pending' end,
    not_before=now(), updated_at=now();
  get diagnostics affected = row_count;
  return affected;
end $$;

create or replace function requeue_blocked_for_holiday()
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid; affected int:=0;
begin
  for pid in select product_id from product_state
    where calc_status='blocked' and calc_reason='holiday_missing'
  loop
    perform enqueue_recompute(pid,false);
    affected:=affected+1;
  end loop;
  return affected;
end $$;

create or replace function calc_status_summary()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor public.profiles;
begin
  actor:=current_active_profile();
  return jsonb_build_object(
    'calculating',(select count(*) from recompute_queue q join products p on p.id=q.product_id
      where p.active and q.status in ('pending','processing')),
    'blocked',(select count(*) from product_state s join products p on p.id=s.product_id
      left join recompute_queue q on q.product_id=s.product_id
      where p.active and s.calc_status in ('blocked','error') and coalesce(q.status,'blocked') not in ('pending','processing')),
    'review',(select count(*) from recommendations where status='review' and decision='active'),
    'missing_reference',(select count(*) from products p where p.active and not exists
      (select 1 from quantity_events e where e.product_id=p.id and e.active and e.kind in ('receipt','count'))),
    'missing_moq',(select count(*) from products where active and default_moq is null),
    'missing_order_step',(select count(*) from products where active and default_order_step is null));
end $$;

-- Sleep ONLY unchanged blocked results, not new input that arrived after the calculation.
update recompute_queue q set status='blocked',lease_token=null,lease_until=null,priority=0
from product_state s where s.product_id=q.product_id and q.status='pending'
  and s.calc_status='blocked' and s.calc_input_revision=q.required_revision;

-- Add each table independently; an existing table must not skip the remaining additions.
do $$
declare target text;
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach target in array array['recommendations','product_state','sales_coverage','quantity_events',
      'products','product_aliases','product_units','suppliers','purchase_terms','supplier_closed_dates']
    loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
        and schemaname='public' and tablename=target) then
        execute format('alter publication supabase_realtime add table public.%I',target);
      end if;
    end loop;
  end if;
end $$;

revoke all on function claim_recompute_batch(int,int),
  finish_recompute_item(uuid,uuid,bigint,text,jsonb,text),enqueue_recompute(uuid,boolean),
  requeue_for_new_business_day(),requeue_blocked_for_holiday() from public,anon,authenticated;
grant execute on function claim_recompute_batch(int,int),
  finish_recompute_item(uuid,uuid,bigint,text,jsonb,text),enqueue_recompute(uuid,boolean),
  requeue_for_new_business_day(),requeue_blocked_for_holiday() to service_role;
