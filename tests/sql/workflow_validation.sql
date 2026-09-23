begin;
create or replace function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'FAILED: %',message; end if;
end $$;
do $$
declare
  admin_id uuid:=gen_random_uuid(); staff_id uuid:=gen_random_uuid();
  pid uuid; sid uuid:=gen_random_uuid(); rid uuid; iid uuid; req uuid:=gen_random_uuid();
  response jsonb; first_response jsonb; rev bigint; count_id uuid; error_text text;
begin
  insert into auth.users(id) values(admin_id),(staff_id);
  insert into profiles(user_id,display_name,role) values(admin_id,'test admin','admin'),(staff_id,'test staff','staff');
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  pid:=(create_product('flow sample','','ea',false,current_date-179,'[]',10,1)->>'product_id')::uuid;
  insert into suppliers(id,name) values(sid,'test supplier');
  perform save_product_unit(pid,'box',10,false);
  iid:=(begin_sales_import(current_date-1,current_date-1,'validation-unique-file','full_period')->>'import_id')::uuid;
  perform stage_sales_rows(iid,0,jsonb_build_array(
    jsonb_build_object('row_no',1,'product_id',pid,'sale_date',current_date-1,'net_qty',3),
    jsonb_build_object('row_no',2,'product_id',pid,'sale_date',current_date-1,'net_qty',4)));
  first_response:=commit_sales_import(iid,2);
  response:=commit_sales_import(iid,2);
  perform pg_temp.assert_true(response=first_response,'sales commit retry returns same result');
  perform pg_temp.assert_true((select net_qty from sales_daily where product_id=pid)=7,'daily aggregation 3+4=7');
  perform pg_temp.assert_true((select count(*) from sales_daily where product_id=pid)=1,'one product/day');
  raise notice 'PASS: sales stage -> aggregate -> commit -> retry';

  insert into recommendations(product_id,arrival_date,recommended_qty,basis_json,input_revision)
    values(pid,current_date+2,100,'{}',1) returning id,version into rid,rev;
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  begin
    perform confirm_order(gen_random_uuid(),rid,rev,pid,sid,100,'ea',current_date);
    raise exception 'FAILED: staff must not order';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform confirm_order(gen_random_uuid(),rid,rev,pid,sid,100,'ea',current_date);
  perform set_config('request.jwt.claim.sub',staff_id::text,true);
  first_response:=register_receipt(req,now(),jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',6,'unit','box')));
  response:=register_receipt(req,now(),jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',6,'unit','box')));
  perform pg_temp.assert_true(response=first_response,'receipt retry returns same result');
  perform pg_temp.assert_true((select pending_qty from product_state where product_id=pid)=40,'100 ordered - 6 boxes = 40 pending');
  perform pg_temp.assert_true((select status from recommendations where id=rid)='waiting','partial receipt stays waiting');
  perform register_receipt(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',4,'unit','box')));
  perform pg_temp.assert_true((select pending_qty from product_state where product_id=pid)=0,'remaining four boxes settle');
  perform pg_temp.assert_true((select status from recommendations where id=rid)='received','complete receipt closes');
  raise notice 'PASS: role enforcement; order100 -> receipt60 -> duplicate retry -> receipt40 -> received';

  perform register_receipt(gen_random_uuid(),now(),jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',5,'unit','ea')));
  perform pg_temp.assert_true(exists(select 1 from quantity_events where product_id=pid and excess_qty_base=5),'excess five visible');
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform confirm_order(gen_random_uuid(),null,null,pid,sid,10,'ea',current_date);
  perform pg_temp.assert_true((select pending_qty from product_state where product_id=pid)=10,'old excess does not consume future order');
  perform cancel_order(gen_random_uuid(),pid,4,'test partial cancel');
  perform pg_temp.assert_true((select pending_qty from product_state where product_id=pid)=6,'partial cancellation');
  perform cancel_order(gen_random_uuid(),pid,6,'test full cancel');
  perform pg_temp.assert_true((select pending_qty from product_state where product_id=pid)=0,'full cancellation');
  raise notice 'PASS: excess receipt, manual order, partial/full cancellation';

  response:=register_stock_count(gen_random_uuid(),pid,0,now(),'end_of_day');
  perform pg_temp.assert_true(exists(select 1 from quantity_events where product_id=pid and kind='count' and qty_base=0),'zero count accepted');
  perform register_stock_count(gen_random_uuid(),pid,10,now(),'end_of_day');
  select id into count_id from quantity_events where product_id=pid and kind='count' and qty_base=10;
  begin
    perform revise_quantity_event(gen_random_uuid(),count_id,1,false,0,'ea',now(),'confirm zero');
    raise notice 'PASS: zero count correction';
  exception when invalid_parameter_value then
    raise exception 'FAILED: zero count correction rejected: %',sqlerrm;
  end;
  -- A failed guard is reported, not treated as a successful acceptance test.
  perform confirm_order(gen_random_uuid(),null,null,pid,sid,10,'ea',current_date);
  begin
    perform cancel_order(gen_random_uuid(),pid,100,'over-cancel probe');
    raise exception 'FAILED: server accepted cancellation 100 while pending 10';
  exception when invalid_parameter_value then
    raise notice 'PASS: over-cancellation rejected';
  end;
end $$;
rollback;
