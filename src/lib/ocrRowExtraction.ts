// OCR 결과에서 품목·수량 후보를 뽑는 규칙. 상세_알고리즘_설계.md §3.
// 실제 입고장 사진 표본이 없어(D-04, docs/미확인_항목.md) Tesseract.js의 줄(line) 단위 출력을
// 그대로 신뢰하는 v1 규칙이다: 줄의 마지막에서 수량처럼 보이는 토큰을 찾아 분리하고 나머지를
// 품목명 후보로 둔다. 실제 사진으로 열 정렬(품명/규격/수량 컬럼) 정확도를 검증해야 한다.
import { parseFlexibleQuantity } from "./salesFileParsing";

export interface OcrWord {
  text: string;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
}

export interface OcrRowCandidate {
  rawText: string;
  itemCandidate: string;
  /** 공급가·단가 등이 수량으로 오인되지 않도록, 줄 끝에서부터 찾은 순수 수량 후보만 담는다. */
  qtyCandidate: number | null;
}

/** "1+1", "2+1" 같은 프로모션 표기는 수량 후보로 보지 않는다 (§3: 두 배로 만들지 않는다). */
function looksLikePromotion(token: string): boolean {
  return token.includes("+");
}

/** 순수 숫자(및 천단위 구분자) 토큰만 수량 후보로 인정한다. 단가·공급가 같은 큰 값도
 * 이 v1 규칙에서는 구분하지 못하므로, 실제 사용 전 직원이 반드시 확인해야 한다. */
function isPlainQuantityToken(token: string): boolean {
  if (looksLikePromotion(token)) return false;
  return /^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(token) || /^-?\d+(\.\d+)?$/.test(token);
}

export function extractRowCandidates(lines: OcrLine[]): OcrRowCandidate[] {
  const candidates: OcrRowCandidate[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    const words = line.words.map((w) => w.text).filter((w) => w.trim() !== "");
    let qtyCandidate: number | null = null;
    let itemWords = words;

    for (let i = words.length - 1; i >= 0; i--) {
      if (isPlainQuantityToken(words[i])) {
        const parsed = parseFlexibleQuantity(words[i]);
        if (parsed !== null) {
          qtyCandidate = parsed;
          itemWords = [...words.slice(0, i), ...words.slice(i + 1)];
          break;
        }
      }
    }

    candidates.push({
      rawText: text,
      itemCandidate: itemWords.join(" ").trim(),
      qtyCandidate,
    });
  }
  return candidates;
}
