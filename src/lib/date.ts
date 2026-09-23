// 날짜 계산은 한국 표준시(Asia/Seoul) 기준 달력일로 처리한다.
// 상세_알고리즘_설계.md §4 참고.

export type IsoDate = string; // "YYYY-MM-DD"

export function addCalendarDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function dayOfWeek(date: IsoDate): number {
  // 0=Sunday .. 6=Saturday (UTC 기준 계산이지만 달력일 문자열만 다루므로 시간대 영향 없음)
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

export interface HolidayCoverage {
  /** 해당 날짜가 공식 공휴일 자료 조회 범위 안에 있는지. 범위 밖이면 도착일 계산을 확정할 수 없다. */
  isCovered(date: IsoDate): boolean;
  isOfficialHoliday(date: IsoDate): boolean;
}

export class ArrivalDateUndeterminedError extends Error {
  constructor(public readonly uncoveredDate: IsoDate) {
    super(
      `공휴일 자료 조회 범위에 ${uncoveredDate}가 포함되지 않아 도착일을 확정할 수 없습니다.`,
    );
    this.name = "ArrivalDateUndeterminedError";
  }
}

/**
 * 주문일 다음 날부터 토·일요일, 공식 공휴일, 거래처 휴무일을 제외하고
 * 두 번째로 오는 영업일을 도착일로 계산한다. (FR-20, 상세_알고리즘_설계.md §4)
 *
 * 필요한 기간의 공휴일 캐시가 없으면 임의로 모든 평일을 영업일로 간주하지 않고
 * ArrivalDateUndeterminedError를 던진다.
 */
export function calculateArrivalDate(
  orderDate: IsoDate,
  holidays: HolidayCoverage,
  supplierClosedDates: ReadonlySet<IsoDate> = new Set(),
): IsoDate {
  let day = orderDate;
  let businessDays = 0;
  // 무한루프 방지를 위한 안전 상한 (거래처 휴무일이 극단적으로 많아도 1년 이내 도착 가정)
  const maxIterations = 366;
  let iterations = 0;

  while (businessDays < 2) {
    day = addCalendarDays(day, 1);
    iterations += 1;
    if (iterations > maxIterations) {
      throw new Error(`도착일 계산이 ${maxIterations}일 내에 끝나지 않았습니다: ${orderDate}`);
    }
    if (!holidays.isCovered(day)) {
      throw new ArrivalDateUndeterminedError(day);
    }
    if (isWeekend(day)) continue;
    if (holidays.isOfficialHoliday(day)) continue;
    if (supplierClosedDates.has(day)) continue;
    businessDays += 1;
  }
  return day;
}

/** A부터 A+6일까지 (달력일 7일, 배송일 제외 규칙 미적용) 날짜 목록을 만든다. FR-26 7일 예상 수요 구간. */
export function sevenDayWindow(arrivalDate: IsoDate): IsoDate[] {
  return Array.from({ length: 7 }, (_, i) => addCalendarDays(arrivalDate, i));
}

/** start일부터 end일까지(포함) 날짜 목록. start > end이면 빈 배열. */
export function dateRange(start: IsoDate, end: IsoDate): IsoDate[] {
  if (start > end) return [];
  const out: IsoDate[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addCalendarDays(cur, 1);
  }
  return out;
}
