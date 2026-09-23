import { describe, it, expect } from "vitest";
import { lastReceiptAnchorReference, needsReview } from "../src/lib/inventoryAnchor";
import { dateRange } from "../src/lib/date";

describe("lastReceiptAnchorReference (상세_알고리즘_설계.md §10 검증 사례)", () => {
  it("입고 100, 실제판매 80, 도착전 예측수요 20 -> 도착일 말 참고량 0, 검토 대상", () => {
    const B = "2026-09-01";
    const D = "2026-09-10"; // B..D 10일 * 8 = 80
    const A = "2026-09-15"; // 09-11..09-15 5일 * 4 = 20

    const actualDays = new Set(dateRange(B, D));
    const forecastDays = new Set(dateRange("2026-09-11", A));

    const result = lastReceiptAnchorReference({
      latestReceiptDate: B,
      receiptSumOnLatestReceiptDate: 100,
      latestSalesDate: D,
      arrivalDate: A,
      actualSalesByDate: (d) => (actualDays.has(d) ? 8 : undefined),
      forecastByDate: (d) => (forecastDays.has(d) ? 4 : undefined),
    });

    expect(result.actualReflected.value).toBe(20);
    expect(result.arrivalDayEndExpected.value).toBe(0);
    expect(result.arrivalDayEndExpected.dataInsufficient).toBe(false);
    expect(result.arrivalDayEndExpected.forecastUnavailable).toBe(false);
    expect(needsReview(result.arrivalDayEndExpected.value)).toBe(true);
  });

  it("B..D 구간에 판매 업로드 누락일이 있으면 dataInsufficient를 표시한다", () => {
    const B = "2026-09-01";
    const D = "2026-09-05";
    const A = "2026-09-08";

    const result = lastReceiptAnchorReference({
      latestReceiptDate: B,
      receiptSumOnLatestReceiptDate: 50,
      latestSalesDate: D,
      arrivalDate: A,
      actualSalesByDate: (d) => (d === "2026-09-03" ? undefined : 5),
      forecastByDate: () => 2,
    });

    expect(result.arrivalDayEndExpected.dataInsufficient).toBe(true);
  });
});
