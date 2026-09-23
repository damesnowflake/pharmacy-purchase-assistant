// 일별 수요 회귀. 상세_알고리즘_설계.md §5.
// 절편 + 중심화·표준화한 선형 시간추세 + 요일 더미 6개 = 계수 8개의 OLS.
// 역행렬을 직접 계산하지 않고 SVD(특이값분해) 기반 최소제곱으로 풀어 rank 부족을 함께 검출한다.
import { Matrix, SVD } from "ml-matrix";
import { type IsoDate, dayOfWeek, dateRange } from "./date";
import { evaluateForecast } from "../../supabase/functions/_shared/forecastQuality";

export const COEFFICIENT_COUNT = 8; // intercept, day_trend, 6 dow dummies (일요일 기준 제외)
export const MIN_OBSERVATIONS_TO_FIT = COEFFICIENT_COUNT;
export const SHORT_HISTORY_WARNING_THRESHOLD_DAYS = 56; // 정확도 보증 기준이 아니라 표시 기준
export const TRAINING_WINDOW_DAYS = 180;

export type ObservationStatus = "observed" | "missing" | "not_observed";

export interface DailyObservation {
  date: IsoDate;
  status: ObservationStatus;
  /** status가 observed일 때만 의미가 있다. 반품 등으로 음수 가능. */
  netQty?: number;
}

export type ForecastWarningCode =
  | "short_history" // 관측일 56일 미만
  | "incomplete_window" // 180일 창을 다 확보하지 못함 (missing 또는 not_observed 존재)
  | "negative_forecast"; // 예측값이 음수여서 0으로 대체됨

export interface FittedModel {
  status: "fitted";
  modelVersion: string;
  trainingStart: IsoDate;
  trainingEnd: IsoDate;
  nObserved: number;
  nMissing: number;
  coefficients: number[]; // length 8, [intercept, day_trend, mon..sat dummies]
  dayIndexMean: number;
  dayIndexStd: number;
  warningCodes: ForecastWarningCode[];
  /** 예측 함수. raw를 보존하며 계산용 clamped = max(0, raw). */
  predict(date: IsoDate): { raw: number; clamped: number };
}

export interface UnfittedModel {
  status: "no_forecast";
  reason: "insufficient_observations" | "rank_deficient";
  nObserved: number;
}

export type ForecastModelResult = FittedModel | UnfittedModel;

function dowDummyRow(dow: number): number[] {
  // 0=Sun..6=Sat. 일요일을 기준(모두 0)으로 두고 월~토 6개 더미.
  const row = [0, 0, 0, 0, 0, 0];
  if (dow >= 1 && dow <= 6) row[dow - 1] = 1;
  return row;
}

/**
 * 최근 180일 관측치로 모델을 학습한다.
 * missing/not_observed 날짜는 학습 입력에서 제외한다 (0으로 대체하지 않음).
 * 계수 추정에 필요한 관측치가 부족하거나 설계행렬 rank가 부족하면 no_forecast를 반환한다.
 */
export function trainDemandModel(
  observations: DailyObservation[],
  modelVersion: string,
): ForecastModelResult {
  const sorted = [...observations].sort((a, b) => (a.date < b.date ? -1 : 1));
  const observed = sorted.filter((o) => o.status === "observed");
  const nMissing = sorted.filter((o) => o.status === "missing").length;

  if (observed.length < MIN_OBSERVATIONS_TO_FIT) {
    return { status: "no_forecast", reason: "insufficient_observations", nObserved: observed.length };
  }

  const dayIndexOf = new Map<IsoDate, number>();
  sorted.forEach((o, i) => dayIndexOf.set(o.date, i));

  const rawDayIndices = observed.map((o) => dayIndexOf.get(o.date)!);
  const mean = rawDayIndices.reduce((a, b) => a + b, 0) / rawDayIndices.length;
  const variance =
    rawDayIndices.reduce((acc, v) => acc + (v - mean) ** 2, 0) / rawDayIndices.length;
  const std = Math.sqrt(variance) || 1; // 관측일이 1일뿐이면 표준편차 0 → 1로 방어

  const X = observed.map((o) => {
    const idx = dayIndexOf.get(o.date)!;
    const centeredScaledDay = (idx - mean) / std;
    return [1, centeredScaledDay, ...dowDummyRow(dayOfWeek(o.date))];
  });
  const y = observed.map((o) => [o.netQty ?? 0]);

  const Xm = new Matrix(X);
  const ym = new Matrix(y);

  const svd = new SVD(Xm, { autoTranspose: false });
  const rank = svd.rank;
  if (rank < COEFFICIENT_COUNT) {
    return { status: "no_forecast", reason: "rank_deficient", nObserved: observed.length };
  }

  const betaMatrix = svd.solve(ym);
  const coefficients = betaMatrix.to1DArray();

  const warningCodes: ForecastWarningCode[] = [];
  if (observed.length < SHORT_HISTORY_WARNING_THRESHOLD_DAYS) warningCodes.push("short_history");
  if (nMissing > 0 || sorted.some((o) => o.status === "not_observed")) {
    warningCodes.push("incomplete_window");
  }

  const trainingStart = sorted[0].date;
  const trainingEnd = sorted[sorted.length - 1].date;
  const lastKnownIndex = sorted.length - 1;

  function predict(date: IsoDate): { raw: number; clamped: number } {
    // 학습 구간 이후 날짜의 day_index는 시퀀스를 이어서 확장한다.
    const idx = dayIndexOf.has(date)
      ? dayIndexOf.get(date)!
      : lastKnownIndex + daysBetweenSorted(trainingEnd, date);
    const centeredScaledDay = (idx - mean) / std;
    const row = [1, centeredScaledDay, ...dowDummyRow(dayOfWeek(date))];
    const raw = row.reduce((acc, v, i) => acc + v * coefficients[i], 0);
    return { raw, clamped: Math.max(0, raw) };
  }

  return {
    status: "fitted",
    modelVersion,
    trainingStart,
    trainingEnd,
    nObserved: observed.length,
    nMissing,
    coefficients,
    dayIndexMean: mean,
    dayIndexStd: std,
    warningCodes,
    predict,
  };
}

function daysBetweenSorted(from: IsoDate, to: IsoDate): number {
  return dateRange(from, to).length - 1;
}

export interface BacktestResult {
  mae: number;
  wape: number | null; // 분모(실제값 절대합)가 0이면 N/A
  n: number;
}

/**
 * 시간순 검증: 확보된 180일 안에서 마지막 28일의 각 날짜를 그 이전 자료만으로 예측한다.
 * 미래 자료를 학습에 섞지 않는다.
 */
export function timeSeriesBacktest(
  observations: DailyObservation[],
  modelVersion: string,
  holdoutDays = 28,
): BacktestResult | { status: "insufficient_data" } {
  const result = evaluateForecast(observations, rows => {
    const model = trainDemandModel(rows,modelVersion);
    return model.status === "fitted" ? date => model.predict(date).clamped : null;
  },holdoutDays);
  return result.status === "insufficient_data" ? {status:"insufficient_data"} : {
    mae: result.mae!, wape: result.wape, n: result.n,
  };
}
