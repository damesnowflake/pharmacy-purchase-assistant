import { describe, it, expect } from "vitest";
import { trainDemandModel, type DailyObservation } from "../src/lib/regression";
import { addCalendarDays } from "../src/lib/date";

function buildObservations(
  startDate: string,
  n: number,
  fn: (i: number, date: string) => number,
): DailyObservation[] {
  return Array.from({ length: n }, (_, i) => {
    const date = addCalendarDays(startDate, i);
    return { date, status: "observed" as const, netQty: fn(i, date) };
  });
}

describe("trainDemandModel", () => {
  it("관측치가 8개 미만이면 예측 없음을 반환한다", () => {
    const obs = buildObservations("2026-01-01", 5, () => 10);
    const model = trainDemandModel(obs, "v1");
    expect(model.status).toBe("no_forecast");
    if (model.status === "no_forecast") {
      expect(model.reason).toBe("insufficient_observations");
    }
  });

  it("모든 관측이 같은 요일이면 설계행렬 rank 부족으로 예측 없음을 반환한다", () => {
    // 7일 간격 = 항상 같은 요일 -> 해당 요일 더미가 절편과 완전히 겹침
    const obs = Array.from({ length: 10 }, (_, i) => ({
      date: addCalendarDays("2026-01-05", i * 7), // 매주 월요일
      status: "observed" as const,
      netQty: 10,
    }));
    const model = trainDemandModel(obs, "v1");
    expect(model.status).toBe("no_forecast");
    if (model.status === "no_forecast") {
      expect(model.reason).toBe("rank_deficient");
    }
  });

  it("충분한 관측치로 학습하면 합리적인 예측을 만든다", () => {
    // 평균 20, 약간의 상승 추세, 요일 변동이 있는 합성 데이터
    const obs = buildObservations("2026-03-01", 180, (i, date) => {
      const dow = new Date(date + "T00:00:00Z").getUTCDay();
      const weekendBoost = dow === 0 || dow === 6 ? 5 : 0;
      return 20 + i * 0.05 + weekendBoost;
    });
    const model = trainDemandModel(obs, "v1");
    expect(model.status).toBe("fitted");
    if (model.status === "fitted") {
      expect(model.nObserved).toBe(180);
      expect(model.warningCodes).not.toContain("short_history");
      const nextDate = addCalendarDays("2026-03-01", 180);
      const { clamped } = model.predict(nextDate);
      // 추세상 20 + 180*0.05 = 29 부근이어야 한다 (요일에 따라 +0~5)
      expect(clamped).toBeGreaterThan(25);
      expect(clamped).toBeLessThan(40);
    }
  });

  it("음수 예측은 원값을 보존하고 clamped는 0이다", () => {
    // 뚜렷한 하락 추세로 미래 예측이 음수가 되도록 구성
    const obs = buildObservations("2026-03-01", 60, (i) => Math.max(0, 100 - i * 2));
    const model = trainDemandModel(obs, "v1");
    expect(model.status).toBe("fitted");
    if (model.status === "fitted") {
      const farFuture = addCalendarDays("2026-03-01", 90);
      const { raw, clamped } = model.predict(farFuture);
      expect(raw).toBeLessThan(0);
      expect(clamped).toBe(0);
    }
  });

  it("180일을 다 확보하지 못하면 incomplete_window 경고를 표시한다", () => {
    const obs: DailyObservation[] = [
      ...buildObservations("2026-03-01", 100, () => 10),
      { date: addCalendarDays("2026-03-01", 100), status: "missing" },
    ];
    const model = trainDemandModel(obs, "v1");
    expect(model.status).toBe("fitted");
    if (model.status === "fitted") {
      expect(model.warningCodes).toContain("incomplete_window");
    }
  });
});
