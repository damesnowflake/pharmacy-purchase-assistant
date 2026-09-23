-- holiday-sync·forecast-batch 정기 자동 호출 등록. 시스템_구조_설계.md "계산과 정기 작업":
-- 매일 한국시간 02:00 공휴일 동기화. forecast-batch는 판매 업로드 직후 프론트에서 즉시
-- 호출하므로(SalesUploadPage.tsx), 여기서는 놓친 항목을 처리하는 보조 수단으로 10분마다
-- 예약한다. anon key는 공개 가능한 값이라(브라우저 번들에도 포함됨) 커밋해도 안전하다.
--
-- pg_net은 Supabase 프로젝트에는 기본 제공되지만 순수 로컬 PostgreSQL(SQL 스모크 테스트)에는
-- 없을 수 있어, 0008과 같은 방식으로 없으면 건너뛴다.
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net 확장을 사용할 수 없어 건너뜁니다: %', sqlerrm;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then

    if not exists (select 1 from cron.job where jobname = 'holiday-sync-0200-kst') then
      perform cron.schedule(
        'holiday-sync-0200-kst',
        '0 17 * * *', -- UTC 17:00 = KST 02:00 (익일)
        $sql$
        select net.http_post(
          url := 'https://sotfjvjrtnnfgqsuxbgq.supabase.co/functions/v1/holiday-sync',
          headers := jsonb_build_object(
            'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNvdGZqdmpydG5uZmdxc3V4YmdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMzcyMzMsImV4cCI6MjEwNTcxMzIzM30.ASOQERPr7Fppb8yyIEgHr2OXcIP-WfrQ6Qc9hoIHRWA',
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb
        );
        $sql$
      );
    end if;

    if not exists (select 1 from cron.job where jobname = 'forecast-batch-every-10min') then
      perform cron.schedule(
        'forecast-batch-every-10min',
        '*/10 * * * *',
        $sql$
        select net.http_post(
          url := 'https://sotfjvjrtnnfgqsuxbgq.supabase.co/functions/v1/forecast-batch',
          headers := jsonb_build_object(
            'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNvdGZqdmpydG5uZmdxc3V4YmdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxMzcyMzMsImV4cCI6MjEwNTcxMzIzM30.ASOQERPr7Fppb8yyIEgHr2OXcIP-WfrQ6Qc9hoIHRWA',
            'Content-Type', 'application/json'
          ),
          body := '{}'::jsonb
        );
        $sql$
      );
    end if;
  else
    raise notice 'pg_cron 또는 pg_net이 없어 Edge Function 정기 호출 등록을 건너뜁니다.';
  end if;
end $$;
