-- 운영 유지보수: 180일 판매 이월, 임시자료 만료 정리, 용량 점검.
-- 데이터베이스_설계.md "180일 보관과 기준점", "용량 관리", 개발계획.md "무료 플랜 용량 구현 기준".
-- pg_cron으로 매일 한국시간 03:00에 rollup_and_expire_daily()를 호출하도록 예약한다
-- (Supabase 프로젝트에서 pg_cron extension 활성화 필요 — docs/미확인_항목.md).

-- pg_cron은 Supabase 관리형 프로젝트에는 미리 설치되어 있지만, 순수 로컬 PostgreSQL(이 저장소의
-- SQL 스모크 테스트 등)에는 확장 자체가 없을 수 있다. 없으면 조용히 건너뛰고 예약은 생략한다 —
-- 함수 정의(rollup_old_sales_daily 등)는 pg_cron 유무와 무관하게 그대로 만들어진다.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron 확장을 사용할 수 없어 건너뜁니다: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 180일 이전 일별 판매를 품목별로 합산해 rollup에 더하고 같은 트랜잭션에서 지운다.
-- 반복 실행해도 이미 이월된 행은 retired_through 덕분에 다시 합산하지 않는다.
-- ---------------------------------------------------------------------------
create or replace function rollup_old_sales_daily(p_retention_days int default 180)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cutoff date := (now() at time zone 'Asia/Seoul')::date - p_retention_days;
  rolled_products int := 0;
  rolled_rows int := 0;
begin
  with to_roll as (
    select product_id, sum(net_qty) as qty, count(*) as cnt
    from sales_daily
    where sale_date < cutoff
    group by product_id
  ),
  upserted as (
    insert into sales_rollups (product_id, retired_through, retired_net_qty, revision)
    select product_id, cutoff, qty, 1 from to_roll
    on conflict (product_id) do update set
      retired_net_qty = sales_rollups.retired_net_qty + excluded.retired_net_qty,
      retired_through = greatest(sales_rollups.retired_through, excluded.retired_through),
      revision = sales_rollups.revision + 1
    returning product_id
  )
  select count(*), coalesce(sum(cnt), 0) into rolled_products, rolled_rows from to_roll;

  delete from sales_daily where sale_date < cutoff;

  return jsonb_build_object('cutoff', cutoff, 'rolled_products', rolled_products, 'rolled_rows', rolled_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- 30일이 지난 임시 적재행·중단된 업로드를 정리한다. commit_sales_import가 성공 시 이미
-- 정리하므로, 여기서는 실패·중단으로 남은 것만 대상이다 (데이터베이스_설계.md "용량 관리").
-- ---------------------------------------------------------------------------
create or replace function expire_stale_sales_imports()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  expired_rows_count bigint;
  expired_imports_count bigint;
begin
  delete from sales_import_rows
    where import_id in (select id from sales_imports where expires_at < now());
  get diagnostics expired_rows_count = row_count;

  update sales_imports set status = 'failed', object_path = null
    where expires_at < now() and status = 'staging';
  get diagnostics expired_imports_count = row_count;

  return jsonb_build_object('expired_rows', expired_rows_count, 'expired_staging_imports', expired_imports_count);
end;
$$;

create or replace function run_daily_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rollup_result jsonb;
  expire_result jsonb;
begin
  rollup_result := rollup_old_sales_daily();
  expire_result := expire_stale_sales_imports();
  return jsonb_build_object('rollup', rollup_result, 'expired', expire_result, 'ran_at', now());
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'daily-maintenance-0300-kst') then
      perform cron.schedule(
        'daily-maintenance-0300-kst',
        '0 18 * * *', -- UTC 18:00 = KST 03:00 (익일)
        $sql$select run_daily_maintenance();$sql$
      );
    end if;
  else
    raise notice 'pg_cron이 없어 daily-maintenance 예약을 건너뜁니다. Supabase 프로젝트에서는 pg_cron이 기본 제공된다.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 무료 플랜 용량 점검. 개발계획.md: DB 500MB의 70%/85% 도달 시 경고.
-- 관리자만 조회할 수 있다.
-- ---------------------------------------------------------------------------
create or replace function capacity_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  db_bytes bigint;
  db_limit_bytes bigint := 500 * 1024 * 1024;
  ratio numeric;
  level text;
begin
  actor := require_admin();

  db_bytes := pg_database_size(current_database());
  ratio := db_bytes::numeric / db_limit_bytes;
  level := case when ratio >= 0.85 then 'critical' when ratio >= 0.70 then 'warning' else 'ok' end;

  return jsonb_build_object(
    'db_bytes', db_bytes,
    'db_limit_bytes', db_limit_bytes,
    'ratio', round(ratio, 4),
    'level', level,
    'sales_daily_rows', (select count(*) from sales_daily),
    'quantity_events_rows', (select count(*) from quantity_events),
    'products_count', (select count(*) from products where active),
    'measured_at', now()
  );
end;
$$;

grant execute on function capacity_status() to authenticated;
