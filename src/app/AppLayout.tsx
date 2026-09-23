import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import { useRealtimeInvalidate } from "@/lib/useRealtimeInvalidate";

// 시스템_구조_설계.md: 상단 검색·판매자료 기준일, 중앙 표, 다크/라이트 테마.
export function AppLayout() {
  const { profile, signOut } = useAuth();
  useRealtimeInvalidate(Boolean(profile?.active));

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">사입 추천 시스템</span>
        <nav className="app-nav">
          <NavLink to="/review">사입 검토</NavLink>
          <NavLink to="/waiting">입고 대기·이력</NavLink>
          <NavLink to="/receipts">입고 등록</NavLink>
          <NavLink to="/sales">판매 업로드</NavLink>
          {profile?.role === "admin" && <NavLink to="/settings">설정</NavLink>}
        </nav>
        <div className="app-user">
          <span>{profile?.display_name ?? ""}</span>
          <span className="role-badge">{profile?.role === "admin" ? "관리자" : "직원"}</span>
          <button onClick={signOut}>로그아웃</button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
