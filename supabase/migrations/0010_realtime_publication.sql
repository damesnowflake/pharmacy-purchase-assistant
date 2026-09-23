-- 화면 실시간 갱신 대상 테이블을 Realtime publication에 추가한다.
-- 시스템_구조_설계.md: "변경 알림 후 필요한 자료를 다시 조회" — payload 전체를 그대로 쓰지 않고
-- 변경 신호만 받아 관련 조회를 무효화하는 방식(NFR-03, 개발계획.md)으로 프론트에서 사용한다.
-- `supabase_realtime` publication은 Supabase 프로젝트에 기본 생성되어 있다. 순수 로컬
-- PostgreSQL(SQL 스모크 테스트)에는 없을 수 있으므로 없으면 조용히 건너뛴다.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table recommendations;
    alter publication supabase_realtime add table product_state;
    alter publication supabase_realtime add table sales_coverage;
  else
    raise notice 'supabase_realtime publication이 없어 건너뜁니다. Supabase 프로젝트에는 기본 제공된다.';
  end if;
exception when duplicate_object then
  raise notice '이미 publication에 포함되어 있습니다.';
end $$;
