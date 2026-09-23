\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %', message; end if;
end $$;

do $$
declare
  signature text;
  role_name text;
begin
  foreach signature in array array[
    'claim_recompute_batch(integer,integer)',
    'finish_recompute_item(uuid,uuid,bigint,text,jsonb,text)',
    'requeue_blocked_for_holiday()', 'requeue_for_new_business_day()',
    'enqueue_recompute(uuid,boolean)', 'recompute_product_state(uuid)',
    'replay_product_state_before_reopen(uuid)'
  ] loop
    foreach role_name in array array['anon', 'authenticated'] loop
      perform pg_temp.assert_true(not has_function_privilege(role_name, signature, 'EXECUTE'),
        role_name || ' cannot execute ' || signature);
    end loop;
    perform pg_temp.assert_true(has_function_privilege('service_role', signature, 'EXECUTE'),
      'server can execute ' || signature);
  end loop;
  perform pg_temp.assert_true(to_regprocedure('finish_recompute_item(uuid,uuid,text,text)') is null,
    'old unsafe overload removed');
end $$;

do $$
declare
  actor_id uuid := gen_random_uuid();
  product_id uuid;
  supplier_id uuid := gen_random_uuid();
  job record;
  old_token uuid;
  old_revision bigint;
  result text;
  rec_id uuid;
  rec_version bigint;
  new_rec_id uuid;
  receipt_id uuid;
  receipt_time timestamptz := now() + interval '1 minute';
  payload jsonb := jsonb_build_object(
    'model', jsonb_build_object('model_version','test', 'training_start','2026-01-01',
      'training_end','2026-06-29', 'n_observed',180, 'n_missing',0,
      'coefficients','[1,2]'::jsonb, 'warning_codes','[]'::jsonb),
    'recommendation', jsonb_build_object('arrival_date','2026-09-25', 'recommended_qty',10,
      'basis_json','{}'::jsonb)
  );
begin
  insert into auth.users(id) values (actor_id);
  insert into profiles(user_id, display_name, role) values(actor_id, 'test admin', 'admin');
  perform set_config('request.jwt.claim.sub', actor_id::text, true);
  product_id := (create_product('review test', '', 'ea', false, '2026-01-01', '[]', 1, 1)->>'product_id')::uuid;
  insert into suppliers(id,name) values(supplier_id, 'test supplier');

  perform enqueue_recompute(product_id, true);
  select * into job from claim_recompute_batch(20,300);
  old_token := job.lease_token;
  old_revision := job.required_revision;
  perform enqueue_recompute(product_id, true); -- New data arrives while the model is computing.
  result := finish_recompute_item(product_id, old_token, old_revision, 'done', payload);
  perform pg_temp.assert_true(result = 'pending', 'new revision survives old completion');
  perform pg_temp.assert_true(not exists(select 1 from forecast_models), 'stale model was not published');
  perform pg_temp.assert_true(not exists(select 1 from recommendations), 'stale recommendation was not published');

  select * into job from claim_recompute_batch(20,300);
  result := finish_recompute_item(product_id, old_token, old_revision, 'done', payload);
  perform pg_temp.assert_true(result = 'stale', 'old lease cannot complete a new claim');
  result := finish_recompute_item(product_id, job.lease_token, job.required_revision, 'done', payload);
  perform pg_temp.assert_true(result = 'done', 'current claim publishes successfully');
  perform pg_temp.assert_true((select input_revision from forecast_models) = job.required_revision,
    'model has claimed revision');
  select id, version into rec_id, rec_version from recommendations;

  perform enqueue_recompute(product_id, false);
  select * into job from claim_recompute_batch(20,300);
  result := finish_recompute_item(product_id, job.lease_token, job.required_revision, 'blocked',
    '{"calc_reason":"holiday_missing"}');
  perform pg_temp.assert_true(result = 'blocked', 'missing holiday reported');
  perform pg_temp.assert_true((select status from recompute_queue) = 'blocked', 'missing holiday sleeps');
  perform pg_temp.assert_true((select calc_reason from product_state) = 'holiday_missing', 'blocked reason visible');

  perform pg_temp.assert_true((select count(*) from claim_recompute_batch(20,300)) = 0, 'blocked work is not reclaimed');
  perform requeue_blocked_for_holiday();
  select * into job from claim_recompute_batch(20,300);
  update recompute_queue set lease_until = now() - interval '1 second';
  result := finish_recompute_item(product_id, job.lease_token, job.required_revision, 'done', payload);
  perform pg_temp.assert_true(result = 'pending', 'expired lease cannot publish');
  select * into job from claim_recompute_batch(20,300);
  result := finish_recompute_item(product_id, job.lease_token, job.required_revision, 'done', payload);
  perform pg_temp.assert_true((select version from recommendations where id = rec_id) > rec_version,
    'newly computed recommendation invalidates stale UI version');

  begin
    perform confirm_order(gen_random_uuid(), rec_id, rec_version, product_id, supplier_id, 10, 'ea',
      (now() at time zone 'Asia/Seoul')::date);
    raise exception 'expected VERSION_CONFLICT';
  exception when serialization_failure then
    perform pg_temp.assert_true(sqlerrm = 'VERSION_CONFLICT', 'version conflict returned');
  end;
  select version into rec_version from recommendations where id = rec_id;
  perform confirm_order(gen_random_uuid(), rec_id, rec_version, product_id, supplier_id, 10, 'ea',
    (now() at time zone 'Asia/Seoul')::date);
  perform register_receipt(gen_random_uuid(), receipt_time,
    jsonb_build_array(jsonb_build_object('product_id',product_id,'quantity',10,'unit','ea')));
  select id into receipt_id from quantity_events where kind = 'receipt';
  perform pg_temp.assert_true((select status from recommendations where id = rec_id) = 'received', 'fully received');
  perform revise_quantity_event(gen_random_uuid(), receipt_id, 1, false, 6, 'ea', receipt_time, 'actual six');
  perform pg_temp.assert_true((select pending_qty from product_state) = 4, 'corrected pending four');
  perform pg_temp.assert_true((select status = 'waiting' and closed_at is null and closed_reason is null
    from recommendations where id = rec_id), 'received recommendation reopens');

  perform register_receipt(gen_random_uuid(), receipt_time + interval '1 minute',
    jsonb_build_array(jsonb_build_object('product_id',product_id,'quantity',4,'unit','ea')));
  select id into receipt_id from quantity_events where kind = 'receipt' and qty_base = 4 and active;
  insert into recommendations(product_id, arrival_date, recommended_qty, basis_json, input_revision)
    values(product_id, '2026-09-26', 10, '{}', 99) returning id into new_rec_id;
  perform revise_quantity_event(gen_random_uuid(), receipt_id, 1, false, 2, 'ea',
    receipt_time + interval '1 minute', 'actual two');
  perform pg_temp.assert_true((select pending_qty from product_state) = 2, 'corrected pending two');
  perform pg_temp.assert_true((select status from recommendations where id = rec_id) = 'waiting',
    'old order reopens even with a new review');
  perform pg_temp.assert_true((select closed_reason from recommendations where id = new_rec_id) = 'not_needed',
    'new unplaced review retained as closed history');
  perform pg_temp.assert_true((select count(*) from recommendations where status <> 'received') = 1,
    'exactly one open recommendation');
  perform recompute_product_state(product_id);
  perform pg_temp.assert_true((select pending_qty from product_state) = 2, 'replay is stable');
  raise notice 'PASS: queue permissions, revision/lease fencing, blocked retry, order version, correction reopening';
end $$;
rollback;
