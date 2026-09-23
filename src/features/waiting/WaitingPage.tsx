import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";

interface ProductStateRow {
  product_id: string;
  pending_qty: number;
  last_settled_at: string | null;
  products: { name: string; spec: string; base_unit: string } | null;
}

interface ExcessReceiptRow {
  id: string;
  recorded_at: string;
  entity_id: string;
  after: { extra: number } | null;
}

// IR-05 입고 대기·이력: 품목별 발주량·입고량·대기량, 완료 이력과 초과/미연결 입고 표시.
export function WaitingPage() {
  const [tab, setTab] = useState<"pending" | "excess">("pending");

  return (
    <div>
      <div style={{ display: "flex", gap: "4px", marginBottom: "12px" }}>
        <button type="button" onClick={() => setTab("pending")} disabled={tab === "pending"}>
          입고 대기
        </button>
        <button type="button" onClick={() => setTab("excess")} disabled={tab === "excess"}>
          초과/미연결 입고
        </button>
      </div>
      {tab === "pending" ? <PendingPanel /> : <ExcessPanel />}
    </div>
  );
}

function PendingPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["product_state", "pending"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_state")
        .select("product_id, pending_qty, last_settled_at, products(name, spec, base_unit)")
        .gt("pending_qty", 0)
        .order("last_settled_at", { ascending: false });
      if (error) throw error;
      return data as unknown as ProductStateRow[];
    },
  });

  if (isLoading) return <div className="center-message">불러오는 중...</div>;
  if (error) return <div className="center-message error">조회 실패: {(error as Error).message}</div>;
  if (!data || data.length === 0) {
    return <div className="center-message">입고 대기 중인 품목이 없습니다.</div>;
  }

  return (
    <table className="dense-table">
      <thead>
        <tr>
          <th>품목</th>
          <th>규격</th>
          <th className="num">대기 수량</th>
          <th>단위</th>
          <th>마지막 갱신</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r) => (
          <tr key={r.product_id}>
            <td>{r.products?.name ?? r.product_id}</td>
            <td>{r.products?.spec}</td>
            <td className="num">{r.pending_qty}</td>
            <td>{r.products?.base_unit}</td>
            <td>{r.last_settled_at ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 초과/미연결 입고는 recompute_product_state()가 audit_events에
// action='excess_receipt'로 남긴 기록에서 조회한다 (상세_알고리즘_설계.md §8).
function ExcessPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["audit_events", "excess_receipt"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_events")
        .select("id, recorded_at, entity_id, after")
        .eq("action", "excess_receipt")
        .order("recorded_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as unknown as ExcessReceiptRow[];
    },
  });

  if (isLoading) return <div className="center-message">불러오는 중...</div>;
  if (error) return <div className="center-message error">조회 실패: {(error as Error).message}</div>;
  if (!data || data.length === 0) {
    return <div className="center-message">초과/미연결 입고가 없습니다.</div>;
  }

  return (
    <table className="dense-table">
      <thead>
        <tr>
          <th>입고 사건 ID</th>
          <th className="num">초과 수량</th>
          <th>기록 시각</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r) => (
          <tr key={r.id}>
            <td>{r.entity_id}</td>
            <td className="num">{r.after?.extra ?? "-"}</td>
            <td>{r.recorded_at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
