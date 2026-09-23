// 180일 보관과 기준점 누적값. 데이터베이스_설계.md "180일 보관과 기준점", 상세_알고리즘_설계.md §9.

/** 기준일 D의 누적 판매 C(D) = rollup(이월된 과거 합계) + 남은 daily 합계. */
export function cumulativeSales(retiredNetQty: number, remainingDailySum: number): number {
  return retiredNetQty + remainingDailySum;
}

/** 기준점(실사/최근입고) 이후 판매량 = C(D) - sales_before_start(기준점 당시 누적 스냅샷). */
export function salesSinceAnchor(cumulativeAtD: number, salesBeforeStart: number): number {
  return cumulativeAtD - salesBeforeStart;
}

export interface HistoricalCorrectionTargets {
  /** 정정 후 rollup(또는 전체 누적값)에 더할 값. */
  cumulativeDelta: number;
  /** 정정 대상 기준점의 salesBeforeStart 스냅샷에도 더할 값. 기준점 이전 정정이 아니면 0. */
  anchorSnapshotDelta: number;
}

/**
 * 과거 정정량 Δ를 반영한다. 정정 대상 날짜가 기준점(anchorDate)보다 이전이면
 * rollup/전체 누적값과 기준점 스냅샷 양쪽에 반영해 기준점 이후 판매 차이가 바뀌지 않게 한다.
 * 기준점 이후이면 전체 누적값만 바뀐다.
 */
export function historicalCorrection(
  correctionDelta: number,
  correctionDate: string,
  anchorDate: string,
): HistoricalCorrectionTargets {
  const isBeforeAnchor = correctionDate < anchorDate;
  return {
    cumulativeDelta: correctionDelta,
    anchorSnapshotDelta: isBeforeAnchor ? correctionDelta : 0,
  };
}
