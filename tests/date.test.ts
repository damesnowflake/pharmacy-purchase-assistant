import { describe, it, expect } from "vitest";
import { calculateArrivalDate, sevenDayWindow, type HolidayCoverage } from "../src/lib/date";

function coverage(holidays: string[], coveredFrom: string, coveredTo: string): HolidayCoverage {
  const set = new Set(holidays);
  return {
    isCovered: (d) => d >= coveredFrom && d <= coveredTo,
    isOfficialHoliday: (d) => set.has(d),
  };
}

describe("calculateArrivalDate", () => {
  it("토요일 주문, 휴일 없음 -> 화요일 도착 (개발계획.md 핵심 예제)", () => {
    const h = coverage([], "2026-09-01", "2026-09-30");
    expect(calculateArrivalDate("2026-09-12", h)).toBe("2026-09-15");
  });

  it("월요일이 공휴일이면 -> 수요일 도착", () => {
    const h = coverage(["2026-09-14"], "2026-09-01", "2026-09-30");
    expect(calculateArrivalDate("2026-09-12", h)).toBe("2026-09-16");
  });

  it("공휴일 조회 범위 밖이면 도착일을 확정하지 않고 예외를 던진다", () => {
    const h = coverage([], "2026-09-01", "2026-09-13");
    expect(() => calculateArrivalDate("2026-09-12", h)).toThrow();
  });

  it("거래처 휴무일도 함께 제외한다", () => {
    const h = coverage([], "2026-09-01", "2026-09-30");
    const closed = new Set(["2026-09-14"]);
    expect(calculateArrivalDate("2026-09-12", h, closed)).toBe("2026-09-16");
  });
});

describe("sevenDayWindow", () => {
  it("도착일부터 7개 달력일을 반환한다", () => {
    expect(sevenDayWindow("2026-09-15")).toEqual([
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20",
      "2026-09-21",
    ]);
  });
});
