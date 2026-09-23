begin;
create function pg_temp.assert_true(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %',message; end if; end $$;
do $$
declare actor_id uuid:=gen_random_uuid(); pid uuid; other_id uuid; job record; answer text;
begin
  insert into auth.users(id) values(actor_id);
  insert into profiles(user_id,display_name,role) values(actor_id,'queue test','admin');
  perform set_config('request.jwt.claim.sub',actor_id::text,true);
  pid:=(create_product('blocked product','','ea',false,current_date-100)->>'product_id')::uuid;
  other_id:=(create_product('old background job','','ea',false,current_date-100)->>'product_id')::uuid;
  perform enqueue_recompute(pid,true);
  select * into job from claim_recompute_batch(1,300);
  answer:=finish_recompute_item(pid,job.lease_token,job.required_revision,'blocked','{"calc_reason":"reference_missing"}');
  perform pg_temp.assert_true(answer='blocked','worker reports blocked');
  perform pg_temp.assert_true((select count(*) from claim_recompute_batch(20,300))=0,'blocked work sleeps');
  perform requeue_for_new_business_day();
  perform pg_temp.assert_true((select count(*) from claim_recompute_batch(20,300))=0,'midnight does not wake missing dependencies');
  insert into recompute_queue(product_id,required_revision,need_training,status,priority,updated_at)
    values(other_id,1,true,'pending',0,now()-interval '1 day');
  perform register_receipt(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',10,'unit','ea')));
  select * into job from claim_recompute_batch(1,300);
  perform pg_temp.assert_true(job.product_id=pid,'receipt wakes product ahead of background jobs');
  answer:=finish_recompute_item(pid,job.lease_token,job.required_revision,'blocked','{"calc_reason":"moq_missing"}');
  perform save_product_settings(pid,1,10,1);
  select * into job from claim_recompute_batch(1,300);
  perform pg_temp.assert_true(job.product_id=pid,'settings wake blocked product');
  answer:=finish_recompute_item(pid,job.lease_token,job.required_revision,'error','{}','transient');
  perform pg_temp.assert_true((select not_before>now() from recompute_queue where product_id=pid),'error backoff');
  perform pg_temp.assert_true(not exists(select 1 from claim_recompute_batch(20,300) where product_id=pid),'error cannot retry immediately');
  perform enqueue_recompute(pid,false);
  select * into job from claim_recompute_batch(1,300);
  perform pg_temp.assert_true(job.product_id=pid,'new input bypasses error delay');
  perform pg_temp.assert_true((calc_status_summary()->>'missing_moq')::int=1,'summary exposes missing settings');
  perform pg_temp.assert_true((select count(*) from pg_publication_tables where pubname='supabase_realtime')=10,'all business tables published');
  raise notice 'PASS: blocked sleep, dependency wake, priority, error backoff, summary, publication';
end $$;
rollback;
