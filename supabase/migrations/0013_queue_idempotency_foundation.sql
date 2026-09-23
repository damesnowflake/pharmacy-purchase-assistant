-- 사용_시나리오_검토.md 시나리오 1(추천 계산 큐)·2(요청 재시도 동시성)의 DB 기반 작업.
-- 새 마이그레이션으로만 적용하고 0001~0012는 수정하지 않는다.

-- ---------------------------------------------------------------------------
-- 시나리오 2: check_idempotency에 request_id 기준 트랜잭션 잠금을 추가한다.
-- 같은 request_id의 동시 호출은 먼저 온 트랜잭션이 커밋될 때까지 여기서 대기하므로,
-- "조회 시점엔 없었는데 둘 다 실제 쓰기까지 진행"하는 경쟁을 막는다. 서로 다른 request_id는
-- 다른 잠금 키를 가지므로 관계없는 요청끼리는 막지 않는다.
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
  perform pg_advisory_xact_lock(hashtext('request_receipts'), hashtext(p_request_id::text));

  select * into existing from public.request_receipts where request_id = p_request_id;
  if existing.request_id is not null then
    if existing.actor_id <> p_actor_id or existing.payload_hash <> p_payload_hash or existing.operation <> p_operation then
      raise exception 'REQUEST_CONFLICT' using errcode = '40001';
    end if;
    return existing.result_json;
  end if;
  return null;
end;
$$;

