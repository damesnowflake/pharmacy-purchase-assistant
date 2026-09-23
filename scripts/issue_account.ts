#!/usr/bin/env -S node
// 계정 발급·비활성화 운영 스크립트. FR-01~02, 시스템_구조_설계.md "인증과 서버 경계".
// 마스터/백엔드 개발자만 실행한다. 앱 화면에는 이 기능을 노출하지 않는다.
//
// 사용법:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   npm run issue-account -- --email user@example.com --name "홍길동" --role staff [--deactivate]
//
// SUPABASE_SERVICE_ROLE_KEY는 절대 커밋되는 파일에 넣지 않고 셸 환경변수로만 전달한다. (NFR-07)

import { createClient } from "@supabase/supabase-js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const email = args.email as string | undefined;
  const name = args.name as string | undefined;
  const role = args.role as string | undefined;
  const deactivate = Boolean(args.deactivate);

  if (!email) {
    console.error("--email은 필수입니다.");
    process.exit(1);
  }

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  if (deactivate) {
    const { data: users, error: listError } = await admin.auth.admin.listUsers();
    if (listError) throw listError;
    const user = users.users.find((u) => u.email === email);
    if (!user) {
      console.error(`계정을 찾을 수 없습니다: ${email}`);
      process.exit(1);
      return;
    }
    const { error } = await admin.from("profiles").update({ active: false }).eq("user_id", user.id);
    if (error) throw error;
    console.log(`비활성화 완료: ${email}`);
    return;
  }

  if (!name || (role !== "admin" && role !== "staff")) {
    console.error("신규 발급에는 --name과 --role(admin|staff)이 필요합니다.");
    process.exit(1);
  }

  const tempPassword = crypto.randomUUID();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true,
  });
  if (createError) throw createError;

  const { error: profileError } = await admin.from("profiles").insert({
    user_id: created.user.id,
    display_name: name,
    role,
    active: true,
  });
  if (profileError) throw profileError;

  console.log(`계정 발급 완료: ${email} (${role})`);
  console.log(`임시 비밀번호: ${tempPassword}`);
  console.log("이 비밀번호를 안전한 채널로 본인에게 전달하고, 최초 로그인 후 변경을 요청하세요.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
