-- 시나리오 7: 판매 확정의 재시도·동시성·범위 하드닝. 시나리오 8을 위한 save_product_unit도
-- 함께 추가한다(단위·환산값 관리).

alter table sales_imports
  add column if not exists coverage_watermark bigint not null default 0,
  add column if not exists applied_rows int,
  add column if not exists skipped_rows int,
  add column if not exists affected_products int;

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
  watermark bigint;
  cutoff date;
begin
  actor := current_active_profile();

  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
    raise exception 'INVALID_PERIOD' using errcode = '22023';
  end if;
  if p_mode <> 'full_period' then
    raise exception 'NOT_IMPLEMENTED: 증분 형식은 실제 POS 표본 확인 후 지원 (docs/미확인_항목.md)'
      using errcode = '0A000';
  end if;

  -- 180일 이전 자료는 이미 상품별 합계로 이월·삭제되어 일별 교체 대상이 아니다. 이 범위와
  -- 겹치는 전체기간 업로드는 이월 자료와 이중 합산될 수 있어 지금은 허용 범위를 안내하고 막는다.
  cutoff := (now() at time zone 'Asia/Seoul')::date - 180;
  if p_period_start < cutoff then
    raise exception 'PERIOD_TOO_OLD: %보다 이전 기간은 이미 상품별로 합산·정리되어 이 업로드로 반영할 수 없습니다', cutoff
      using errcode = '22023';
  end if;

  if exists (select 1 from sales_imports where file_hash = p_file_hash and status = 'applied') then
    raise exception 'DUPLICATE_FILE: 이미 적용된 파일입니다' using errcode = '22023';
  end if;

  select coalesce(max(revision), 0) into watermark
    from sales_coverage where sale_date between p_period_start and p_period_end;

  insert into sales_imports (file_hash, period_start, period_end, mode, status, parser_version, actor_id, coverage_watermark)
  values (p_file_hash, p_period_start, p_period_end, p_mode, 'staging', 'generic-csv-xlsx-v1', actor.user_id, watermark)
  returning id into import_id;

  return jsonb_build_object('import_id', import_id);
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
    insert into recompute_queue (product_id, required_revision, need_training)
    select unnest(affected_product_ids), 1, true
    on conflict (product_id) do update set
      required_revision = recompute_queue.required_revision + 1,
      need_training = true,
      status = 'pending',
      updated_at = now();
  end if;

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

grant execute on function
  begin_sales_import(date, date, text, sales_import_mode),
  commit_sales_import(uuid, bigint)
to authenticated;

-- ---------------------------------------------------------------------------
-- 시나리오 8: 관리자가 품목 단위·포장 환산값을 등록·수정한다. 기준단위(factor=1)는
-- 여기서 고칠 수 없다 — create_product가 자동 등록하며 이후 별도 절차로만 바뀐다.
-- ---------------------------------------------------------------------------
create or replace function save_product_unit(
  p_product_id uuid,
  p_unit_code text,
  p_factor_to_base numeric,
  p_remove boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  base_unit text;
begin
  actor := require_admin();

  select p.base_unit into base_unit from products p where p.id = p_product_id;
  if base_unit is null then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
  end if;
  if p_unit_code is null or length(trim(p_unit_code)) = 0 then
    raise exception 'INVALID_UNIT_CODE' using errcode = '22023';
  end if;
  if trim(p_unit_code) = base_unit then
    raise exception 'CANNOT_MODIFY_BASE_UNIT' using errcode = '22023';
  end if;

  if p_remove then
    delete from product_units where product_id = p_product_id and unit_code = trim(p_unit_code);
  else
    if p_factor_to_base is null or p_factor_to_base <= 0 then
      raise exception 'INVALID_FACTOR' using errcode = '22023';
    end if;
    insert into product_units (product_id, unit_code, factor_to_base)
    values (p_product_id, trim(p_unit_code), p_factor_to_base)
    on conflict (product_id, unit_code) do update set factor_to_base = excluded.factor_to_base;
  end if;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('product_unit', p_product_id, actor.user_id,
      case when p_remove then 'remove_product_unit' else 'save_product_unit' end,
      jsonb_build_object('unit_code', p_unit_code, 'factor_to_base', p_factor_to_base));

  return jsonb_build_object('product_id', p_product_id, 'unit_code', p_unit_code);
end;
$$;

grant execute on function save_product_unit(uuid, text, numeric, boolean) to authenticated;
