begin;
select * from claim_recompute_batch(20,300);
\echo WORKER_A_CLAIMED
select pg_sleep(2);
commit;
