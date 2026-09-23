import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabaseClient";
import { getBusinessDate } from "./date";

export interface SalesPrioritySummary {
  window_start: string;
  window_end: string;
  observed_days: number;
  products: { product_id: string; name: string; spec: string; rank: number; net_qty: number; partial_window: boolean }[];
}
export function useSalesPriority() {
  return useQuery({
    queryKey: ["sales_priority", getBusinessDate()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("sales_priority_summary");
      if (error) throw error;
      return data as SalesPrioritySummary;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export function salesPriorityLabel(summary: SalesPrioritySummary | undefined, productId: string): string {
  if (!summary) return "판매 순위 확인 중 — 필요 시 실사";
  const ranked = summary.products.find(p => p.product_id === productId);
  const partial = summary.observed_days < 30 || ranked?.partial_window;
  return ranked
    ? `판매 상위 50 · ${ranked.rank}위 · 통계 참고${partial ? " (30일 자료 미완성)" : ""}`
    : `실사 권장${partial ? " (30일 자료 미완성)" : ""}`;
}
