-- 거래처·발주조건·휴무일 설정 RPC와 추천 결정(보류/제외/재개) RPC.
-- 소프트웨어_요구사항_명세서.md FR-17~19, FR-27. 관리자만 허용.

create or replace function save_supplier(
  p_id uuid,
  p_name text,
  p_minimum_drug_amount numeric,
  p_minimum_other_amount numeric,
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
  if p_minimum_drug_amount < 0 or p_minimum_other_amount < 0 then
    raise exception 'INVALID_MINIMUM_AMOUNT' using errcode = '22023';
  end if;

  if p_id is null then
    insert into suppliers (name, minimum_drug_amount, minimum_other_amount, promotion_note)
    values (p_name, p_minimum_drug_amount, p_minimum_other_amount, p_promotion_note)
    returning id into result_id;
  else
    update suppliers set
      name = p_name,
      minimum_drug_amount = p_minimum_drug_amount,
      minimum_other_amount = p_minimum_other_amount,
      promotion_note = p_promotion_note,
      version = version + 1
    where id = p_id
    returning id into result_id;
    if result_id is null then
      raise exception 'SUPPLIER_NOT_FOUND' using errcode = '22023';
    end if;
  end if;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('supplier', result_id, actor.user_id, 'save_supplier',
      jsonb_build_object('name', p_name, 'minimum_drug_amount', p_minimum_drug_amount,
        'minimum_other_amount', p_minimum_other_amount));

  return jsonb_build_object('id', result_id);
end;
$$;

create or replace function save_purchase_terms(
  p_product_id uuid,
  p_supplier_id uuid,
  p_moq_base numeric,
  p_step_base numeric,
  p_preferred boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
begin
  actor := require_admin();

  if p_moq_base is null or p_moq_base <= 0 then
    raise exception 'INVALID_MOQ' using errcode = '22023';
  end if;
  if p_step_base is null or p_step_base <= 0 then
    raise exception 'INVALID_ORDER_STEP' using errcode = '22023';
  end if;

  if p_preferred then
    update purchase_terms set preferred = false
      where product_id = p_product_id and supplier_id <> p_supplier_id;
  end if;

  insert into purchase_terms (product_id, supplier_id, moq_base, step_base, preferred, updated_at)
  values (p_product_id, p_supplier_id, p_moq_base, p_step_base, coalesce(p_preferred, false), now())
  on conflict (product_id, supplier_id) do update set
    moq_base = excluded.moq_base,
    step_base = excluded.step_base,
    preferred = excluded.preferred,
    updated_at = now();

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('purchase_terms', p_product_id, actor.user_id, 'save_purchase_terms',
      jsonb_build_object('supplier_id', p_supplier_id, 'moq_base', p_moq_base, 'step_base', p_step_base));

  return jsonb_build_object('product_id', p_product_id, 'supplier_id', p_supplier_id);
end;
$$;

create or replace function set_supplier_closed_date(
  p_supplier_id uuid,
  p_closed_date date,
  p_reason text,
  p_remove boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
begin
  actor := require_admin();

  if p_remove then
    delete from supplier_closed_dates where supplier_id = p_supplier_id and closed_date = p_closed_date;
  else
    insert into supplier_closed_dates (supplier_id, closed_date, reason)
    values (p_supplier_id, p_closed_date, p_reason)
    on conflict (supplier_id, closed_date) do update set reason = excluded.reason;
  end if;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('supplier_closed_date', p_supplier_id, actor.user_id,
      case when p_remove then 'remove_closed_date' else 'add_closed_date' end,
      jsonb_build_object('closed_date', p_closed_date, 'reason', p_reason));

  return jsonb_build_object('supplier_id', p_supplier_id, 'closed_date', p_closed_date);
end;
$$;

-- ---------------------------------------------------------------------------
-- decide_recommendation: 추천 수량 수정·보류·제외·재개. FR-27, FR-29. 관리자만 허용.
-- 발주 완료(review→waiting) 자체는 confirm_order가 담당하므로 여기서는 review 상태
-- 안에서의 수량 수정과 decision(active/deferred/excluded) 전환만 다룬다.
-- ---------------------------------------------------------------------------
create or replace function decide_recommendation(
  p_recommendation_id uuid,
  p_expected_version bigint,
  p_decision recommendation_decision,
  p_recommended_qty numeric
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  current_version bigint;
  current_status recommendation_status;
begin
  actor := require_admin();

  select version, status into current_version, current_status
    from recommendations where id = p_recommendation_id for update;
  if current_version is null then
    raise exception 'RECOMMENDATION_NOT_FOUND' using errcode = '22023';
  end if;
  if current_version <> p_expected_version then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;
  if current_status <> 'review' then
    raise exception 'RECOMMENDATION_ALREADY_DECIDED' using errcode = '40001';
  end if;
  if p_recommended_qty is not null and p_recommended_qty <= 0 then
    raise exception 'INVALID_QUANTITY' using errcode = '22023';
  end if;

  update recommendations set
    decision = p_decision,
    recommended_qty = coalesce(p_recommended_qty, recommended_qty),
    version = version + 1
  where id = p_recommendation_id;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('recommendation', p_recommendation_id, actor.user_id, 'decide_recommendation',
      jsonb_build_object('decision', p_decision, 'recommended_qty', p_recommended_qty));

  return jsonb_build_object('id', p_recommendation_id, 'version', current_version + 1);
end;
$$;

grant execute on function
  save_supplier(uuid, text, numeric, numeric, text),
  save_purchase_terms(uuid, uuid, numeric, numeric, boolean),
  set_supplier_closed_date(uuid, date, text, boolean),
  decide_recommendation(uuid, bigint, recommendation_decision, numeric)
to authenticated;
