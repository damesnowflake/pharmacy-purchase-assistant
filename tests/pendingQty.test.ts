import { describe, it, expect } from "vitest";
import { computePendingQty, type QuantityEvent } from "../src/lib/pendingQty";

function ev(
  kind: QuantityEvent["kind"],
  quantity: number,
  occurredAt: string,
  recordedSeq: number,
): QuantityEvent {
  return { id: `${kind}-${recordedSeq}`, kind, quantity, occurredAt, recordedSeq };
}

describe("computePendingQty (상세_알고리즘_설계.md §8 사건 표)", () => {
  it("발주 10 -> 입고 6 => 대기 4", () => {
    const r = computePendingQty([
      ev("order", 10, "2026-09-01T00:00:00+09:00", 1),
      ev("receipt", 6, "2026-09-02T00:00:00+09:00", 2),
    ]);
    expect(r.pending).toBe(4);
  });

  it("발주 10 -> 입고 6 -> 입고 4 => 대기 0", () => {
    const r = computePendingQty([
      ev("order", 10, "2026-09-01T00:00:00+09:00", 1),
      ev("receipt", 6, "2026-09-02T00:00:00+09:00", 2),
      ev("receipt", 4, "2026-09-03T00:00:00+09:00", 3),
    ]);
    expect(r.pending).toBe(0);
  });

  it("발주 10 -> 입고 12 -> 발주 5 => 대기 5, 초과 2 표시", () => {
    const r = computePendingQty([
      ev("order", 10, "2026-09-01T00:00:00+09:00", 1),
      ev("receipt", 12, "2026-09-02T00:00:00+09:00", 2),
      ev("order", 5, "2026-09-03T00:00:00+09:00", 3),
    ]);
    expect(r.pending).toBe(5);
    expect(r.excessByReceiptEventId.get("receipt-2")).toBe(2);
  });

  it("입고 3 -> 발주 5 => 대기 5, 첫 입고는 미연결 3", () => {
    const r = computePendingQty([
      ev("receipt", 3, "2026-09-01T00:00:00+09:00", 1),
      ev("order", 5, "2026-09-02T00:00:00+09:00", 2),
    ]);
    expect(r.pending).toBe(5);
    expect(r.excessByReceiptEventId.get("receipt-1")).toBe(3);
  });

  it("발주 10 -> 입고 6 -> 잔량 취소 4 => 대기 0", () => {
    const r = computePendingQty([
      ev("order", 10, "2026-09-01T00:00:00+09:00", 1),
      ev("receipt", 6, "2026-09-02T00:00:00+09:00", 2),
      ev("order_cancel", 4, "2026-09-03T00:00:00+09:00", 3),
    ]);
    expect(r.pending).toBe(0);
    expect(r.cancelReviewWarnings).toEqual([]);
  });

  it("남은 대기량보다 큰 취소는 정정 검토 경고를 남긴다", () => {
    const r = computePendingQty([
      ev("order", 10, "2026-09-01T00:00:00+09:00", 1),
      ev("receipt", 6, "2026-09-02T00:00:00+09:00", 2),
      ev("order_cancel", 10, "2026-09-03T00:00:00+09:00", 3),
    ]);
    expect(r.pending).toBe(0);
    expect(r.cancelReviewWarnings.length).toBe(1);
  });

  it("count/stock_adjustment는 pending에 영향을 주지 않는다", () => {
    const r = computePendingQty([
      ev("order", 10, "2026-09-01T00:00:00+09:00", 1),
      ev("count", 999, "2026-09-01T12:00:00+09:00", 2),
      ev("stock_adjustment", -5, "2026-09-01T13:00:00+09:00", 3),
    ]);
    expect(r.pending).toBe(10);
  });
});
