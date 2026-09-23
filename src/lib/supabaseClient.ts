import { createClient } from "@supabase/supabase-js";

// 공개 가능한 값만 포함한다. 관리자 키·공휴일 API 키는 서버 환경변수에만 둔다. (NFR-07)
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 환경변수가 없습니다. .env.example을 참고해 .env.local을 만드세요.",
  );
}

export const supabase = createClient(url ?? "", anonKey ?? "");
