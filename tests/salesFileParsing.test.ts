import { describe, it, expect } from "vitest";
import { parseFlexibleDate, parseFlexibleQuantity, normalizeAliasText } from "../src/lib/salesFileParsing";

describe("parseFlexibleDate", () => {
  it("Date 객체를 IsoDate로 변환한다", () => {
    expect(parseFlexibleDate(new Date(Date.UTC(2026, 8, 23)))).toBe("2026-09-23");
  });
  it("잘못된 Date는 null", () => {
    expect(parseFlexibleDate(new Date("invalid"))).toBeNull();
  });
  it("YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD 문자열을 처리한다", () => {
    expect(parseFlexibleDate("2026-09-23")).toBe("2026-09-23");
    expect(parseFlexibleDate("2026.09.23")).toBe("2026-09-23");
    expect(parseFlexibleDate("2026/9/3")).toBe("2026-09-03");
  });
  it("YYYYMMDD 문자열을 처리한다", () => {
    expect(parseFlexibleDate("20260923")).toBe("2026-09-23");
  });
  it("엑셀 시리얼 숫자를 처리한다 (2026-09-23 -> 46288)", () => {
    expect(parseFlexibleDate(46288)).toBe("2026-09-23");
  });
  it("해석할 수 없는 값은 null이며 임의 날짜로 바꾸지 않는다", () => {
    expect(parseFlexibleDate("모름")).toBeNull();
    expect(parseFlexibleDate("")).toBeNull();
    expect(parseFlexibleDate(undefined)).toBeNull();
  });
});

describe("parseFlexibleQuantity", () => {
  it("숫자는 그대로 반환한다", () => {
    expect(parseFlexibleQuantity(10)).toBe(10);
  });
  it("천단위 구분자와 공백을 제거한다", () => {
    expect(parseFlexibleQuantity("1,234")).toBe(1234);
    expect(parseFlexibleQuantity(" 12 ")).toBe(12);
  });
  it("음수(반품)도 허용한다", () => {
    expect(parseFlexibleQuantity("-5")).toBe(-5);
  });
  it("해석 불가는 null", () => {
    expect(parseFlexibleQuantity("품절")).toBeNull();
    expect(parseFlexibleQuantity("")).toBeNull();
  });
});

describe("normalizeAliasText", () => {
  it("공백 제거와 소문자화를 한다", () => {
    expect(normalizeAliasText(" Tylenol   500mg ")).toBe("tylenol500mg");
  });
});
