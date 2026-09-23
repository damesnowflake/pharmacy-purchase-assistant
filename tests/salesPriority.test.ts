import { describe, it, expect } from "vitest";
import { rankTopProducts, rankingWindowDates } from "../src/lib/salesRanking";

describe("30-day sales priority", () => {
  it("판매가 없는 품목을 임의로 상위 품목으로 분류하지 않는다", () => {
    expect(rankTopProducts([{ productId: "a", observedSum: 0, observedDays: 30 }])[0].isTop50).toBe(false);
  });
  it("32-day input period uses the final 30 days, not the full file", () => {
    const days = rankingWindowDates("2026-09-23");
    expect(days).toHaveLength(30);
    expect(days[0]).toBe("2026-08-25");
  });
  it("50-item boundary and ties are stable, incomplete observation is labelled", () => {
    const input = Array.from({ length: 55 }, (_, i) => ({ productId: String(i).padStart(2,"0"), observedSum: 5, observedDays: 15 }));
    const ranked = rankTopProducts(input.reverse());
    expect(ranked.filter(p => p.isTop50)).toHaveLength(50);
    expect(ranked[49].productId).toBe("49");
    expect(ranked[50].isTop50).toBe(false);
    expect(ranked.every(p => p.isPartialWindow)).toBe(true);
  });
});
