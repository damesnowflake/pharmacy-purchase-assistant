// 판매 파일 열 값 정규화. 상세_알고리즘_설계.md §2.
// 실제 CatPOS 표본이 없어 특정 포맷을 가정하지 않고, 흔한 CSV/XLSX 표현을 폭넓게 받아들이는
// 범용 파서다. CatPOS 호환성이 검증되었다는 뜻은 아니다 (docs/미확인_항목.md D-02).
import type { IsoDate } from "./date";

/** 엑셀 시리얼 날짜(1900 기준)를 IsoDate로 변환한다. */
export function excelSerialToIsoDate(serial: number): IsoDate {
  // 엑셀의 1900년 윤년 버그(1900-02-29가 존재한다고 계산)를 그대로 따르는 표준 변환.
  const epoch = Date.UTC(1899, 11, 30); // 1899-12-30 UTC를 시리얼 0으로 둔다.
  const ms = epoch + Math.round(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Date 객체, 엑셀 시리얼 숫자, 또는 "YYYY-MM-DD"/"YYYY.MM.DD"/"YYYY/MM/DD"/"YYYYMMDD" 문자열을
 * IsoDate로 정규화한다. 해석할 수 없으면 null (FR-06: 조용히 임의 날짜로 바꾸지 않는다).
 */
export function parseFlexibleDate(raw: unknown): IsoDate | null {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return excelSerialToIsoDate(raw);
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "") return null;
    const isoLike = s.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
    if (isoLike) {
      const [, y, m, d] = isoLike;
      return toIso(Number(y), Number(m), Number(d));
    }
    const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (compact) {
      const [, y, m, d] = compact;
      return toIso(Number(y), Number(m), Number(d));
    }
    const asNumber = Number(s);
    if (Number.isFinite(asNumber) && s.length <= 6 && asNumber > 0) {
      return excelSerialToIsoDate(asNumber);
    }
  }
  return null;
}

function toIso(y: number, m: number, d: number): IsoDate | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

/** "1,234", " 12 ", "12개" 같은 값에서 수량을 뽑는다. 해석 불가면 null. */
export function parseFlexibleQuantity(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/,/g, "").trim();
    const match = cleaned.match(/^-?\d+(\.\d+)?/);
    if (!match) return null;
    const n = Number(match[0]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 품목명 매칭용 정규화: 공백 제거, 소문자화. product_aliases.normalized_alias와 같은 규칙. */
export function normalizeAliasText(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}
