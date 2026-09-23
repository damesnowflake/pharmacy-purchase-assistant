import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabaseClient";

// 시스템_구조_설계.md: "변경 알림 후 필요한 자료를 다시 조회" — Realtime 페이로드를 화면에 직접
// 반영하지 않고, 변경 신호만 받아 관련 TanStack Query 캐시를 무효화해 다시 조회하게 한다.
// 대상 테이블은 supabase/migrations/0010_realtime_publication.sql에서 publication에 추가했다.
const WATCHED_TABLES: Array<{ table: string; queryKeyPrefix: string }> = [
  { table: "recommendations", queryKeyPrefix: "recommendations" },
  { table: "product_state", queryKeyPrefix: "product_state" },
  { table: "sales_coverage", queryKeyPrefix: "sales_coverage" },
];

export function useRealtimeInvalidate(enabled: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    const channel = supabase.channel("business-data-changes");
    for (const { table, queryKeyPrefix } of WATCHED_TABLES) {
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          queryClient.invalidateQueries({ queryKey: [queryKeyPrefix] });
        },
      );
    }
    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled, queryClient]);
}
