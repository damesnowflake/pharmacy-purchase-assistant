import { describe, it, expect } from "vitest";
import { extractRowCandidates } from "../src/lib/ocrRowExtraction";

function line(text: string): { text: string; words: { text: string }[] } {
  return { text, words: text.split(/\s+/).map((t) => ({ text: t })) };
}

describe("extractRowCandidates", () => {
  it("헤더 없는 줄 끝 숫자를 수량으로 추측하지 않는다", () => {
    const [row] = extractRowCandidates([line("타이레놀 500mg 10")]);
    expect(row.itemCandidate).toBe("타이레놀 500mg 10");
    expect(row.qtyCandidate).toBeNull();
  });

  it("천단위 구분자가 있는 수량도 인식한다", () => {
    const [row] = extractRowCandidates([line("포장재 수량: 1,200")]);
    expect(row.qtyCandidate).toBe(1200);
  });

  it("숫자가 없으면 수량 후보는 null이고 빈칸으로 둔다 (1개로 추측하지 않음)", () => {
    const [row] = extractRowCandidates([line("타이레놀 500mg")]);
    expect(row.qtyCandidate).toBeNull();
    expect(row.itemCandidate).toBe("타이레놀 500mg");
  });

  it("1+1 같은 프로모션 문구는 수량으로 보지 않는다", () => {
    const [row] = extractRowCandidates([line("타이레놀 1+1 5")]);
    expect(row.qtyCandidate).toBeNull();
    expect(row.itemCandidate).toBe("타이레놀 1+1 5");
  });

  it("빈 줄은 건너뛴다", () => {
    expect(extractRowCandidates([line("   ")])).toEqual([]);
  });
});

function positioned(values: string[], y: number) {
  return { text: values.join(" "), words: values.map((text, i) => ({ text, confidence: 95,
    bbox: { x0: i * 100, x1: i * 100 + 40, y0: y, y1: y + 15 } })) };
}
describe("OCR quantity columns", () => {
  const header = positioned(["품명", "규격", "수량", "단가", "공급금액"], 0);
  it("수량만 추출하고 마지막 금액은 제외", () => {
    const [row] = extractRowCandidates([header, positioned(["넥스가드", "XS", "10", "34,000", "340,000"], 30)]);
    expect(row).toMatchObject({ itemCandidate: "넥스가드", qtyCandidate: 10, quantitySource: "column" });
  });
  it("OCR 블록이 열별로 분리돼도 같은 줄로 재구성", () => {
    const data = positioned(["아포퀠", "3.6mg", "1", "170000", "170000"], 30);
    const lines = [...header.words, ...data.words].map(w => ({ text: w.text, words: [w] }));
    expect(extractRowCandidates(lines)[0].qtyCandidate).toBe(1);
  });
  it("빈 수량 열에서 단가를 가져오지 않는다", () => {
    const row = positioned(["아포퀠", "3.6mg", "", "170000", "170000"], 30);
    expect(extractRowCandidates([header, row])[0].qtyCandidate).toBeNull();
  });
  it("품명이 생략된 다음 규격 행을 버리지 않는다", () => {
    const rows = extractRowCandidates([header,
      positioned(["넥스가드", "XS", "10", "34000", "340000"],30),
      positioned(["", "S", "10", "36000", "360000"],60)]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({itemCandidate:"넥스가드 S",qtyCandidate:10});
  });
  it("수량 열의 프로모션/낮은 신뢰도를 추측하지 않는다", () => {
    const promo = positioned(["비타민", "1+1", "1+1", "10000", "10000"], 30);
    expect(extractRowCandidates([header, promo])[0].qtyCandidate).toBeNull();
    promo.words[2].text = "10"; promo.words[2].confidence = 20;
    expect(extractRowCandidates([header, promo])[0].qtyCandidate).toBeNull();
  });
  it("합계 행을 제외한다", () => {
    expect(extractRowCandidates([header, positioned(["합계", "", "30", "", "500000"], 30)])).toEqual([]);
  });
  it("수 량처럼 분리된 헤더 글자를 연결한다", () => {
    const split = { ...header, words: header.words.flatMap(w => w.text === "수량" ? [
      { ...w, text: "수", bbox: { ...w.bbox, x1: 215 } },
      { ...w, text: "량", bbox: { ...w.bbox, x0: 220 } },
    ] : [w]) };
    expect(extractRowCandidates([split, positioned(["넥스가드", "XS", "10", "34000", "340000"],30)])[0].qtyCandidate).toBe(10);
  });
});
