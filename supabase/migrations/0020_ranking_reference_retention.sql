-- Daily rows serve forecasting (180 days). Reference archives serve stock subtraction
-- for the current count / last receipt, independently of the forecasting window.
create table reference_sales_archives (
  product_id uuid not null references products(id) on delete cascade,
  start_date date not null,
  retired_before date not null,
  net_qty numeric(18,3) not null default 0,
  missing_days integer not null default 0,
  history_unavailable boolean not null default false,
  primary key (product_id, start_date)
);
alter table reference_sales_archives enable row level security;
revoke all on reference_sales_archives from public, anon, authenticated;

-- Exclusive boundary. Legacy rollups also used an exclusive cutoff despite their name.
create table sales_retention_boundary (
  singleton boolean primary key default true check(singleton),
  retired_before date not null
);
alter table sales_retention_boundary enable row level security;
revoke all on sales_retention_boundary from public, anon, authenticated;
insert into sales_retention_boundary
select true, max(retired_through) from sales_rollups having max(retired_through) is not null;

create function reference_sales_total(p_product_id uuid, p_start date, p_end date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  boundary date; a reference_sales_archives; from_day date := p_start;
  qty numeric := 0; missing integer := 0; unavailable boolean := false;
begin
  if p_start is null or p_end is null then raise exception 'INVALID_REFERENCE_RANGE'; end if;
  if p_end < p_start then return jsonb_build_object('net_qty',0,'missing_days',0,'history_unavailable',false); end if;
  select retired_before into boundary from sales_retention_boundary;
  if boundary is not null and p_start < boundary then
    select * into a from reference_sales_archives where product_id=p_product_id and start_date=p_start;
    if a.product_id is null or a.retired_before <> boundary or p_end < boundary - 1 then
      unavailable := true;
    else
      qty := a.net_qty; missing := a.missing_days; unavailable := a.history_unavailable;
    end if;
    from_day := boundary;
  end if;
  select qty + coalesce(sum(net_qty),0) into qty from sales_daily
    where product_id=p_product_id and sale_date between from_day and p_end;
  select missing + count(*) into missing from generate_series(from_day,p_end,interval '1 day') d
    where not exists(select 1 from sales_coverage c where c.sale_date=d::date and c.status='complete');
  return jsonb_build_object('net_qty',qty,'missing_days',missing,'history_unavailable',unavailable);
end $$;
revoke all on function reference_sales_total(uuid,date,date) from public, anon, authenticated;
grant execute on function reference_sales_total(uuid,date,date) to service_role;

create or replace function rollup_old_sales_daily(p_retention_days int default 180)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cutoff date := (now() at time zone 'Asia/Seoul')::date - p_retention_days + 1;
  boundary date; r record; totals jsonb; rolled_rows bigint; rolled_products bigint;
begin
  if p_retention_days < 180 then raise exception 'RETENTION_MUST_COVER_FORECAST'; end if;
  -- Same lock as import commit: replacement and archival must never overlap.
  perform pg_advisory_xact_lock(hashtext('sales_import_commit'));
  -- Prevent concurrent receipt/count edits while collecting the two current anchors.
  lock table quantity_events in share mode;
  select retired_before into boundary from sales_retention_boundary;
  if boundary is not null and cutoff <= boundary then
    return jsonb_build_object('cutoff',boundary,'rolled_products',0,'rolled_rows',0);
  end if;
  for r in
    select distinct product_id, start_date from (
      select distinct on(product_id,kind) product_id, kind,
        (occurred_at at time zone 'Asia/Seoul')::date + case when kind='count' then 1 else 0 end as start_date
      from quantity_events where active and kind in ('count','receipt')
      order by product_id,kind,occurred_at desc,recorded_seq desc
    ) anchors where start_date < cutoff
  loop
    totals := reference_sales_total(r.product_id,r.start_date,cutoff-1);
    insert into reference_sales_archives(product_id,start_date,retired_before,net_qty,missing_days,history_unavailable)
    values(r.product_id,r.start_date,cutoff,(totals->>'net_qty')::numeric,
      (totals->>'missing_days')::integer,(totals->>'history_unavailable')::boolean)
    on conflict(product_id,start_date) do update set retired_before=excluded.retired_before,
      net_qty=excluded.net_qty,missing_days=excluded.missing_days,history_unavailable=excluded.history_unavailable;
  end loop;
  -- Keep only current anchor dates. A subsequently backdated/voided anchor outside
  -- retained history is explicitly unavailable, never interpreted as zero sales.
  delete from reference_sales_archives a where not exists (
    select 1 from (
      select distinct on(product_id,kind) product_id,
        (occurred_at at time zone 'Asia/Seoul')::date + case when kind='count' then 1 else 0 end start_date
      from quantity_events where active and kind in ('count','receipt')
      order by product_id,kind,occurred_at desc,recorded_seq desc
    ) x where x.product_id=a.product_id and x.start_date=a.start_date
  );
  select count(*),count(distinct product_id) into rolled_rows,rolled_products from sales_daily where sale_date<cutoff;
  insert into sales_rollups(product_id,retired_through,retired_net_qty,revision)
  select product_id,cutoff,sum(net_qty),1 from sales_daily where sale_date<cutoff group by product_id
  on conflict(product_id) do update set retired_through=excluded.retired_through,
    retired_net_qty=sales_rollups.retired_net_qty+excluded.retired_net_qty,revision=sales_rollups.revision+1;
  delete from sales_daily where sale_date<cutoff;
  insert into sales_retention_boundary values(true,cutoff)
    on conflict(singleton) do update set retired_before=excluded.retired_before;
  return jsonb_build_object('cutoff',cutoff,'rolled_rows',rolled_rows,'rolled_products',rolled_products);
end $$;
revoke all on function rollup_old_sales_daily(int) from public, anon, authenticated;
grant execute on function rollup_old_sales_daily(int) to service_role;

-- Replacing a deleted date cannot compute a delta without original rows. Reject
-- the whole transaction (including its deletes), rather than double-count it.
create function guard_retired_sales_import() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status='applied' and old.status is distinct from new.status then
    perform pg_advisory_xact_lock(hashtext('sales_import_commit'));
    if exists(select 1 from sales_retention_boundary where new.period_start<retired_before) then
      raise exception 'RETIRED_SALES_PERIOD: 보관기간 이전 판매자료는 재업로드할 수 없습니다. 현재 수량을 실사로 등록하세요.';
    end if;
  end if;
  return new;
end $$;
create trigger sales_import_retention_guard before update on sales_imports
for each row execute function guard_retired_sales_import();
revoke all on function guard_retired_sales_import() from public,anon,authenticated;

create function sales_priority_summary() returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare d date := (now() at time zone 'Asia/Seoul')::date; result jsonb;
begin
  perform current_active_profile();
  with sums as (
    select p.id,p.name,p.spec,p.observed_from,coalesce(sum(s.net_qty),0) qty
    from products p left join sales_daily s on s.product_id=p.id and s.sale_date between d-29 and d
    where p.active group by p.id
  ), ranked as (
    select *,row_number() over(order by qty desc,id) rank from sums where qty>0
  )
  select jsonb_build_object('window_start',d-29,'window_end',d,
    'observed_days',(select count(*) from sales_coverage where sale_date between d-29 and d and status='complete'),
    'products',coalesce(jsonb_agg(jsonb_build_object('product_id',id,'name',name,'spec',spec,'rank',rank,'net_qty',qty,
      'partial_window',observed_from>d-29) order by rank),'[]'::jsonb)) into result
    from ranked where rank<=50;
  return result;
end $$;
revoke all on function sales_priority_summary() from public,anon;
grant execute on function sales_priority_summary() to authenticated;

create or replace function calc_status_summary()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform current_active_profile();
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
    'missing_order_step',(select count(*) from products where active and default_order_step is null),
    'missing_historical_sales',(select count(*) from product_state s join products p on p.id=s.product_id
      where p.active and s.calc_reason='historical_sales_missing'));
end $$;