-- 호출자 소유의 특정 request_id 결과만 조회한다. 전체 요청 기록을 클라이언트에 공개하지 않는다.
create or replace function get_request_result(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  existing public.request_receipts;
begin
  actor := current_active_profile();
  select * into existing from public.request_receipts where request_id = p_request_id;
  if existing.request_id is null or existing.actor_id <> actor.user_id then
    return null;
  end if;
  return jsonb_build_object('operation', existing.operation, 'result', existing.result_json);
end;
$$;

grant execute on function get_request_result(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 시나리오 1: 품목별 계산 상태를 화면에 보여주기 위한 최소 필드.
-- calc_status: pending(대기)/running(계산중)/ready(계산 완료)/blocked(조건 확인 필요)/error(오류)
-- calc_reason: blocked/error일 때의 사유. holiday_missing/insufficient_history/moq_missing/
--   unit_missing/reference_missing 등. 실제 사입 불필요(ready, 추천 없음)와는 다르다.
-- ---------------------------------------------------------------------------
alter table product_state
  add column if not exists calc_status text not null default 'pending'
    check (calc_status in ('pending', 'running', 'ready', 'blocked', 'error')),
  add column if not exists calc_reason text,
  add column if not exists calc_input_revision bigint,
  add column if not exists calc_computed_at timestamptz;

-- 신규 등록 상품도 계산 상태 화면에 즉시 집계되도록 product_state 행을 함께 만든다.
create or replace function create_product(
  p_name text,
  p_spec text,
  p_base_unit text,
  p_allows_fraction boolean default false,
  p_observed_from date default null,
  p_aliases jsonb default '[]'::jsonb,
  p_default_moq numeric default null,
  p_default_order_step numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  new_id uuid;
  alias_item jsonb;
begin
  actor := current_active_profile();

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'INVALID_NAME' using errcode = '22023';
  end if;
  if p_base_unit is null or length(trim(p_base_unit)) = 0 then
    raise exception 'INVALID_BASE_UNIT' using errcode = '22023';
  end if;
  if (p_default_moq is not null or p_default_order_step is not null) and actor.role <> 'admin' then
    raise exception 'FORBIDDEN_ADMIN_ONLY_FOR_PURCHASE_SETTINGS' using errcode = '42501';
  end if;
  if p_default_moq is not null and p_default_moq <= 0 then
    raise exception 'INVALID_MOQ' using errcode = '22023';
  end if;
  if p_default_order_step is not null and p_default_order_step <= 0 then
    raise exception 'INVALID_ORDER_STEP' using errcode = '22023';
  end if;

  begin
    insert into products (name, spec, base_unit, allows_fraction, observed_from, default_moq, default_order_step, created_by)
    values (
      trim(p_name), coalesce(trim(p_spec), ''), trim(p_base_unit), coalesce(p_allows_fraction, false),
      coalesce(p_observed_from, (now() at time zone 'Asia/Seoul')::date),
      p_default_moq, p_default_order_step, actor.user_id
    )
    returning id into new_id;
  exception when unique_violation then
    raise exception 'DUPLICATE_PRODUCT: 이미 등록된 상품명·규격입니다 (%, %)', p_name, p_spec using errcode = '23505';
  end;

  insert into product_units (product_id, unit_code, factor_to_base)
  values (new_id, trim(p_base_unit), 1);

  insert into product_state (product_id, calc_status)
  values (new_id, 'pending')
  on conflict (product_id) do nothing;

  for alias_item in select * from jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) loop
    if length(trim(coalesce(alias_item->>'alias', ''))) > 0 then
      insert into product_aliases (product_id, source, source_code, alias, normalized_alias, spec)
      values (
        new_id,
        coalesce(alias_item->>'source', 'manual'),
        nullif(alias_item->>'source_code', ''),
        alias_item->>'alias',
        lower(regexp_replace(alias_item->>'alias', '\s+', '', 'g')),
        nullif(alias_item->>'spec', '')
      );
    end if;
  end loop;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('product', new_id, actor.user_id, 'create_product',
      jsonb_build_object('name', p_name, 'spec', p_spec, 'base_unit', p_base_unit));

  return jsonb_build_object('product_id', new_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- recompute_queue 원자적 선점: FOR UPDATE SKIP LOCKED로 동시 실행이 같은 품목을
-- 가져가지 않게 하고, lease_token으로 완료 처리 시 최신 선점자만 결과를 반영하게 한다.
-- ---------------------------------------------------------------------------
alter table recompute_queue
  add column if not exists lease_token uuid;

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
    where rq.status = 'pending'
       or (rq.status = 'processing' and rq.lease_until < now())
    order by rq.updated_at
    limit greatest(p_batch_size, 0)
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

-- lease_token이 일치하고 여전히 processing인 경우에만 반영한다. 리스가 만료돼 다른 실행이
-- 이미 다시 가져간 항목에는 늦게 도착한 이전 실행의 결과를 반영하지 않는다.
create or replace function finish_recompute_item(
  p_product_id uuid, p_lease_token uuid, p_status text, p_error text default null
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  updated_count int;
begin
  if p_status not in ('done', 'error') then
    raise exception 'INVALID_STATUS' using errcode = '22023';
  end if;
  update recompute_queue
    set status = p_status,
        last_error = p_error,
        attempts = case when p_status = 'error' then attempts + 1 else attempts end,
        updated_at = now(),
        lease_token = null
    where product_id = p_product_id and lease_token = p_lease_token and status = 'processing';
  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 공휴일 확보 시 holiday_missing으로 막혀 있던 품목을 다시 예약한다.
-- ---------------------------------------------------------------------------
create or replace function requeue_blocked_for_holiday()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected int;
begin
  with blocked as (
    select product_id from product_state
    where calc_status = 'blocked' and calc_reason = 'holiday_missing'
  )
  insert into recompute_queue (product_id, required_revision, need_training, status, updated_at)
  select product_id, 1, false, 'pending', now() from blocked
  on conflict (product_id) do update set
    required_revision = recompute_queue.required_revision + 1,
    status = case when recompute_queue.status = 'processing' then recompute_queue.status else 'pending' end,
    updated_at = now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function trigger_requeue_blocked_for_holiday()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('success', 'empty_confirmed') then
    perform requeue_blocked_for_holiday();
  end if;
  return new;
end;
$$;

drop trigger if exists holiday_sync_runs_requeue on holiday_sync_runs;
create trigger holiday_sync_runs_requeue
  after insert on holiday_sync_runs
  for each row execute function trigger_requeue_blocked_for_holiday();

-- ---------------------------------------------------------------------------
-- 한국 날짜가 바뀌면 도착일 계산이 달라질 수 있는 품목(열린 추천이 있거나 계산이 막혀 있던
-- 품목)을 다시 예약한다. 매일 KST 00:05에 실행한다.
-- ---------------------------------------------------------------------------
create or replace function requeue_for_new_business_day()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected int;
begin
  with targets as (
    select distinct product_id from (
      select product_id from recommendations where status <> 'received'
      union
      select product_id from product_state where calc_status in ('blocked', 'error')
    ) t
  )
  insert into recompute_queue (product_id, required_revision, need_training, status, updated_at)
  select product_id, 1, false, 'pending', now() from targets
  on conflict (product_id) do update set
    required_revision = recompute_queue.required_revision + 1,
    status = case when recompute_queue.status = 'processing' then recompute_queue.status else 'pending' end,
    updated_at = now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'daily-midnight-requeue-kst') then
      perform cron.schedule(
        'daily-midnight-requeue-kst',
        '0 15 * * *', -- UTC 15:00 = KST 00:00 (익일)
        $sql$select requeue_for_new_business_day();$sql$
      );
    end if;
  else
    raise notice 'pg_cron이 없어 daily-midnight-requeue 예약을 건너뜁니다.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 계산 상태 요약 (화면 표시용). 활성 계정 전원이 조회 가능(공유 업무 화면).
-- ---------------------------------------------------------------------------
create or replace function calc_status_summary()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  running_count int;
  blocked_count int;
  review_count int;
begin
  actor := current_active_profile();

  select count(*) into running_count
  from products p left join product_state ps on ps.product_id = p.id
  where p.active and coalesce(ps.calc_status, 'pending') in ('pending', 'running');

  select count(*) into blocked_count
  from products p join product_state ps on ps.product_id = p.id
  where p.active and ps.calc_status in ('blocked', 'error');

  select count(*) into review_count
  from recommendations where status = 'review' and decision = 'active';

  return jsonb_build_object(
    'calculating', running_count,
    'blocked', blocked_count,
    'review', review_count
  );
end;
$$;

grant execute on function
  claim_recompute_batch(int, int),
  finish_recompute_item(uuid, uuid, text, text),
  requeue_blocked_for_holiday(),
  requeue_for_new_business_day(),
  calc_status_summary(),
  create_product(text, text, text, boolean, date, jsonb, numeric, numeric)
to authenticated, service_role;
