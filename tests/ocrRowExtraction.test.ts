import { describe, it, expect } from "vitest";
import { extractRowCandidates } from "../src/lib/ocrRowExtraction";

function line(text: string): { text: string; words: { text: string }[] } {
  return { text, words: text.split(/\s+/).map((t) => ({ text: t })) };
}

describe("extractRowCandidates", () => {
  it("줄 끝의 숫자를 수량 후보로 분리한다", () => {
    const [row] = extractRowCandidates([line("타이레놀 500mg 10")]);
    expect(row.itemCandidate).toBe("타이레놀 500mg");
    expect(row.qtyCandidate).toBe(10);
  });

  it("천단위 구분자가 있는 수량도 인식한다", () => {
    const [row] = extractRowCandidates([line("포장재 1,200")]);
    expect(row.qtyCandidate).toBe(1200);
  });

  it("숫자가 없으면 수량 후보는 null이고 빈칸으로 둔다 (1개로 추측하지 않음)", () => {
    const [row] = extractRowCandidates([line("타이레놀 500mg")]);
    expect(row.qtyCandidate).toBeNull();
    expect(row.itemCandidate).toBe("타이레놀 500mg");
  });

  it("1+1 같은 프로모션 문구는 수량으로 보지 않는다", () => {
    const [row] = extractRowCandidates([line("타이레놀 1+1 5")]);
    expect(row.qtyCandidate).toBe(5);
    expect(row.itemCandidate).toBe("타이레놀 1+1");
  });

  it("빈 줄은 건너뛴다", () => {
    expect(extractRowCandidates([line("   ")])).toEqual([]);
  });
});
