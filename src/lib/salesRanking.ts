// 상위 50개 품목 판정. 상세_알고리즘_설계.md §2.
import { type IsoDate, dateRange } from "./date";

export interface ProductRecentSales {
  productId: string;
  /** D를 포함한 최근 30개 달력일 중 실제로 관측된 날짜의 순판매수량 합계. */
  observedSum: number;
  /** 30일 중 실제로 관측(자료 확보)된 날짜 수. 30 미만이면 불완전한 순위임을 표시해야 한다. */
  observedDays: number;
}

export interface RankedProduct extends ProductRecentSales {
  rank: number;
  isTop50: boolean;
  isPartialWindow: boolean;
}

export const RANKING_WINDOW_DAYS = 30;
export const TOP_N = 50;

/** D 포함 최근 30개 달력일의 날짜 목록. */
export function rankingWindowDates(latestSalesDate: IsoDate): IsoDate[] {
  const start = shiftBack(latestSalesDate, RANKING_WINDOW_DAYS - 1);
  return dateRange(start, latestSalesDate);
}

function shiftBack(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

/**
 * observedSum 내림차순, 동률은 productId 오름차순(고정 기준)으로 정렬해 상위 50개를 표시한다.
 * 자료가 부족한(observedDays < 30) 품목도 순위에는 포함하되 isPartialWindow로 구분한다.
 */
export function rankTopProducts(products: ProductRecentSales[]): RankedProduct[] {
  const sorted = [...products].sort((a, b) => {
    if (a.observedSum !== b.observedSum) return b.observedSum - a.observedSum;
    return a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;
  });
  return sorted.map((p, i) => ({
    ...p,
    rank: i + 1,
    isTop50: i < TOP_N,
    isPartialWindow: p.observedDays < RANKING_WINDOW_DAYS,
  }));
}
