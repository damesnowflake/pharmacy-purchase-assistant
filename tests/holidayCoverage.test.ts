import { describe, expect, it } from "vitest";
import { businessDate, hasHolidayCoverage } from "../supabase/functions/forecast-batch/holidayCoverage";

describe("forecast holiday coverage", () => {
  const rows = [
    { coverage_start: "2027-01-01", coverage_end: "2027-12-31" },
    { coverage_start: "2026-01-01", coverage_end: "2026-12-31" },
  ];
  it("retains current-year coverage when next year was fetched last", () => {
    expect(hasHolidayCoverage("2026-09-23", rows)).toBe(true);
  });
  it("covers both sides of a year-end arrival", () => {
    expect(hasHolidayCoverage("2026-12-31", rows)).toBe(true);
    expect(hasHolidayCoverage("2027-01-04", rows)).toBe(true);
  });
  it("does not invent coverage for failed or missing years", () => {
    expect(hasHolidayCoverage("2028-01-01", rows)).toBe(false);
    expect(hasHolidayCoverage("2026-09-23", [])).toBe(false);
    expect(hasHolidayCoverage("2026-09-23", [{ coverage_start: null, coverage_end: null }])).toBe(false);
  });
  it("uses the Korean business date before UTC midnight", () => {
    expect(businessDate(new Date("2026-09-23T08:00:00+09:00"))).toBe("2026-09-23");
  });
});
