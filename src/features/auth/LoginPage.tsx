import { useState, type FormEvent } from "react";
import { supabase } from "@/lib/supabaseClient";

// IR-01: 사전 발급 로그인 식별자·비밀번호. 신규 가입 버튼 없음.
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(
        error.status === 400
          ? "이메일 또는 비밀번호가 올바르지 않습니다."
          : `로그인 실패: ${error.message}`,
      );
    }
    setSubmitting(false);
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>사입 추천 시스템</h1>
        <p className="login-hint">사전 발급된 계정으로만 로그인할 수 있습니다.</p>
        <label>
          이메일
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          비밀번호
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "로그인 중..." : "로그인"}
        </button>
        <p className="login-hint">
          계정 발급·재설정은 관리자(마스터) 또는 백엔드 개발자에게 문의하세요.
        </p>
      </form>
    </div>
  );
}
