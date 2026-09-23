import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";

interface CapacityStatus {
  db_bytes: number;
  db_limit_bytes: number;
  ratio: number;
  level: "ok" | "warning" | "critical";
  sales_daily_rows: number;
  quantity_events_rows: number;
  products_count: number;
  measured_at: string;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// 개발계획.md "무료 플랜 용량 구현 기준": DB 500MB의 70%/85% 도달 시 경고.
export function CapacityPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["capacity_status"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("capacity_status");
      if (error) throw error;
      return data as CapacityStatus;
    },
    staleTime: 60_000,
  });

  if (isLoading) return <div className="center-message">불러오는 중...</div>;
  if (error) return <div className="center-message error">조회 실패: {(error as Error).message}</div>;
  if (!data) return null;

  return (
    <div>
      <h3>Supabase 무료 플랜 용량</h3>
      <p className={data.level !== "ok" ? "form-message error-text" : "form-message"}>
        DB 사용량 {formatMb(data.db_bytes)} / {formatMb(data.db_limit_bytes)} (
        {(data.ratio * 100).toFixed(1)}%) —{" "}
        {data.level === "ok" ? "정상" : data.level === "warning" ? "70% 도달: 원인 조사 필요" : "85% 도달: 신규 적재 전망 검토 필요"}
      </p>
      <table className="dense-table">
        <tbody>
          <tr>
            <td>일별 판매 행 수</td>
            <td className="num">{data.sales_daily_rows.toLocaleString()}</td>
          </tr>
          <tr>
            <td>수량 사건(입고·발주·실사) 행 수</td>
            <td className="num">{data.quantity_events_rows.toLocaleString()}</td>
          </tr>
          <tr>
            <td>활성 품목 수</td>
            <td className="num">{data.products_count.toLocaleString()}</td>
          </tr>
        </tbody>
      </table>
      <p className="form-message">측정 시각: {data.measured_at}</p>
    </div>
  );
}
