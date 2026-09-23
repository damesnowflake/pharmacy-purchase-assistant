import { describe, it, expect } from "vitest";
import {
  detectCatposTalkFileColumns,
  parseCatposTalkFileRows,
  type CatposColumnIndexes,
} from "../src/lib/catposTalkFileParser";

// 헤더 순서·이름은 실제 판매내역 표본(TalkFile_판매내역_20260801-20260831, 저장소에는 없음)에서
// 그대로 가져왔다. 아래 데이터 값 자체는 실제 거래가 아닌 합성 예시다.
const HEADER = [
  "no",
  "판매일자",
  "시간",
  "판매가",
  "할인",
  "택스리펀",
  "매출액",
  "공급가",
  "부가세",
  "판매상품",
  "구입가",
  "순이익",
  "이익률(%)",
  "거래구분",
  "고객명",
  "판매자",
  "원승인일자",
];

function detailLine(name: string, unitPrice: number, discount: number, qty: number, amount: number): string {
  return `\u3000└ 상품명: ${name} | 판매단가: ${unitPrice.toLocaleString()} | 할인: ${discount} | 수량: ${qty} | 판매금액: ${amount.toLocaleString()}`;
}

function txnRow(no: number, date: string, product: string, payment: string): unknown[] {
  return [no, date, "10:00:00", 0, 0, 0, 0, 0, 0, product, 0, 0, 0, payment, null, "대표자", null];
}

describe("detectCatposTalkFileColumns", () => {
  it("실제 표본과 같은 헤더면 열 인덱스를 찾는다", () => {
    const idx = detectCatposTalkFileColumns(HEADER);
    expect(idx).toEqual<CatposColumnIndexes>({ no: 0, date: 1, product: 9, payment: 13 });
  });

  it("필수 열이 없으면 null을 반환해 범용 가져오기로 넘긴다", () => {
    expect(detectCatposTalkFileColumns(["날짜", "품목", "수량"])).toBeNull();
  });
});

describe("parseCatposTalkFileRows", () => {
  const columns = detectCatposTalkFileColumns(HEADER)!;

  it("합계 행을 건너뛰고 단일 품목 거래를 파싱한다", () => {
    const rows: unknown[][] = [
      ["총 2건", null, null, 0, 0, 0, 0, 0, 0, null, 0, 0, 0, null, null, null, null],
      txnRow(2, "2026-08-31", "타이레놀", "신한카드"),
      [null, detailLine("타이레놀", 4000, 0, 1, 4000), null],
    ];
    const result = parseCatposTalkFileRows(rows, columns);
    expect(result.summaryRowsSkipped).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.lineItems).toEqual([
      {
        rowNo: 3,
        transactionNo: 2,
        saleDate: "2026-08-31",
        itemNameRaw: "타이레놀",
        quantity: 1,
        unitPrice: 4000,
        discount: 0,
        amount: 4000,
        paymentType: "신한카드",
      },
    ]);
  });

  it("한 거래에 품목이 여러 개면(요약 텍스트는 '외 N품목') 상세 행 전부를 개별 라인으로 뽑는다", () => {
    const rows: unknown[][] = [
      txnRow(1, "2026-08-31", "생위단 외 1품목", "삼성"),
      [null, detailLine("생위단", 1000, 0, 1, 1000), null],
      [null, detailLine("활명수", 1500, 0, 1, 1500), null],
    ];
    const result = parseCatposTalkFileRows(rows, columns);
    expect(result.lineItems).toHaveLength(2);
    expect(result.lineItems.map((li) => li.itemNameRaw)).toEqual(["생위단", "활명수"]);
    expect(result.lineItems.every((li) => li.saleDate === "2026-08-31" && li.transactionNo === 1)).toBe(true);
  });

  it("거래일자를 해석할 수 없으면 조용히 버리지 않고 오류로 남긴다", () => {
    const rows: unknown[][] = [txnRow(1, "모름", "타이레놀", "현금")];
    const result = parseCatposTalkFileRows(rows, columns);
    expect(result.lineItems).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("앞선 거래일자 없이 상세 행만 나오면 오류로 남긴다", () => {
    const rows: unknown[][] = [[null, detailLine("타이레놀", 4000, 0, 1, 4000), null]];
    const result = parseCatposTalkFileRows(rows, columns);
    expect(result.errors).toHaveLength(1);
    expect(result.lineItems).toEqual([]);
  });

  it("상세 행 형식이 깨져 있으면(구분자 누락 등) 오류로 남기고 조용히 버리지 않는다", () => {
    const rows: unknown[][] = [
      txnRow(1, "2026-08-31", "타이레놀", "현금"),
      [null, "\u3000└ 상품명: 타이레놀 판매단가 4000 (형식 깨짐)", null],
    ];
    const result = parseCatposTalkFileRows(rows, columns);
    expect(result.lineItems).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("완전히 빈 행은 조용히 무시한다", () => {
    const rows: unknown[][] = [
      txnRow(1, "2026-08-31", "타이레놀", "현금"),
      [null, detailLine("타이레놀", 4000, 0, 1, 4000), null],
      new Array(17).fill(null),
    ];
    const result = parseCatposTalkFileRows(rows, columns);
    expect(result.blankRowsSkipped).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("알아볼 수 없는 행 형식은(합계도 거래도 상세도 아님) 오류로 남긴다", () => {
    const rows: unknown[][] = [["이상한값", "이상한값2", null, null, null, null, null, null, null, null, null, null, null, null, null, null, null]];
    const result = parseCatposTalkFileRows(rows, columns);
    expect(result.errors).toHaveLength(1);
  });
});
