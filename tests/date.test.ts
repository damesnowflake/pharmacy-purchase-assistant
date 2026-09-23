import { describe, it, expect } from "vitest";
import { calculateArrivalDate, sevenDayWindow, getBusinessDate, type HolidayCoverage } from "../src/lib/date";

describe("getBusinessDate", () => {
  it("한국 오전 9시 이전은 UTC 기준 전날이어도 한국 날짜 그대로 반환한다", () => {
    // UTC 2026-09-22 20:00 == KST 2026-09-23 05:00. UTC 기준으로 자르면 09-22가 나와야 정상인
    // 버그가 재현되고, 이 함수는 09-23을 반환해야 한다.
    expect(getBusinessDate(new Date("2026-09-22T20:00:00Z"))).toBe("2026-09-23");
  });

  it("한국 자정 직후는 다음 날로 넘어간다", () => {
    // UTC 2026-12-31 15:00 == KST 2027-01-01 00:00
    expect(getBusinessDate(new Date("2026-12-31T15:00:00Z"))).toBe("2027-01-01");
  });

  it("UTC와 한국 날짜가 같은 낮 시간에는 그대로 일치한다", () => {
    // UTC 2026-09-23 03:00 == KST 2026-09-23 12:00
    expect(getBusinessDate(new Date("2026-09-23T03:00:00Z"))).toBe("2026-09-23");
  });
});

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
