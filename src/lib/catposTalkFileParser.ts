// CatPOS Cloud(팜페이) "톡파일" 판매내역 전용 파서. 상세_알고리즘_설계.md §2, FR-05~09.
//
// 이 구조는 사용자가 제공한 실제 판매내역 표본(TalkFile_판매내역_20260801-20260831.numbers,
// 2026년 8월 3,140건 거래·4,812개 품목 상세, 저장소에는 올리지 않음)을 직접 열어 확인했다.
// 열 매핑 방식의 범용 가져오기(genericSalesFileParsing)로는 이 구조를 다룰 수 없다 — "수량"이
// 별도 열에 없고, 한 거래에 품목이 여럿이면 거래 행의 "판매상품" 열에는 "생위단 외 1품목"처럼
// 요약 텍스트만 있으며 실제 품목별 수량은 그 아래 딸린 "상세 행"에 다음과 같은 한 줄짜리
// 텍스트로만 들어 있다 (맨 앞은 전각 공백+└ 기호):
//   [전각공백]└ 상품명: 생위단          | 판매단가: 1,000 | 할인: 0 | 수량: 1 | 판매금액: 1,000
//
// 확인된 것: 표본 7,954행 전부가 (1) 헤더 1행 (2) "총 N건" 합계 1행 (3) 거래 헤더 행 3,140개
// (4) 품목 상세 행 4,812개로 하나도 빠짐없이 분류됨. "거래구분" 열은 반품 여부가 아니라 결제
// 수단(카드사명 등)이었다.
//
// 확인되지 않은 것 (docs/미확인_항목.md D-02): 이 표본 기간에는 반품·취소 거래가 전혀 없어
// CatPOS가 반품을 어떻게 표현하는지(별도 거래로 음수 처리하는지, 상세 행에 표시하는지 등)는
// 여전히 모른다. 이 파서는 수량을 항상 양수로 그대로 반영하며, 반품 표기를 만나면(음수 수량
// 등) 순판매수량 계산 없이 원래 부호를 그대로 반영한다 — 실제 반품 거래로 검증 전까지는
// 확정 사양이 아니다. 또한 이 파일은 원래 CatPOS가 직접 낸 파일이 아니라 사용자가 Numbers로
// 저장한 사본이라, 실제 CatPOS CSV/Excel 내보내기와 열 이름·순서가 100% 같다는 보장은 없다.
import { parseFlexibleDate, parseFlexibleQuantity } from "./salesFileParsing";
import type { IsoDate } from "./date";

const DETAIL_LINE_RE =
  /상품명:\s*(.+?)\s*\|\s*판매단가:\s*([-0-9,]+)\s*\|\s*할인:\s*([-0-9,]+)\s*\|\s*수량:\s*([-0-9,]+)\s*\|\s*판매금액:\s*([-0-9,]+)/;

const SUMMARY_ROW_RE = /^총\s*[\d,]+건$/;

export interface CatposColumnIndexes {
  no: number;
  date: number;
  product: number;
  payment: number;
}

/** 헤더 행이 이 CatPOS 톡파일 구조와 일치하는지 확인한다. 아니면 null(범용 가져오기로 대체). */
export function detectCatposTalkFileColumns(headerRow: string[]): CatposColumnIndexes | null {
  const normalized = headerRow.map((h) => h.trim());
  const indexOf = (name: string) => normalized.findIndex((h) => h === name);
  const idx: CatposColumnIndexes = {
    no: indexOf("no"),
    date: indexOf("판매일자"),
    product: indexOf("판매상품"),
    payment: indexOf("거래구분"),
  };
  if (idx.no === -1 || idx.date === -1 || idx.product === -1 || idx.payment === -1) {
    return null;
  }
  return idx;
}

export interface CatposLineItem {
  rowNo: number;
  transactionNo: number | null;
  saleDate: IsoDate;
  itemNameRaw: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  amount: number;
  paymentType: string | null;
}

export interface CatposParseError {
  rowIndex: number;
  reason: string;
}

export interface CatposParseResult {
  lineItems: CatposLineItem[];
  errors: CatposParseError[];
  summaryRowsSkipped: number;
  blankRowsSkipped: number;
}

/**
 * 거래 헤더 행 + 품목 상세 행 구조를 파싱해 (거래일자, 품목명, 수량) 단위 행 목록으로 만든다.
 * 헤더·합계 행은 조용히 건너뛰지만, 그 외 형식을 알아볼 수 없는 행은 FR-06에 따라 오류로
 * 남기고 조용히 버리지 않는다.
 */
export function parseCatposTalkFileRows(
  dataRows: unknown[][],
  columns: CatposColumnIndexes,
): CatposParseResult {
  const lineItems: CatposLineItem[] = [];
  const errors: CatposParseError[] = [];
  let summaryRowsSkipped = 0;
  let blankRowsSkipped = 0;

  let currentDate: IsoDate | null = null;
  let currentTxnNo: number | null = null;
  let currentPayment: string | null = null;

  dataRows.forEach((row, rowIndex) => {
    const noVal = row[columns.no];
    const dateVal = row[columns.date];

    if (typeof noVal === "string" && SUMMARY_ROW_RE.test(noVal.trim())) {
      summaryRowsSkipped++;
      return;
    }

    const hasNo = noVal !== null && noVal !== undefined && noVal !== "";
    const hasDate = dateVal !== null && dateVal !== undefined && dateVal !== "";

    if (hasNo && hasDate) {
      // 거래 헤더 행
      const iso = parseFlexibleDate(dateVal);
      if (iso === null) {
        errors.push({ rowIndex, reason: `거래일자를 해석할 수 없음: ${String(dateVal)}` });
        currentDate = null;
        currentTxnNo = null;
        currentPayment = null;
        return;
      }
      currentDate = iso;
      currentTxnNo = typeof noVal === "number" ? noVal : parseFlexibleQuantity(noVal);
      currentPayment = row[columns.payment] != null ? String(row[columns.payment]) : null;
      return;
    }

    if (typeof dateVal === "string" && dateVal.includes("상품명:")) {
      // 품목 상세 행
      if (currentDate === null) {
        errors.push({ rowIndex, reason: "이 상세 행보다 앞서 나온 거래일자를 찾을 수 없음" });
        return;
      }
      const m = DETAIL_LINE_RE.exec(dateVal);
      if (!m) {
        errors.push({ rowIndex, reason: `품목 상세 형식을 해석할 수 없음: ${dateVal}` });
        return;
      }
      const [, name, unitPriceStr, discountStr, qtyStr, amountStr] = m;
      const unitPrice = parseFlexibleQuantity(unitPriceStr);
      const discount = parseFlexibleQuantity(discountStr);
      const quantity = parseFlexibleQuantity(qtyStr);
      const amount = parseFlexibleQuantity(amountStr);
      if (unitPrice === null || discount === null || quantity === null || amount === null) {
        errors.push({ rowIndex, reason: `품목 상세의 숫자 값을 해석할 수 없음: ${dateVal}` });
        return;
      }
      lineItems.push({
        rowNo: rowIndex + 1,
        transactionNo: currentTxnNo,
        saleDate: currentDate,
        itemNameRaw: name.trim(),
        quantity,
        unitPrice,
        discount,
        amount,
        paymentType: currentPayment,
      });
      return;
    }

    if (row.every((v) => v === null || v === undefined || v === "")) {
      blankRowsSkipped++;
      return;
    }

    errors.push({ rowIndex, reason: "알 수 없는 행 형식(거래 헤더도 품목 상세도 아님)" });
  });

  return { lineItems, errors, summaryRowsSkipped, blankRowsSkipped };
}
