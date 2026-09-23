// Dependency-free: the deployed batch and local tests use this exact evaluation code.
export interface QualityObservation {
  date: string;
  status: "observed" | "missing" | "not_observed";
  netQty?: number;
}
export interface ForecastEvaluation {
  status: "evaluated" | "insufficient_data";
  method: "rolling_origin_1day";
  window_start: string | null;
  window_end: string | null;
  requested_days: number;
  observed_days: number;
  n: number;
  partial: boolean;
  mae: number | null;
  wape: number | null;
  baseline_mae: number | null;
  baseline_wape: number | null;
}

/** Latest 28 calendar days; each date is predicted using strictly earlier data.
 * The baseline is the mean of the SAME training observations, never a fallback order model. */
export function evaluateForecast(
  observations: QualityObservation[],
  train: (rows: QualityObservation[]) => ((date: string) => number) | null,
  days = 28,
): ForecastEvaluation {
  if (!Number.isInteger(days) || days < 1) throw new Error("INVALID_EVALUATION_WINDOW");
  const sorted = [...observations].sort((a,b) => a.date.localeCompare(b.date));
  const end = sorted[sorted.length-1]?.date ?? null;
  const start = end ? new Date(Date.parse(`${end}T00:00:00Z`) - (days-1)*86400000).toISOString().slice(0,10) : null;
  const targets = sorted.filter(o => o.status === "observed" && start !== null && o.date >= start);
  let absError = 0, baselineError = 0, absActual = 0, n = 0;
  for (const target of targets) {
    const prior = sorted.filter(o => o.date < target.date);
    const observed = prior.filter(o => o.status === "observed");
    if (observed.length < 8) continue;
    const predict = train(prior);
    if (!predict) continue;
    const prediction = predict(target.date);
    const actual = target.netQty ?? 0;
    const baseline = Math.max(0, observed.reduce((sum,o) => sum+(o.netQty ?? 0),0)/observed.length);
    if (![prediction,actual,baseline].every(Number.isFinite)) throw new Error("NON_FINITE_EVALUATION");
    absError += Math.abs(prediction-actual);
    baselineError += Math.abs(baseline-actual);
    absActual += Math.abs(actual);
    n++;
  }
  return {
    status: n ? "evaluated" : "insufficient_data", method: "rolling_origin_1day",
    window_start: start, window_end: end, requested_days: days, observed_days: targets.length,
    n, partial: n < days, mae: n ? absError/n : null,
    wape: n && absActual > 0 ? absError/absActual : null,
    baseline_mae: n ? baselineError/n : null,
    baseline_wape: n && absActual > 0 ? baselineError/absActual : null,
  };
}

export interface NegativeForecast { date: string; raw: number; applied: 0 }
/** Record a raw negative once per date, while preserving the established 0-floor calculation. */
export function trackNegativeForecasts(rawPredict: (date: string) => number) {
  const negative = new Map<string, NegativeForecast>();
  return {
    predict(date: string) {
      const raw = rawPredict(date);
      if (!Number.isFinite(raw)) throw new Error("NON_FINITE_FORECAST");
      if (raw < 0) negative.set(date,{date,raw,applied:0});
      return Math.max(0,raw);
    },
    negatives: () => [...negative.values()].sort((a,b) => a.date.localeCompare(b.date)),
  };
}
