// 판매 파일 열 값 정규화. 상세_알고리즘_설계.md §2.
// 실제 CatPOS 표본이 없어 특정 포맷을 가정하지 않고, 흔한 CSV/XLSX 표현을 폭넓게 받아들이는
// 범용 파서다. CatPOS 호환성이 검증되었다는 뜻은 아니다 (docs/미확인_항목.md D-02).
import { dateRange, type IsoDate } from "./date";

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
    // 주의: Date 객체는 "어떤 시간대 기준으로 만들어졌는지"를 스스로 담고 있지 않다.
    // SheetJS가 엑셀 일련번호를 Date로 바꿀 때는 UTC 기준으로 만들지만, CSV의 날짜 "문자열"을
    // 브라우저의 기본 Date 파서가 해석할 때는 실행 환경의 로컬 시간대로 해석한다(자정 근처
    // 값은 UTC 추출 시 하루가 밀릴 수 있음 — 실제 판매내역 표본으로 확인한 문제). 그래서 이
    // 파일의 호출부(SalesUploadPage)는 스프레드시트를 읽을 때 cellDates:false로 받아 숫자
    // 일련번호·원문 문자열 형태로만 이 함수에 넘기고, Date 인스턴스 입력은 여기서 방어적으로만
    // 처리한다(UTC 기준으로 가정).
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

/**
 * CSV 바이트를 텍스트로 디코드한다. UTF-8을 먼저 시도하고(바이트가 유효한 UTF-8이 아니면
 * 실패), 아니면 Windows 한글 POS 소프트웨어가 흔히 쓰는 EUC-KR(CP949 근사)로 폴백한다.
 *
 * 이렇게 직접 디코드하는 이유: SheetJS에 원시 버퍼를 그대로 넘기면 BOM이 없는 UTF-8 CSV를
 * 다른 코드페이지로 오인식해 한글 헤더·품목명이 전부 깨지는 것을 실제 판매내역 표본
 * (TalkFile_판매내역_20260801-20260831, 로컬 환경에서만 확인, 저장소에는 없음)으로 확인했다.
 * 헤더가 깨지면 열 자동 인식도, 품목 매칭도 전부 실패한다.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

/** 품목명 매칭용 정규화: 공백 제거, 소문자화. product_aliases.normalized_alias와 같은 규칙. */
export function normalizeAliasText(raw: string): string {
  return raw.replace(/\s+/g, "").toLowerCase();
}

/**
 * start~end(포함) 구간 중 datesPresent에 없는 날짜를 반환한다. 전체기간 보고서로 반영할 기간에
 * 실제로 자료가 없는 날짜가 섞여 있으면, 그 날짜가 "정말 무판매"인지 "파일 누락"인지 구분할 수
 * 없으므로 자동으로 complete 처리하지 않고 사용자에게 확인을 요구하기 위한 목록이다.
 */
export function findDateGaps(
  datesPresent: ReadonlySet<IsoDate>,
  start: IsoDate,
  end: IsoDate,
): IsoDate[] {
  return dateRange(start, end).filter((d) => !datesPresent.has(d));
}

export interface ParsedSalesRow {
  rowNo: number;
  rawItem: string;
  isoDate: IsoDate | null;
  qty: number | null;
}

export interface RowOverride {
  dateText?: string;
  qtyText?: string;
  excluded?: boolean;
}

export interface ClassifiedSalesRows {
  valid: { rowNo: number; productId: string; saleDate: IsoDate; netQty: number }[];
  /** 품목은 확인됐는데(또는 품목명 자체가 없는데) 날짜·수량을 해석할 수 없는 행. 저장을 막는다. */
  blocking: ParsedSalesRow[];
  /** 직원이 해당 품목명 전체를 "건너뛰기"로 확인해 제외한 행 수. */
  skippedByItemChoice: number;
  /** 직원이 개별 행 단위로 "제외"에 체크해 뺀 행 수. */
  excludedByUser: number;
}

/**
 * FR-06: 해석할 수 없는 날짜·수량·품목이 있으면 확정 저장 전에 수정할 수 있게 하고, 조용히
 * 누락하지 않는다. 완전히 빈 행(호출측에서 미리 걸러냄)이 아닌 한, 품목이 실제 상품으로
 * 연결됐거나 품목명 자체가 비어 있는데 날짜·수량이 해석되지 않으면 blocking으로 분류해
 * 저장을 막는다. dateText/qtyText override로 값을 고치거나 excluded로 명시적으로 빼야
 * valid 또는 (skipped/excluded) 집계로 넘어간다.
 */
export function classifySalesRows(
  contentRows: ParsedSalesRow[],
  itemMatches: Record<string, string | "skip">,
  rowOverrides: Record<number, RowOverride>,
): ClassifiedSalesRows {
  const valid: ClassifiedSalesRows["valid"] = [];
  const blocking: ParsedSalesRow[] = [];
  let skippedByItemChoice = 0;
  let excludedByUser = 0;

  for (const r of contentRows) {
    const ov = rowOverrides[r.rowNo];

    if (!r.rawItem) {
      if (ov?.excluded) {
        excludedByUser++;
        continue;
      }
      blocking.push(r);
      continue;
    }

    const matched = itemMatches[r.rawItem];
    if (!matched) continue; // 아직 매칭 전/미연결 — 품목 연결 단계에서 이미 진행을 막는다.
    if (matched === "skip") {
      skippedByItemChoice++;
      continue;
    }
    if (ov?.excluded) {
      excludedByUser++;
      continue;
    }

    const isoDate = ov?.dateText !== undefined ? parseFlexibleDate(ov.dateText) : r.isoDate;
    const qty = ov?.qtyText !== undefined ? parseFlexibleQuantity(ov.qtyText) : r.qty;
    if (isoDate === null || qty === null) {
      blocking.push(r);
      continue;
    }
    valid.push({ rowNo: r.rowNo, productId: matched, saleDate: isoDate, netQty: qty });
  }

  return { valid, blocking, skippedByItemChoice, excludedByUser };
}
