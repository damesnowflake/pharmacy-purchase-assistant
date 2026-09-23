// 수량 참고값(재고 아님)과 발주 시점 판단. 상세_알고리즘_설계.md §6.
// 이 값은 실제 총재고를 보장하지 않는 보수적 일 단위 참고값이다.

import { type IsoDate, addCalendarDays, dateRange } from "./date";

export interface DailyLookup {
  (date: IsoDate): number | undefined; // undefined = 자료 없음(missing) 또는 예측 불가
}

export interface ReferenceValueResult {
  value: number;
  /** B..D 또는 실사 다음날..D 구간에 판매 업로드 누락이 있어 정확한 소진 계산을 확정할 수 없음. */
  dataInsufficient: boolean;
  /** 예측 구간에 예측 불가 날짜가 있어 도착일 말 예상값을 확정할 수 없음. */
  forecastUnavailable: boolean;
}

/**
 * 실사 없는 품목의 참고값. 최신 입고일 B, 그날 입고 합계 Q를 기준으로
 * 그 이전 잔여 재고는 포함하지 않는 지표다.
 */
export function lastReceiptAnchorReference(input: {
  latestReceiptDate: IsoDate; // B
  receiptSumOnLatestReceiptDate: number; // Q
  latestSalesDate: IsoDate; // D
  arrivalDate: IsoDate; // A
  actualSalesByDate: DailyLookup;
  forecastByDate: DailyLookup;
  includeArrivalDayForecast?: boolean;
}): { actualReflected: ReferenceValueResult; arrivalDayEndExpected: ReferenceValueResult } {
  const { latestReceiptDate: B, receiptSumOnLatestReceiptDate: Q, latestSalesDate: D, arrivalDate: A } = input;

  const actualRange = B <= D ? dateRange(B, D) : [];
  let actualSalesSum = 0;
  let dataInsufficient = false;
  for (const d of actualRange) {
    const v = input.actualSalesByDate(d);
    if (v === undefined) {
      dataInsufficient = true;
    } else {
      actualSalesSum += v;
    }
  }

  const actualReflectedValue = Q - actualSalesSum;

  const forecastStart = B > addCalendarDays(D, 1) ? B : addCalendarDays(D, 1);
  const forecastRange = dateRange(forecastStart, A);
  let forecastSum = 0;
  let forecastUnavailable = false;
  for (const d of forecastRange) {
    const v = input.forecastByDate(d);
    if (v === undefined) {
      forecastUnavailable = true;
    } else {
      forecastSum += v;
    }
  }

  const arrivalDayEndExpectedValue = Q - actualSalesSum - forecastSum;

  return {
    actualReflected: { value: actualReflectedValue, dataInsufficient, forecastUnavailable: false },
    arrivalDayEndExpected: {
      value: arrivalDayEndExpectedValue,
      dataInsufficient,
      forecastUnavailable,
    },
  };
}

export interface StockCountAnchorInput {
  countDate: IsoDate; // C (일자 단위)
  countQuantity: number; // Q
  isEndOfDayCount: boolean; // 마감 후 실사인지
  /** 장중 실사일 때만 필요. 당일 예측 판매량 전체(모델 산출). */
  estimatedFirstDaySales?: number;
  /** 실사 시점 이후(같은 시각 포함 이벤트 순서 처리는 호출측 included_event_seq로 이미 제외) 입고 합계. */
  receiptsAfterCount: number;
  /** 실사 시점 이후 재고 조정 합계(부호 있음). */
  stockAdjustmentsAfterCount: number;
  latestSalesDate: IsoDate; // D
  arrivalDate: IsoDate; // A
  actualSalesByDate: DailyLookup;
  forecastByDate: DailyLookup;
}

/**
 * 실사 있는 품목의 도착일 말 예상 참고량.
 * 장중 실사는 당일 예측 전체를 보수적으로 차감하고, 그 날짜의 실제 판매를 나중에 다시 빼지 않는다.
 */
export function stockCountAnchorReference(
  input: StockCountAnchorInput,
): ReferenceValueResult & { midDayCorrectionApplied: boolean } {
  const dayAfterCount = addCalendarDays(input.countDate, 1);

  let midDayCorrection = 0;
  let midDayCorrectionApplied = false;
  if (!input.isEndOfDayCount) {
    if (input.estimatedFirstDaySales === undefined) {
      // 모델이 없어 당일 보정이 불가능하면 자동 잔량 계산을 미확정으로 표시한다.
      return {
        value: NaN,
        dataInsufficient: true,
        forecastUnavailable: true,
        midDayCorrectionApplied: false,
      };
    }
    midDayCorrection = input.estimatedFirstDaySales;
    midDayCorrectionApplied = true;
  }

  const actualRange = dateRange(dayAfterCount, input.latestSalesDate);
  let actualSalesSum = 0;
  let dataInsufficient = false;
  for (const d of actualRange) {
    const v = input.actualSalesByDate(d);
    if (v === undefined) dataInsufficient = true;
    else actualSalesSum += v;
  }

  const forecastStart =
    dayAfterCount > addCalendarDays(input.latestSalesDate, 1)
      ? dayAfterCount
      : addCalendarDays(input.latestSalesDate, 1);
  const forecastRange = dateRange(forecastStart, input.arrivalDate);
  let forecastSum = 0;
  let forecastUnavailable = false;
  for (const d of forecastRange) {
    const v = input.forecastByDate(d);
    if (v === undefined) forecastUnavailable = true;
    else forecastSum += v;
  }

  const value =
    input.countQuantity +
    input.receiptsAfterCount +
    input.stockAdjustmentsAfterCount -
    midDayCorrection -
    actualSalesSum -
    forecastSum;

  return { value, dataInsufficient, forecastUnavailable, midDayCorrectionApplied };
}

/** 도착일 말 예상 참고량이 0 이하이면 사입 검토 대상이다. */
export function needsReview(arrivalDayEndExpectedValue: number): boolean {
  return arrivalDayEndExpectedValue <= 0;
}

/**
 * 품절 예상일: 미래 일별 예측을 순서대로 차감하다 참고량이 처음 0 이하가 되는 날.
 * 모든 날짜에서 0보다 크면 undefined.
 */
export function projectedStockoutDate(
  startingValue: number,
  fromDateExclusive: IsoDate,
  toDateInclusive: IsoDate,
  forecastByDate: DailyLookup,
): IsoDate | undefined {
  let remaining = startingValue;
  for (const d of dateRange(addCalendarDays(fromDateExclusive, 1), toDateInclusive)) {
    const f = forecastByDate(d);
    if (f === undefined) continue;
    remaining -= f;
    if (remaining <= 0) return d;
  }
  return undefined;
}
