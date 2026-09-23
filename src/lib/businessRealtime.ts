import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueryClient } from "@tanstack/react-query";

export type ConnectionState = "connecting" | "connected" | "retrying";
export const BUSINESS_CHANGE_KEYS: Record<string, string[]> = {
  recommendations: ["recommendations", "calc_status_summary"],
  product_state: ["product_state", "recommendations", "calc_status_summary", "movement_history", "excess_receipts"],
  quantity_events: ["product_state", "movement_history", "excess_receipts", "recommendations", "calc_status_summary"],
  sales_coverage: ["sales_coverage", "recommendations", "calc_status_summary"],
  products: ["products", "product_state", "recommendations", "calc_status_summary", "movement_history", "excess_receipts"],
  product_aliases: ["products"],
  product_units: ["product_units", "products"],
  suppliers: ["suppliers", "movement_history"],
  purchase_terms: ["products", "recommendations"],
  supplier_closed_dates: ["supplier_closed_dates", "recommendations"],
};

export function subscribeBusinessChanges(
  client: SupabaseClient, cache: Pick<QueryClient, "invalidateQueries">,
  onState: (state: ConnectionState) => void,
) {
  let disposed = false;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  const invalidate = (keys: string[]) => {
    if (disposed) return;
    keys.forEach((key) => pending.add(key));
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      for (const key of pending) void cache.invalidateQueries({ queryKey: [key] });
      pending.clear();
    }, 100);
  };
  const allKeys = [...new Set(Object.values(BUSINESS_CHANGE_KEYS).flat())];
  const refresh = () => invalidate(allKeys);
  const visibility = () => { if (document.visibilityState === "visible") refresh(); };
  onState("connecting");
  // Poll until first subscribe as well: failed handshakes must not freeze the screen.
  fallback = setInterval(refresh, 30_000);
  const channel = client.channel("business-data-changes");
  for (const [table, keys] of Object.entries(BUSINESS_CHANGE_KEYS)) {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, () => invalidate(keys));
  }
  channel.subscribe((status) => {
    if (disposed) return;
    if (status === "SUBSCRIBED") {
      if (fallback) clearInterval(fallback);
      fallback = undefined;
      onState("connected");
      refresh(); // Includes changes missed while disconnected.
    } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
      onState("retrying");
      if (!fallback) fallback = setInterval(refresh, 30_000);
      // Supabase owns websocket/channel reconnect and JWT refresh; don't create duplicate channels.
    }
  });
  window.addEventListener("online", refresh);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    disposed = true;
    if (fallback) clearInterval(fallback);
    if (debounce) clearTimeout(debounce);
    window.removeEventListener("online", refresh);
    document.removeEventListener("visibilitychange", visibility);
    void client.removeChannel(channel);
  };
}
