begin;
create function pg_temp.check_quality(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %',msg; end if; end $$;
do $$
declare actor uuid:=gen_random_uuid(); pid uuid; job record; answer text; page jsonb;
  payload jsonb:=jsonb_build_object('calc_reason','reference_missing','model',jsonb_build_object(
    'model_version','ols-v1','training_start',current_date-179,'training_end',current_date,
    'n_observed',32,'n_missing',0,'coefficients','[1,2]'::jsonb,
    'warning_codes','["negative_forecast","short_history"]'::jsonb,
    'negative_forecasts','[{"date":"2026-09-24","raw":-4.5,"applied":0}]'::jsonb,
    'evaluation','{"status":"evaluated","method":"rolling_origin_1day","n":24,"requested_days":28,"partial":true,"mae":1.25,"wape":0.1,"baseline_mae":2,"baseline_wape":0.2}'::jsonb));
begin
  insert into auth.users(id) values(actor);
  insert into profiles(user_id,display_name,role) values(actor,'quality test','staff');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  pid:=(create_product('quality product','','ea',false,current_date-100)->>'product_id')::uuid;
  perform enqueue_recompute(pid,true);
  select * into job from claim_recompute_batch(1,300);
  answer:=finish_recompute_item(pid,job.lease_token,job.required_revision,'blocked',payload);
  perform pg_temp.check_quality(answer='blocked','blocked product still publishes diagnostics');
  perform pg_temp.check_quality((select mae=1.25 and wape=0.1 and negative_forecasts->0->>'raw'='-4.5' from forecast_models where product_id=pid),'raw negative and metrics stored');
  page:=forecast_quality_page('quality product',true);
  perform pg_temp.check_quality((page->>'total')::int=1,'negative warning visible without a recommendation');
  perform pg_temp.check_quality((page->'items'->0->'evaluation'->>'n')::int=24,'evaluated day count visible');
  perform enqueue_recompute(pid,true);
  select * into job from claim_recompute_batch(1,300);
  answer:=finish_recompute_item(pid,gen_random_uuid(),job.required_revision,'blocked',jsonb_set(payload,'{model,evaluation,mae}','999'));
  perform pg_temp.check_quality(answer='stale' and (select mae=1.25 from forecast_models where product_id=pid),'stale worker cannot publish metrics');
  answer:=finish_recompute_item(pid,job.lease_token,job.required_revision,'blocked','{"calc_reason":"insufficient_history"}');
  perform pg_temp.check_quality(not exists(select 1 from forecast_models where product_id=pid),'invalidated model metrics removed');
  perform pg_temp.check_quality(not has_function_privilege('authenticated','finish_recompute_item(uuid,uuid,bigint,text,jsonb,text)','execute'),'write remains server-only');
  perform pg_temp.check_quality(not has_function_privilege('anon','forecast_quality_page(text,boolean,integer,integer)','execute'),'anonymous read denied');
  update profiles set active=false where user_id=actor;
  begin
    perform forecast_quality_page();
    raise exception 'FAILED: inactive user read';
  exception when sqlstate '28000' then null; end;
  raise notice 'PASS: quality storage, staff read, no-recommendation warnings, stale fence, invalidation, ACL';
end $$;
rollback;
