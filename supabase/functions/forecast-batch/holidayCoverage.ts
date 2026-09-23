export interface HolidayCoverage {
  coverage_start: string | null;
  coverage_end: string | null;
}

// A successful next-year refresh must not hide the current year's coverage.
export function hasHolidayCoverage(date: string, rows: HolidayCoverage[]): boolean {
  return rows.some((row) => row.coverage_start !== null && row.coverage_end !== null &&
    row.coverage_start <= date && date <= row.coverage_end);
}

export function businessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
