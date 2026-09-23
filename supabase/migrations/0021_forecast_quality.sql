-- Only latest diagnostics per product; no daily prediction-history accumulation.
alter table forecast_models
  add column negative_forecasts jsonb not null default '[]',
  add column evaluation jsonb not null default '{"status":"not_evaluated"}',
  add column diagnostic_start date,
  add column diagnostic_end date;

-- Preserve the existing lock/revision/lease check and publish diagnostics in the
-- SAME transaction, only after that check succeeds. No new public write endpoint.
alter function finish_recompute_item(uuid,uuid,bigint,text,jsonb,text)
  rename to finish_recompute_item_core_0020;
create function finish_recompute_item(
  p_product_id uuid, p_lease_token uuid, p_required_revision bigint,
  p_status text, p_result jsonb default '{}'::jsonb, p_error text default null
) returns text language plpgsql security definer set search_path=public,pg_temp as $$
declare outcome text; model jsonb:=p_result->'model'; ev jsonb;
begin
  outcome:=finish_recompute_item_core_0020(p_product_id,p_lease_token,p_required_revision,p_status,p_result,p_error);
  if outcome in ('done','blocked') then
    if model is not null and model<>'null'::jsonb then
      ev:=coalesce(model->'evaluation','{"status":"not_evaluated"}'::jsonb);
      update forecast_models set
        negative_forecasts=coalesce(model->'negative_forecasts','[]'::jsonb),
        evaluation=ev,mae=(ev->>'mae')::numeric,wape=(ev->>'wape')::numeric,
        diagnostic_start=(model->>'diagnostic_start')::date,
        diagnostic_end=(model->>'diagnostic_end')::date
      where product_id=p_product_id and input_revision=p_required_revision;
    elsif p_result->>'calc_reason'='insufficient_history' then
      -- A replaced sales file may remove the observations that previously fitted.
      -- Do not leave an old model's metrics looking current.
      delete from forecast_models where product_id=p_product_id;
    end if;
  end if;
  return outcome;
end $$;
revoke all on function finish_recompute_item(uuid,uuid,bigint,text,jsonb,text) from public,anon,authenticated;
grant execute on function finish_recompute_item(uuid,uuid,bigint,text,jsonb,text) to service_role;

create function forecast_quality_page(p_query text default '',p_negative_only boolean default false,p_offset integer default 0,p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare answer jsonb;
begin
  perform current_active_profile();
  with matched as (
    select p.id product_id,p.name,p.spec,p.base_unit,m.training_end,m.n_observed,m.computed_at,
      m.mae,m.wape,coalesce(m.warning_codes,'{}') warning_codes,
      coalesce(m.negative_forecasts,'[]') negative_forecasts,
      coalesce(m.evaluation,'{"status":"not_evaluated"}') evaluation,
      m.diagnostic_start,m.diagnostic_end,s.calc_reason,
      m.product_id is not null and (m.input_revision is distinct from q.required_revision
        or m.training_end < (now() at time zone 'Asia/Seoul')::date) is_stale
    from products p left join forecast_models m on m.product_id=p.id
      left join recompute_queue q on q.product_id=p.id left join product_state s on s.product_id=p.id
    where p.active and (coalesce(p_query,'')='' or p.name ilike '%'||p_query||'%' or p.spec ilike '%'||p_query||'%')
      and (not coalesce(p_negative_only,false) or 'negative_forecast'=any(m.warning_codes))
  ), page as (
    select * from matched order by (jsonb_array_length(negative_forecasts)>0) desc,name,product_id
    limit least(greatest(coalesce(p_limit,25),1),100) offset greatest(coalesce(p_offset,0),0)
  )
  select jsonb_build_object('total',(select count(*) from matched),
    'items',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb)) into answer;
  return answer;
end $$;
revoke all on function forecast_quality_page(text,boolean,integer,integer) from public,anon;
grant execute on function forecast_quality_page(text,boolean,integer,integer) to authenticated;
