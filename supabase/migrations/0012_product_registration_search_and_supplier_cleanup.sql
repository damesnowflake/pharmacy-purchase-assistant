-- 최종 검수 보완: 상품 등록·검색 RPC 추가, 거래처 최소구매금액 기능 제거.
-- 소프트웨어_요구사항_명세서.md FR-16~18(갱신), 데이터베이스_설계.md "테이블과 제약"(갱신).

-- ---------------------------------------------------------------------------
-- 1) 상품 등록: 직원·관리자 모두 기본정보(품명·규격·기준단위·별칭·POS코드/바코드)를 등록할 수
--    있다. MOQ·발주단위는 선택 입력이며, 이 값을 넣으려면 관리자여야 한다(화면뿐 아니라 여기
--    DB에서도 강제한다). 기준 단위는 등록과 동시에 product_units에 환산계수 1로 자동 등록해,
--    등록 직후 바로 그 단위로 입고를 저장할 수 있게 한다.
-- ---------------------------------------------------------------------------
create or replace function create_product(
  p_name text,
  p_spec text,
  p_base_unit text,
  p_allows_fraction boolean default false,
  p_observed_from date default null,
  p_aliases jsonb default '[]'::jsonb, -- [{"source": text, "source_code": text, "alias": text}]
  p_default_moq numeric default null,
  p_default_order_step numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  v_id uuid;
  v_version bigint;
  alias_item jsonb;
begin
  actor := current_active_profile(); -- 직원·관리자 모두 기본정보 등록 가능 (FR-16)

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'INVALID_NAME' using errcode = '22023';
  end if;
  if p_base_unit is null or length(trim(p_base_unit)) = 0 then
    raise exception 'INVALID_BASE_UNIT' using errcode = '22023';
  end if;

  -- MOQ·발주단위는 발주 설정이므로 관리자만 등록 시점에 함께 넣을 수 있다 (FR-17).
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
    insert into products (
      name, spec, base_unit, allows_fraction, observed_from,
      default_moq, default_order_step, created_by
    ) values (
      trim(p_name), coalesce(trim(p_spec), ''), trim(p_base_unit), coalesce(p_allows_fraction, false),
      coalesce(p_observed_from, (now() at time zone 'Asia/Seoul')::date),
      p_default_moq, p_default_order_step, actor.user_id
    ) returning id, version into v_id, v_version;
  exception when unique_violation then
    raise exception 'DUPLICATE_PRODUCT: 이미 등록된 상품명·규격입니다 (%, %)', p_name, p_spec
      using errcode = '23505';
  end;

  insert into product_units (product_id, unit_code, factor_to_base)
  values (v_id, trim(p_base_unit), 1)
  on conflict (product_id, unit_code) do nothing;

  for alias_item in select * from jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) loop
    if coalesce(alias_item->>'alias', '') <> '' then
      insert into product_aliases (product_id, source, source_code, alias, normalized_alias, spec)
      values (
        v_id,
        coalesce(alias_item->>'source', 'manual'),
        nullif(alias_item->>'source_code', ''),
        alias_item->>'alias',
        lower(regexp_replace(alias_item->>'alias', '\s+', '', 'g')),
        nullif(alias_item->>'spec', '')
      );
    end if;
  end loop;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('product', v_id, actor.user_id, 'create_product',
      jsonb_build_object('name', p_name, 'spec', p_spec, 'base_unit', p_base_unit,
        'default_moq', p_default_moq, 'default_order_step', p_default_order_step));

  return jsonb_build_object('product_id', v_id, 'version', v_version, 'base_unit', trim(p_base_unit));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) 상품 검색: 상품명(+규격) 부분일치, 별칭, POS 코드/바코드로 검색한다. 공백은 정규화해
--    비교한다(예: "타이레놀 500mg"과 "타이레놀500mg"을 같은 것으로 찾는다). 상품 관리 화면과
--    입고 화면이 이 하나의 함수를 함께 쓴다(FR-16, 요구사항 반영).
-- ---------------------------------------------------------------------------
create or replace function search_products(p_query text default '', p_limit int default 20)
returns table (
  product_id uuid,
  name text,
  spec text,
  base_unit text,
  default_moq numeric,
  default_order_step numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized text;
  safe_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
begin
  perform current_active_profile();

  normalized := lower(regexp_replace(coalesce(p_query, ''), '\s+', '', 'g'));

  if normalized = '' then
    return query
      select p.id, p.name, p.spec, p.base_unit, p.default_moq, p.default_order_step
      from products p
      where p.active
      order by p.name
      limit safe_limit;
    return;
  end if;

  return query
    select distinct p.id, p.name, p.spec, p.base_unit, p.default_moq, p.default_order_step
    from products p
    left join product_aliases pa on pa.product_id = p.id
    where p.active and (
      lower(regexp_replace(p.name || coalesce(p.spec, ''), '\s+', '', 'g')) like '%' || normalized || '%'
      or pa.normalized_alias like '%' || normalized || '%'
      or lower(regexp_replace(coalesce(pa.source_code, ''), '\s+', '', 'g')) like '%' || normalized || '%'
    )
    order by p.name
    limit safe_limit;
end;
$$;

grant execute on function
  create_product(text, text, text, boolean, date, jsonb, numeric, numeric),
  search_products(text, int)
to authenticated;

-- ---------------------------------------------------------------------------
-- 3) 거래처 최소구매금액 기능 삭제: 구매 담당자가 실제 주문 시 판단하므로 시스템에서 요구하지
--    않는다. 거래처명·연락정보·프로모션 메모·거래처별 휴무일은 유지한다. 품목 MOQ·발주단위는
--    별개 개념이라 유지한다(products.default_moq/default_order_step, purchase_terms).
-- ---------------------------------------------------------------------------
drop function if exists save_supplier(uuid, text, numeric, numeric, text);

alter table suppliers drop column if exists minimum_drug_amount;
alter table suppliers drop column if exists minimum_other_amount;

create or replace function save_supplier(
  p_id uuid,
  p_name text,
  p_promotion_note text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  result_id uuid;
begin
  actor := require_admin();

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'INVALID_NAME' using errcode = '22023';
  end if;

  if p_id is null then
    insert into suppliers (name, promotion_note)
    values (p_name, p_promotion_note)
    returning id into result_id;
  else
    update suppliers set
      name = p_name,
      promotion_note = p_promotion_note,
      version = version + 1
    where id = p_id
    returning id into result_id;
    if result_id is null then
      raise exception 'SUPPLIER_NOT_FOUND' using errcode = '22023';
    end if;
  end if;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('supplier', result_id, actor.user_id, 'save_supplier', jsonb_build_object('name', p_name));

  return jsonb_build_object('id', result_id);
end;
$$;

grant execute on function save_supplier(uuid, text, text) to authenticated;
