import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { subscribeBusinessChanges } from "../src/lib/businessRealtime";

describe("business Realtime recovery", () => {
  let handlers: Record<string, () => void>;
  let status: (state: string) => void;
  let cleanup: () => void;
  const invalidateQueries = vi.fn();
  const onState = vi.fn();
  const removeChannel = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); handlers = {};
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    const channel = {
      on: (_event: string, filter: { table: string }, fn: () => void) => { handlers[filter.table] = fn; return channel; },
      subscribe: (fn: typeof status) => { status = fn; return channel; },
    };
    cleanup = subscribeBusinessChanges({ channel: () => channel, removeChannel } as unknown as SupabaseClient,
      { invalidateQueries }, onState);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("refreshes history and excess receipts on business changes", () => {
    handlers.quantity_events(); handlers.product_state();
    vi.advanceTimersByTime(110);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["movement_history"] });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["excess_receipts"] });
    expect(invalidateQueries.mock.calls.filter(([v]) => v.queryKey[0] === "movement_history")).toHaveLength(1);
  });
  it("watches product aliases, units and supplier changes", () => {
    handlers.product_aliases(); handlers.product_units(); handlers.suppliers();
    vi.advanceTimersByTime(110);
    for (const key of ["products", "product_units", "suppliers"])
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [key] });
  });
  it("polls while disconnected, refreshes on reconnect and stops polling", () => {
    status("CHANNEL_ERROR");
    expect(onState).toHaveBeenLastCalledWith("retrying");
    vi.advanceTimersByTime(30_110);
    expect(invalidateQueries).toHaveBeenCalled();
    invalidateQueries.mockClear(); status("SUBSCRIBED"); vi.advanceTimersByTime(110);
    expect(onState).toHaveBeenLastCalledWith("connected");
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["movement_history"] });
    invalidateQueries.mockClear(); vi.advanceTimersByTime(60_000);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });
  it("refreshes after returning to the app", () => {
    window.dispatchEvent(new Event("online")); vi.advanceTimersByTime(110);
    expect(invalidateQueries).toHaveBeenCalled();
  });
  it("does not create timers or queries after cleanup", () => {
    cleanup(); invalidateQueries.mockClear(); status("CLOSED");
    vi.advanceTimersByTime(90_000);
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
