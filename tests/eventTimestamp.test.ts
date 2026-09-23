import { describe, expect, it } from "vitest";
import { toKstDatetimeLocal, revisedEventTimestamp } from "../src/lib/date";

describe("event correction timestamps", () => {
  it("renders UTC in KST", () => {
    expect(toKstDatetimeLocal("2026-09-23T03:00:47.123456+00:00")).toBe("2026-09-23T12:00");
  });
  it("preserves the exact original timestamp for quantity-only changes", () => {
    const original = "2026-09-23T03:00:47.123456+00:00";
    expect(revisedEventTimestamp(original, "2026-09-23T12:00")).toBe(original);
  });
  it("handles Korean midnight without changing the day", () => {
    expect(toKstDatetimeLocal("2026-09-22T15:03:01Z")).toBe("2026-09-23T00:03");
  });
  it("interprets an intentional time edit as KST", () => {
    expect(revisedEventTimestamp("2026-09-23T03:00:00Z", "2026-09-24T09:30"))
      .toBe("2026-09-24T09:30:00+09:00");
  });
  it("rejects empty and impossible dates", () => {
    expect(() => revisedEventTimestamp("2026-09-23T03:00:00Z", "")).toThrow();
    expect(() => revisedEventTimestamp("2026-09-23T03:00:00Z", "2026-02-30T09:30")).toThrow();
  });
});
