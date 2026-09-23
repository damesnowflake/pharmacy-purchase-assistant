import { describe, it, expect } from "vitest";
import {
  recommendedOrderQuantity,
  InvalidPurchaseTermsError,
} from "../src/lib/recommendation";

describe("recommendedOrderQuantity", () => {
  it("MOQ 10, 7일 수요 23, 발주 단위 6 -> 24 (FR-26 예제)", () => {
    expect(recommendedOrderQuantity({ moq: 10, orderStep: 6 }, 23)).toBe(24);
  });

  it("MOQ 30, 7일 수요 23, 발주 단위 6 -> 30 (상세_알고리즘_설계.md §7 예제)", () => {
    expect(recommendedOrderQuantity({ moq: 30, orderStep: 6 }, 23)).toBe(30);
  });

  it("일 10개 예상 * 7일, MOQ 10, 단위 1 -> 70 (개발계획.md 예제)", () => {
    expect(recommendedOrderQuantity({ moq: 10, orderStep: 1 }, 70)).toBe(70);
  });

  it("MOQ 또는 단위가 없거나 0 이하이면 임의로 확정하지 않고 예외를 던진다", () => {
    expect(() => recommendedOrderQuantity({ moq: 0, orderStep: 6 }, 23)).toThrow(
      InvalidPurchaseTermsError,
    );
    expect(() => recommendedOrderQuantity({ moq: 10, orderStep: 0 }, 23)).toThrow(
      InvalidPurchaseTermsError,
    );
  });

  it("부동소수 오차로 단위가 한 번 더 붙지 않는다", () => {
    // 0.1 + 0.2 스타일의 오차가 나기 쉬운 조합
    expect(recommendedOrderQuantity({ moq: 1, orderStep: 0.1 }, 2.3)).toBeCloseTo(2.3, 6);
  });
});
