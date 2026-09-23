import { describe, it, expect } from "vitest";
import {
  parseFlexibleDate,
  parseFlexibleQuantity,
  normalizeAliasText,
  findDateGaps,
  classifySalesRows,
  decodeCsvBytes,
  type ParsedSalesRow,
} from "../src/lib/salesFileParsing";

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

describe("findDateGaps", () => {
  it("구간 내 자료가 없는 날짜를 모두 찾는다 (전체기간 complete 오판 방지)", () => {
    const present = new Set(["2026-09-01", "2026-09-03"]);
    expect(findDateGaps(present, "2026-09-01", "2026-09-03")).toEqual(["2026-09-02"]);
  });

  it("빈틈이 없으면 빈 배열", () => {
    const present = new Set(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(findDateGaps(present, "2026-09-01", "2026-09-03")).toEqual([]);
  });
});

describe("decodeCsvBytes (실제 CatPOS 판매내역 표본에서 확인한 인코딩 문제)", () => {
  it("BOM 없는 UTF-8 바이트를 올바르게 디코드한다", () => {
    const bytes = new TextEncoder().encode("판매일자,품목,수량");
    expect(decodeCsvBytes(bytes)).toBe("판매일자,품목,수량");
  });

  it("EUC-KR(CP949 계열) 바이트는 UTF-8로 깨지는 대신 EUC-KR로 폴백해 읽는다", () => {
    // "판매일자"의 EUC-KR 바이트열 (iconv -f UTF-8 -t EUC-KR로 생성해 고정값으로 박아 둠)
    const eucKrBytes = new Uint8Array([0xc6, 0xc7, 0xb8, 0xc5, 0xc0, 0xcf, 0xc0, 0xda]);
    expect(decodeCsvBytes(eucKrBytes)).toBe("판매일자");
  });
});

describe("classifySalesRows (FR-06: 잘못된 거래 행을 조용히 누락하지 않는다)", () => {
  const PRODUCT_A = "prod-a";

  function row(overrides: Partial<ParsedSalesRow>): ParsedSalesRow {
    return { rowNo: 1, rawItem: "타이레놀", isoDate: "2026-09-01", qty: 10, ...overrides };
  }

  it("품목이 확인됐고 날짜·수량이 정상이면 valid로 분류한다", () => {
    const r = classifySalesRows([row({ rowNo: 1 })], { 타이레놀: PRODUCT_A }, {});
    expect(r.valid).toEqual([{ rowNo: 1, productId: PRODUCT_A, saleDate: "2026-09-01", netQty: 10 }]);
    expect(r.blocking).toEqual([]);
  });

  it("품목은 확인됐는데 날짜를 해석할 수 없으면 조용히 빠뜨리지 않고 blocking으로 분류한다", () => {
    const r = classifySalesRows(
      [row({ rowNo: 2, isoDate: null })],
      { 타이레놀: PRODUCT_A },
      {},
    );
    expect(r.valid).toEqual([]);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].rowNo).toBe(2);
  });

  it("품목은 확인됐는데 수량을 해석할 수 없으면 blocking으로 분류한다", () => {
    const r = classifySalesRows([row({ rowNo: 3, qty: null })], { 타이레놀: PRODUCT_A }, {});
    expect(r.blocking.map((b) => b.rowNo)).toEqual([3]);
  });

  it("품목명이 비어 있어도 날짜·수량 값이 있으면(완전히 빈 행이 아니면) blocking으로 분류한다", () => {
    const r = classifySalesRows([row({ rowNo: 4, rawItem: "" })], {}, {});
    expect(r.blocking.map((b) => b.rowNo)).toEqual([4]);
  });

  it("dateText override로 값을 고치면 valid로 넘어간다", () => {
    const r = classifySalesRows(
      [row({ rowNo: 5, isoDate: null })],
      { 타이레놀: PRODUCT_A },
      { 5: { dateText: "2026-09-05" } },
    );
    expect(r.blocking).toEqual([]);
    expect(r.valid[0].saleDate).toBe("2026-09-05");
  });

  it("excluded로 명시적으로 표시하면 blocking에서 빠지고 excludedByUser에 집계된다", () => {
    const r = classifySalesRows(
      [row({ rowNo: 6, qty: null })],
      { 타이레놀: PRODUCT_A },
      { 6: { excluded: true } },
    );
    expect(r.blocking).toEqual([]);
    expect(r.excludedByUser).toBe(1);
  });

  it("직원이 품목명 자체를 건너뛰기로 확인한 행은 valid도 blocking도 아니고 skippedByItemChoice로 집계된다", () => {
    const r = classifySalesRows([row({ rowNo: 7, rawItem: "합계" })], { 합계: "skip" }, {});
    expect(r.valid).toEqual([]);
    expect(r.blocking).toEqual([]);
    expect(r.skippedByItemChoice).toBe(1);
  });

  it("아직 품목 매칭이 안 된 행(itemMatches에 키 없음)은 valid/blocking 어디에도 넣지 않는다 (매칭 단계에서 막힘)", () => {
    const r = classifySalesRows([row({ rowNo: 8, rawItem: "미등록품목" })], {}, {});
    expect(r.valid).toEqual([]);
    expect(r.blocking).toEqual([]);
  });
});
