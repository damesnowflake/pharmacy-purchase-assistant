-- Review fixes: server-only queues, revision-fenced publication and correction reopening.
-- Deploy together with forecast-batch and the version-aware ReviewPage.

drop function if exists finish_recompute_item(uuid, uuid, text, text);

create function finish_recompute_item(
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
  -- Missing dependencies and transient errors stay retryable; updated_at gives other jobs a turn.
  update recompute_queue set status = case when p_status = 'done' then 'done' else 'pending' end,
    lease_token = null, lease_until = null, last_error = p_error,
    attempts = case when p_status = 'error' then attempts + 1 else attempts end,
    need_training = case when p_status = 'done' then false else need_training end,
    updated_at = now() where product_id = p_product_id;
  return p_status;
end;
$$;

-- Keep the original replay, then reconcile reopening under the same product lock.
-- Receipts still consume product-level pending quantities, never individual order IDs.
alter function recompute_product_state(uuid) rename to replay_product_state_before_reopen;
create function recompute_product_state(p_product_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  pending numeric := 0;
  ev record;
  reopen_id uuid;
  open_rec public.recommendations;
begin
  perform 1 from products where id = p_product_id for update;
  perform replay_product_state_before_reopen(p_product_id);
  if coalesce((select pending_qty from product_state where product_id = p_product_id), 0) = 0 then
    return;
  end if;
  -- Select an order-linked recommendation from the currently unsettled cycle only.
  for ev in select kind, qty_base, recommendation_id from quantity_events
    where product_id = p_product_id and active order by occurred_at, recorded_seq
  loop
    if ev.kind = 'order' then
      pending := pending + ev.qty_base;
      if ev.recommendation_id is not null then reopen_id := ev.recommendation_id; end if;
    elsif ev.kind in ('receipt', 'order_cancel') then
      pending := greatest(0, pending - ev.qty_base);
    end if;
    if pending = 0 then reopen_id := null; end if;
  end loop;
  select * into open_rec from recommendations
    where product_id = p_product_id and status <> 'received' for update;
  if open_rec.status = 'waiting' then return; end if;
  if reopen_id is not null and exists (
    select 1 from recommendations where id = reopen_id and product_id = p_product_id
  ) then
    -- A newer unplaced review must not prevent the actual outstanding order from reopening.
    if open_rec.id is not null and open_rec.id <> reopen_id then
      update recommendations set status = 'received', closed_reason = 'not_needed',
        closed_at = now(), version = version + 1 where id = open_rec.id;
    end if;
    update recommendations set status = 'waiting', closed_at = null, closed_reason = null,
      version = version + 1 where id = reopen_id and status <> 'waiting';
  elsif open_rec.status = 'review' then
    update recommendations set status = 'waiting', closed_at = null, closed_reason = null,
      version = version + 1 where id = open_rec.id;
  end if;
end;
$$;

-- New PostgreSQL functions otherwise inherit PUBLIC execute. All queue/replay writers
-- are internal: authenticated users can only invoke validated business RPCs.
revoke all on function claim_recompute_batch(int, int),
  finish_recompute_item(uuid, uuid, bigint, text, jsonb, text),
  requeue_blocked_for_holiday(), requeue_for_new_business_day(),
  enqueue_recompute(uuid, boolean), recompute_product_state(uuid),
  replay_product_state_before_reopen(uuid)
from public, anon, authenticated;
grant execute on function claim_recompute_batch(int, int),
  finish_recompute_item(uuid, uuid, bigint, text, jsonb, text),
  requeue_blocked_for_holiday(), requeue_for_new_business_day(),
  enqueue_recompute(uuid, boolean), recompute_product_state(uuid),
  replay_product_state_before_reopen(uuid)
to service_role;

-- Recover jobs previously marked done without holiday coverage or by the legacy worker.
insert into recompute_queue (product_id, required_revision, need_training, status)
select id, 1, true, 'pending' from products where active
on conflict (product_id) do update set required_revision = recompute_queue.required_revision + 1,
  need_training = true, status = 'pending', lease_token = null, lease_until = null, updated_at = now();
