begin;
create function pg_temp.check_it(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %',msg; end if; end $$;
do $$
declare
  actor uuid:=gen_random_uuid(); pid uuid; imp uuid:=gen_random_uuid(); d date:=(now() at time zone 'Asia/Seoul')::date;
  before_value jsonb; after_value jsonb; answer jsonb; ids uuid[]:='{}'; x integer; p uuid;
begin
  insert into auth.users(id) values(actor);
  insert into profiles(user_id,display_name,role) values(actor,'retention test','admin');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  pid:=(create_product('long lived product','','ea',false,d-400)->>'product_id')::uuid;
  insert into sales_imports(id,file_hash,period_start,period_end,mode,status,parser_version,actor_id)
    values(imp,'retention-fixture',d-300,d,'full_period','applied','test',actor);
  insert into sales_coverage(sale_date,import_id,status)
    select s::date,imp,'complete' from generate_series(d-300,d,interval '1 day') s;
  insert into sales_daily(product_id,sale_date,net_qty,import_id)
    select pid,s::date,2,imp from generate_series(d-250,d,interval '1 day') s;
  perform register_receipt(gen_random_uuid(),(d-250)::timestamp at time zone 'Asia/Seoul',
    jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1000,'unit','ea')));
  perform register_stock_count(gen_random_uuid(),pid,700,(d-220)::timestamp at time zone 'Asia/Seoul','end_of_day');
  before_value:=reference_sales_total(pid,d-250,d);
  perform pg_temp.check_it((before_value->>'net_qty')::numeric=502,'251 days of sales included');
  -- Complete zero-sales days must not be marked as missing.
  perform pg_temp.check_it((reference_sales_total(pid,d-280,d-260)->>'missing_days')::int=0,'observed zero days complete');
  perform rollup_old_sales_daily(200);
  perform pg_temp.check_it(reference_sales_total(pid,d-250,d)=before_value,'first archival preserves reference');
  perform rollup_old_sales_daily(180);
  after_value:=reference_sales_total(pid,d-250,d);
  perform pg_temp.check_it(after_value=before_value,'second archival preserves reference');
  perform pg_temp.check_it((reference_sales_total(pid,d-219,d)->>'net_qty')::numeric=440,'count starts next day, not count date');
  perform pg_temp.check_it((select count(*) from sales_daily where product_id=pid)=180,'exactly 180 days retained');
  perform rollup_old_sales_daily(180);
  perform pg_temp.check_it(reference_sales_total(pid,d-250,d)=before_value,'rerun is idempotent');
  update sales_daily set net_qty=5 where product_id=pid and sale_date=d;
  perform pg_temp.check_it((reference_sales_total(pid,d-250,d)->>'net_qty')::numeric=505,'retained corrections reflected once');
  perform pg_temp.check_it((reference_sales_total(pid,d-240,d)->>'history_unavailable')::boolean,'unknown backdated anchor cannot fabricate stock');
  perform pg_temp.check_it(not (reference_sales_total(pid,d-10,d)->>'history_unavailable')::boolean,'new retained-period count is computable');
  begin
    update sales_imports set status='staging' where id=imp;
    update sales_imports set status='applied' where id=imp;
    raise exception 'FAILED: historical replacement allowed';
  exception when others then
    if sqlerrm not like 'RETIRED_SALES_PERIOD:%' then raise; end if;
  end;
  -- Ranking uses net base-unit quantities in the current 30-day window.
  for x in 1..55 loop
    p:=(create_product('rank product '||x,'','ea',false,d-40)->>'product_id')::uuid;
    ids:=array_append(ids,p);
    insert into sales_daily(product_id,sale_date,net_qty,import_id) values(p,d,100,imp),(p,d-31,10000,imp);
  end loop;
  answer:=sales_priority_summary();
  perform pg_temp.check_it(jsonb_array_length(answer->'products')=50,'top50 bound');
  perform pg_temp.check_it((answer->>'observed_days')::int=30,'coverage counted once per day');
  perform pg_temp.check_it((answer->'products'->0->>'net_qty')::numeric=100,'outside 30-day rows excluded');
  perform pg_temp.check_it((answer->'products'->0->>'product_id')::uuid=(select min(v::text)::uuid from unnest(ids) v),'ties fixed by UUID');
  perform pg_temp.check_it(not has_function_privilege('authenticated','reference_sales_total(uuid,date,date)','execute'),'archive RPC service-only');
  perform pg_temp.check_it(has_function_privilege('authenticated','sales_priority_summary()','execute'),'ranking available to active staff');
  raise notice 'PASS: ranking, archive continuity, corrections, zero days, missing history, ACL';
end $$;
rollback;
