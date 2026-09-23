import { createClient } from "@supabase/supabase-js";

// 공개 가능한 값만 포함한다. 관리자 키·공휴일 API 키는 서버 환경변수에만 둔다. (NFR-07)
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** false면 화면에서 "환경 설정 필요" 안내를 보여줘야 한다 (App.tsx 참고). */
export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured) {
  // eslint-disable-next-line no-console
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 환경변수가 없습니다. .env.example을 참고해 .env.local을 만드세요.",
  );
}

// createClient는 URL이 빈 문자열이면 즉시 예외를 던져 앱 전체가 하얀 화면으로 죽는다. 설정이
// 없을 때도 최소한 "설정 필요" 안내 화면은 뜨도록, 실제로는 쓰이지 않을 자리표시자 URL로 만든다
// (isSupabaseConfigured가 false인 동안 이 클라이언트로 실제 요청을 보내지 않는다).
export const supabase = createClient(
  isSupabaseConfigured ? url : "https://not-configured.invalid",
  isSupabaseConfigured ? anonKey : "not-configured",
);
