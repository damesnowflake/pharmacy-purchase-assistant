-- 시나리오 5·6: 판매 연결 화면에서 확인한 매칭을 별칭으로 저장해 다음 업로드에 재사용한다.
-- 직원도 새 기본 연결을 추가할 수 있지만, 이미 다른 상품에 연결된 고유 코드는 조용히
-- 재지정할 수 없다(source_code 유니크 인덱스가 이미 막고, 여기서는 그 충돌을 분명한
-- 오류로 전달한다).

create or replace function add_product_alias(
  p_product_id uuid,
  p_alias text,
  p_source text default 'sales_upload',
  p_source_code text default null,
  p_spec text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor public.profiles;
  new_id uuid;
begin
  actor := current_active_profile();

  if p_alias is null or length(trim(p_alias)) = 0 then
    raise exception 'INVALID_ALIAS' using errcode = '22023';
  end if;
  if not exists (select 1 from products where id = p_product_id and active) then
    raise exception 'PRODUCT_NOT_FOUND' using errcode = '22023';
  end if;

  begin
    insert into product_aliases (product_id, source, source_code, alias, normalized_alias, spec)
    values (
      p_product_id, coalesce(p_source, 'manual'), nullif(trim(coalesce(p_source_code, '')), ''),
      trim(p_alias), lower(regexp_replace(p_alias, '\s+', '', 'g')), nullif(trim(coalesce(p_spec, '')), '')
    )
    returning id into new_id;
  exception when unique_violation then
    raise exception 'ALIAS_CODE_ALREADY_LINKED: 이 코드는 이미 다른 상품에 연결되어 있습니다. 관리자에게 정정을 요청하세요.'
      using errcode = '23505';
  end;

  insert into audit_events (entity_type, entity_id, actor_id, action, after)
    values ('product_alias', new_id, actor.user_id, 'add_product_alias',
      jsonb_build_object('product_id', p_product_id, 'alias', p_alias, 'source_code', p_source_code));

  return jsonb_build_object('alias_id', new_id, 'product_id', p_product_id);
end;
$$;

grant execute on function add_product_alias(uuid, text, text, text, text) to authenticated;
