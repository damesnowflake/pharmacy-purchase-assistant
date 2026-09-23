import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import { LoginPage } from "@/features/auth/LoginPage";
import { AppLayout } from "./AppLayout";
import { ReviewPage } from "@/features/review/ReviewPage";
import { ReceiptsPage } from "@/features/receipts/ReceiptsPage";
import { SalesUploadPage } from "@/features/sales/SalesUploadPage";
import { WaitingPage } from "@/features/waiting/WaitingPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { isSupabaseConfigured } from "@/lib/supabaseClient";

function RequireActiveAccount({ children }: { children: React.ReactNode }) {
  const { session, profile, loading } = useAuth();
  if (loading) return <div className="center-message">불러오는 중...</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (profile && !profile.active) {
    return <div className="center-message">계정이 비활성화되었습니다. 관리자에게 문의하세요.</div>;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  if (profile && profile.role !== "admin") {
    return <div className="center-message">관리자만 접근할 수 있습니다.</div>;
  }
  return <>{children}</>;
}

export function App() {
  if (!isSupabaseConfigured) {
    return (
      <div className="center-message">
        Supabase 연결 설정(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)이 없습니다. 배포 환경변수를
        확인해 주세요.
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireActiveAccount>
            <AppLayout />
          </RequireActiveAccount>
        }
      >
        <Route index element={<Navigate to="review" replace />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="receipts" element={<ReceiptsPage />} />
        <Route path="sales" element={<SalesUploadPage />} />
        <Route path="waiting" element={<WaitingPage />} />
        <Route
          path="settings"
          element={
            <RequireAdmin>
              <SettingsPage />
            </RequireAdmin>
          }
        />
      </Route>
    </Routes>
  );
}
