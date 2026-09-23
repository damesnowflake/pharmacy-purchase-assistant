-- 판매 파일 반영 RPC의 실제 구현. 상세_알고리즘_설계.md §2, 데이터베이스_설계.md "저장 과정".
-- 0005의 자리표시자(NOT_IMPLEMENTED)를 전체기간(full_period) 형식에 한해 실제 구현으로 교체한다.
-- 증분(incremental) 형식은 실제 CatPOS 표본에서 식별자를 확인하기 전까지 계속 NOT_IMPLEMENTED다
-- (FR-07, docs/미확인_항목.md).

drop function if exists begin_sales_import(date, date, text, sales_import_mode);
drop function if exists commit_sales_import(uuid, bigint);

create or replace function begin_sales_import(
  p_period_start date,
  p_period_end date,
  p_file_hash text,
  p_mode sales_import_mode
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  import_id uuid;
begin
  actor := current_active_profile(); -- 직원·관리자 모두 업로드 가능 (FR-05)

  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
    raise exception 'INVALID_PERIOD' using errcode = '22023';
  end if;
  if p_mode <> 'full_period' then
    raise exception 'NOT_IMPLEMENTED: 증분 형식은 실제 POS 표본 확인 후 지원 (docs/미확인_항목.md)'
      using errcode = '0A000';
  end if;

  if exists (select 1 from sales_imports where file_hash = p_file_hash and status = 'applied') then
    raise exception 'DUPLICATE_FILE: 이미 적용된 파일입니다' using errcode = '22023';
  end if;

  insert into sales_imports (file_hash, period_start, period_end, mode, status, parser_version, actor_id)
  values (p_file_hash, p_period_start, p_period_end, p_mode, 'staging', 'generic-csv-xlsx-v1', actor.user_id)
  returning id into import_id;

  return jsonb_build_object('import_id', import_id);
end;
$$;

create or replace function stage_sales_rows(
  p_import_id uuid,
  p_batch_no int,
  p_rows jsonb -- [{row_no, product_id, sale_date, net_qty, error_code}]
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  imp public.sales_imports;
  row_item jsonb;
  inserted_count int := 0;
begin
  actor := current_active_profile();

  select * into imp from sales_imports where id = p_import_id;
  if imp.id is null then
    raise exception 'IMPORT_NOT_FOUND' using errcode = '22023';
  end if;
  if imp.actor_id <> actor.user_id then
    raise exception 'FORBIDDEN_NOT_OWNER' using errcode = '42501';
  end if;
  if imp.status <> 'staging' then
    raise exception 'IMPORT_NOT_STAGING' using errcode = '40001';
  end if;

  for row_item in select * from jsonb_array_elements(p_rows) loop
    insert into sales_import_rows (import_id, batch_no, row_no, product_id, sale_date, net_qty, raw_row, error_code)
    values (
      p_import_id,
      p_batch_no,
      (row_item->>'row_no')::int,
      nullif(row_item->>'product_id', '')::uuid,
      nullif(row_item->>'sale_date', '')::date,
      nullif(row_item->>'net_qty', '')::numeric,
      row_item->'raw_row',
      row_item->>'error_code'
    )
    on conflict (import_id, batch_no, row_no) do nothing;
    inserted_count := inserted_count + 1;
  end loop;

  return jsonb_build_object('import_id', p_import_id, 'batch_no', p_batch_no, 'row_count', inserted_count);
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
  skipped_count bigint;
  affected_products uuid[];
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

  select count(*) into valid_count from sales_import_rows
    where import_id = p_import_id and error_code is null and product_id is not null and sale_date is not null;
  skipped_count := staged_count - valid_count;
  if valid_count = 0 then
    raise exception 'NO_VALID_ROWS' using errcode = '22023';
  end if;

  -- 겹치는 기간의 동시 커밋을 직렬화한다. sales_coverage에 아직 행이 없는(최초 업로드) 기간도
  -- 안전하게 잠그기 위해 날짜 범위를 키로 하는 트랜잭션 어드바이저리 락을 사용한다.
  -- 완전히 겹치지 않는 기간끼리는 다른 락 키를 가지므로 서로 막지 않는다.
  perform pg_advisory_xact_lock(hashtext('sales_import_period'), hashtext(imp.period_start::text));

  -- 전체기간 보고서: 해당 기간 기존 집계를 지운 뒤 새 결과로 교체한다.
  -- 새 파일에서 사라진 품목의 옛 판매가 남지 않도록 기간 전체를 대상으로 한다.
  delete from sales_daily where sale_date between imp.period_start and imp.period_end;

  insert into sales_daily (product_id, sale_date, net_qty, import_id, revision)
  select product_id, sale_date, sum(net_qty), p_import_id, 1
  from sales_import_rows
  where import_id = p_import_id and error_code is null and product_id is not null and sale_date is not null
  group by product_id, sale_date;

  select array_agg(distinct product_id) into affected_products
  from sales_import_rows
  where import_id = p_import_id and error_code is null and product_id is not null;

  for d in select generate_series(imp.period_start, imp.period_end, interval '1 day')::date loop
    insert into sales_coverage (sale_date, import_id, revision, status)
    values (d, p_import_id, 1, 'complete')
    on conflict (sale_date) do update set
      import_id = excluded.import_id,
      revision = sales_coverage.revision + 1,
      status = 'complete';
  end loop;

  update sales_imports set status = 'applied' where id = p_import_id;

  -- 이 기간과 겹치는, 이전에 적용됐던 다른 업로드는 대체되었음을 표시한다 (같은 파일 재적용 방지와는 별개로,
  -- 겹치는 기간의 이전 성공 업로드가 "적용됨"으로 남아 혼동을 주지 않도록 한다).
  update sales_imports set status = 'superseded'
    where id <> p_import_id
      and status = 'applied'
      and period_start <= imp.period_end and period_end >= imp.period_start;

  -- 판매가 바뀐 품목은 예측 재학습 대상으로 예약한다 (시스템_구조_설계.md "계산과 정기 작업" 1).
  if affected_products is not null then
    insert into recompute_queue (product_id, required_revision, need_training)
    select unnest(affected_products), 1, true
    on conflict (product_id) do update set
      required_revision = recompute_queue.required_revision + 1,
      need_training = true,
      status = 'pending',
      updated_at = now();
  end if;

  -- 임시 적재 행은 신속히 정리한다 (최대 30일 규정과 별개로, 적용 직후 정리 가능한 것은 바로 정리).
  delete from sales_import_rows where import_id = p_import_id;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('sales_import', p_import_id, actor.user_id, 'commit_sales_import',
      jsonb_build_object('applied_rows', valid_count, 'skipped_rows', skipped_count,
        'period_start', imp.period_start, 'period_end', imp.period_end));

  return jsonb_build_object(
    'import_id', p_import_id,
    'applied_rows', valid_count,
    'skipped_rows', skipped_count,
    'affected_products', coalesce(array_length(affected_products, 1), 0)
  );
end;
$$;

grant execute on function
  begin_sales_import(date, date, text, sales_import_mode),
  stage_sales_rows(uuid, int, jsonb),
  commit_sales_import(uuid, bigint)
to authenticated;
