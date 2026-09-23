// 예측·추천 배치 Edge Function. 상세_알고리즘_설계.md §5~7, 시스템_구조_설계.md "계산과 정기 작업".
//
// recompute_queue에서 작은 배치(기본 20품목)를 가져와 회귀모델을 갱신하고 추천을 계산한다.
// Deno 런타임은 src/lib의 TS 모듈을 tsconfig 경로("@/*")나 번들러 없이 바로 가져올 수 없으므로
// 핵심 계산식을 이 파일에 이식했다. src/lib/regression.ts·recommendation.ts·inventoryAnchor.ts와
// 로직이 갈라지지 않도록, 두 쪽을 수정할 때는 항상 함께 확인한다.
//
// 판매 차감은 reference_sales_total RPC로 보존기간 밖 누적분까지 읽는다.
// 이 변경은 migration 0020 적용 후 배포한다. 실제 iPhone OCR/예측 정확도는 별도 현장 검증 대상이다.
//
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Supabase가 자동 주입)

import { createClient } from "npm:@supabase/supabase-js@2";
import { Matrix, SVD } from "npm:ml-matrix@6";
import { businessDate, hasHolidayCoverage } from "./holidayCoverage.ts";
import { evaluateForecast, trackNegativeForecasts } from "../_shared/forecastQuality.ts";

const BATCH_SIZE = 20;
const COEFFICIENT_COUNT = 8;
const TRAINING_WINDOW_DAYS = 180;

type IsoDate = string;

function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function dow(date: IsoDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function dateRange(start: IsoDate, end: IsoDate): IsoDate[] {
  if (start > end) return [];
  const out: IsoDate[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}
function dowDummyRow(d: number): number[] {
  const row = [0, 0, 0, 0, 0, 0];
  if (d >= 1 && d <= 6) row[d - 1] = 1;
  return row;
}

interface Observation {
  date: IsoDate;
  status: "observed" | "missing" | "not_observed";
  netQty?: number;
}

function trainModel(observations: Observation[]) {
  const sorted = [...observations].sort((a, b) => (a.date < b.date ? -1 : 1));
  const observed = sorted.filter((o) => o.status === "observed");
  const nMissing = sorted.filter((o) => o.status === "missing").length;
  if (observed.length < COEFFICIENT_COUNT) {
    return { status: "no_forecast" as const, reason: "insufficient_observations", nObserved: observed.length };
  }
  const dayIndexOf = new Map<IsoDate, number>();
  sorted.forEach((o, i) => dayIndexOf.set(o.date, i));
  const idxs = observed.map((o) => dayIndexOf.get(o.date)!);
  const mean = idxs.reduce((a, b) => a + b, 0) / idxs.length;
  const variance = idxs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / idxs.length;
  const std = Math.sqrt(variance) || 1;

  const X = observed.map((o) => {
    const idx = dayIndexOf.get(o.date)!;
    return [1, (idx - mean) / std, ...dowDummyRow(dow(o.date))];
  });
  const y = observed.map((o) => [o.netQty ?? 0]);
  const Xm = new Matrix(X);
  const ym = new Matrix(y);
  const svd = new SVD(Xm, { autoTranspose: false });
  if (svd.rank < COEFFICIENT_COUNT) {
    return { status: "no_forecast" as const, reason: "rank_deficient", nObserved: observed.length };
  }
  const beta = svd.solve(ym).to1DArray();
  const lastIdx = sorted.length - 1;
  const trainingEnd = sorted[sorted.length - 1].date;

  function predictRaw(date: IsoDate): number {
    const idx = dayIndexOf.has(date)
      ? dayIndexOf.get(date)!
      : lastIdx + (dateRange(trainingEnd, date).length - 1);
    const row = [1, (idx - mean) / std, ...dowDummyRow(dow(date))];
    const raw = row.reduce((acc, v, i) => acc + v * beta[i], 0);
    return raw;
  }

  const warningCodes: string[] = [];
  if (observed.length < 56) warningCodes.push("short_history");
  if (nMissing > 0 || sorted.some((o) => o.status === "not_observed")) warningCodes.push("incomplete_window");

  return {
    status: "fitted" as const,
    coefficients: beta,
    nObserved: observed.length,
    nMissing,
    trainingStart: sorted[0].date,
    trainingEnd,
    warningCodes,
    predict: (date: IsoDate) => Math.max(0,predictRaw(date)),
    predictRaw,
  };
}

function calculateArrivalDate(
  orderDate: IsoDate,
  isCovered: (d: IsoDate) => boolean,
  isOfficialHoliday: (d: IsoDate) => boolean,
): IsoDate | null {
  let day = orderDate;
  let businessDays = 0;
  for (let i = 0; i < 366 && businessDays < 2; i++) {
    day = addDays(day, 1);
    if (!isCovered(day)) return null; // 도착일 미확정
    const d = dow(day);
    if (d === 0 || d === 6) continue;
    if (isOfficialHoliday(day)) continue;
    businessDays++;
  }
  return businessDays === 2 ? day : null;
}

interface ReferenceResult {
  value: number;
  anchorKind: "stock_count" | "last_receipt";
  anchorDate: IsoDate;
  anchorQty: number;
  dataInsufficient: boolean;
  historyUnavailable: boolean;
  forecastUnavailable: boolean;
  midDayCorrectionApplied: boolean;
}

/**
 * 품목의 도착일 말 예상 참고량을 계산한다. 실사 기록이 있으면 실사 기준(§6 "실사 있는 품목"),
 * 없으면 최근 입고 기준(§6 "실사 없는 품목")을 쓴다. null이면 아직 참고값을 계산할 수 없다
 * (입고가 한 번도 없음).
 */
async function computeArrivalReference(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  productId: string,
  today: IsoDate,
  arrival: IsoDate,
  predict: (d: IsoDate) => number,
): Promise<ReferenceResult | null> {
  const actualSales = async (start: IsoDate) => {
    const { data, error } = await supabase.rpc("reference_sales_total", {
      p_product_id: productId, p_start: start, p_end: today,
    });
    if (error) throw error;
    if (!data || !Number.isFinite(Number(data.net_qty))) throw new Error("INVALID_REFERENCE_TOTAL");
    return { sum: Number(data.net_qty), insufficient: data.missing_days > 0,
      unavailable: Boolean(data.history_unavailable) };
  };
  const { data: lastCountRows, error: countError } = await supabase
    .from("quantity_events")
    .select("occurred_at, qty_base, day_boundary, recorded_seq")
    .eq("product_id", productId)
    .eq("kind", "count")
    .eq("active", true)
    .order("occurred_at", { ascending: false })
    .order("recorded_seq", { ascending: false })
    .limit(1);
  if (countError) throw countError;
  const lastCount = lastCountRows?.[0];

  if (lastCount) {
    const countDate = businessDate(new Date(lastCount.occurred_at));
    const isEndOfDay = lastCount.day_boundary === "end_of_day";

    let midDayCorrection = 0;
    let midDayCorrectionApplied = false;
    if (!isEndOfDay) {
      midDayCorrection = predict(countDate);
      midDayCorrectionApplied = true;
    }

    const { data: afterEvents, error: eventsError } = await supabase
      .from("quantity_events")
      .select("kind, qty_base, occurred_at, recorded_seq")
      .eq("product_id", productId)
      .eq("active", true)
      .in("kind", ["receipt", "stock_adjustment"])
      .gte("occurred_at", lastCount.occurred_at);
    if (eventsError) throw eventsError;
    const followingEvents = (afterEvents ?? []).filter((e: { occurred_at: string; recorded_seq: number }) =>
      e.occurred_at !== lastCount.occurred_at || e.recorded_seq > lastCount.recorded_seq);
    const receiptsAfter = followingEvents
      .filter((e: { kind: string }) => e.kind === "receipt")
      .reduce((a: number, e: { qty_base: number }) => a + e.qty_base, 0);
    const adjustmentsAfter = followingEvents
      .filter((e: { kind: string }) => e.kind === "stock_adjustment")
      .reduce((a: number, e: { qty_base: number }) => a + e.qty_base, 0);

    const dayAfterCount = addDays(countDate, 1);
    const actual = await actualSales(dayAfterCount);
    const forecastStart = dayAfterCount > addDays(today, 1) ? dayAfterCount : addDays(today, 1);
    const forecastSum = dateRange(forecastStart, arrival).reduce((acc, d) => acc + predict(d), 0);

    const value = lastCount.qty_base + receiptsAfter + adjustmentsAfter - midDayCorrection - actual.sum - forecastSum;
    return {
      value,
      anchorKind: "stock_count",
      anchorDate: countDate,
      anchorQty: lastCount.qty_base,
      dataInsufficient: actual.insufficient,
      historyUnavailable: actual.unavailable,
      forecastUnavailable: false,
      midDayCorrectionApplied,
    };
  }

  const { data: lastReceiptRows, error: receiptError } = await supabase
    .from("quantity_events")
    .select("occurred_at, qty_base")
    .eq("product_id", productId)
    .eq("kind", "receipt")
    .eq("active", true)
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (receiptError) throw receiptError;
  if (!lastReceiptRows || lastReceiptRows.length === 0) return null;

  const B = businessDate(new Date(lastReceiptRows[0].occurred_at));
  const { data: receiptsOnB, error: receiptDayError } = await supabase
    .from("quantity_events")
    .select("qty_base")
    .eq("product_id", productId)
    .eq("kind", "receipt")
    .eq("active", true)
    .gte("occurred_at", `${B}T00:00:00+09:00`)
    .lt("occurred_at", `${addDays(B, 1)}T00:00:00+09:00`);
  if (receiptDayError) throw receiptDayError;
  const Q = (receiptsOnB ?? []).reduce((a: number, r: { qty_base: number }) => a + r.qty_base, 0);

  const actual = await actualSales(B);
  const forecastStart = B > addDays(today, 1) ? B : addDays(today, 1);
  const forecastSum = dateRange(forecastStart, arrival).reduce((acc, d) => acc + predict(d), 0);
  const value = Q - actual.sum - forecastSum;

  return {
    value,
    anchorKind: "last_receipt",
    anchorDate: B,
    anchorQty: Q,
    dataInsufficient: actual.insufficient,
    historyUnavailable: actual.unavailable,
    forecastUnavailable: false,
    midDayCorrectionApplied: false,
  };
}

Deno.serve(async (_req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("MISSING_SUPABASE_ENV", { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const today = businessDate();
  const windowStart = addDays(today, -(TRAINING_WINDOW_DAYS - 1));
  // Read prerequisites before taking leases. Failed reads must never look like empty data.
  const { data: holidayRows, error: holidayError } = await supabase
    .from("holiday_dates").select("holiday_date")
    .gte("holiday_date", today).lte("holiday_date", addDays(today, 366));
  const { data: coverageRows, error: coverageError } = await supabase
    .from("holiday_sync_runs").select("coverage_start, coverage_end")
    .in("status", ["success", "empty_confirmed"])
    .gte("coverage_end", today).lte("coverage_start", addDays(today, 366));
  if (holidayError || coverageError) {
    return new Response("HOLIDAY_READ_ERROR", { status: 500 });
  }
  const holidaySet = new Set((holidayRows ?? []).map((h) => h.holiday_date as string));
  const isCovered = (d: IsoDate) => hasHolidayCoverage(d, coverageRows ?? []);

  const { data: queueRows, error: claimError } = await supabase.rpc("claim_recompute_batch", {
    p_batch_size: BATCH_SIZE, p_lease_seconds: 300,
  });
  if (claimError) return new Response("QUEUE_CLAIM_ERROR", { status: 500 });

  const results: Array<{ product_id: string; status: string }> = [];
  for (const row of queueRows ?? []) {
    const productId = row.product_id as string;
    const finish = async (status: string, result: Record<string, unknown>, error: string | null = null) => {
      const { data, error: rpcError } = await supabase.rpc("finish_recompute_item", {
        p_product_id: productId, p_lease_token: row.lease_token,
        p_required_revision: row.required_revision, p_status: status,
        p_result: result, p_error: error,
      });
      if (rpcError) throw rpcError;
      return data as string;
    };
    try {
      const { data: product, error: productError } = await supabase.from("products")
        .select("id, observed_from, default_moq, default_order_step")
        .eq("id", productId).single();
      if (productError) throw productError;
      if (!product) throw new Error("PRODUCT_NOT_FOUND");

      const { data: dailyRows, error: dailyError } = await supabase.from("sales_daily")
        .select("sale_date, net_qty").eq("product_id", productId)
        .gte("sale_date", windowStart).lte("sale_date", today);
      const { data: coverageDaily, error: dailyCoverageError } = await supabase.from("sales_coverage")
        .select("sale_date, status").gte("sale_date", windowStart).lte("sale_date", today);
      if (dailyError) throw dailyError;
      if (dailyCoverageError) throw dailyCoverageError;
      const dailyMap = new Map((dailyRows ?? []).map((r) => [r.sale_date as string, r.net_qty as number]));
      const coverageMap = new Map((coverageDaily ?? []).map((r) => [r.sale_date as string, r.status as string]));
      const observations: Observation[] = dateRange(windowStart, today).map((d) => {
        if (d < product.observed_from) return { date: d, status: "not_observed" };
        if (coverageMap.get(d) !== "complete") return { date: d, status: "missing" };
        return { date: d, status: "observed", netQty: dailyMap.get(d) ?? 0 };
      });
      const model = trainModel(observations);
      // Nothing is written until the server validates the lease AND revision in one transaction.
      const result: Record<string, unknown> = {};
      let reason: string | null = null;
      if (model.status !== "fitted") {
        reason = "insufficient_history";
      } else {
        const tracked = trackNegativeForecasts(model.predictRaw);
        const evaluation = evaluateForecast(observations, rows => {
          const fitted = trainModel(rows);
          return fitted.status === "fitted" ? fitted.predict : null;
        });
        const arrival = isCovered(today)
          ? calculateArrivalDate(today, isCovered, (d) => holidaySet.has(d)) : null;
        // Warnings remain visible even without a receipt, MOQ, or recommendation.
        // Evaluate the operational arrival+7-day horizon; if holidays are unavailable,
        // use a clearly bounded 14-day diagnostic horizon, not an invented arrival date.
        const diagnosticEnd = arrival ? addDays(arrival,6) : addDays(today,14);
        for (const d of dateRange(addDays(today,1),diagnosticEnd)) tracked.predict(d);
        if (!arrival) {
          reason = "holiday_missing";
        } else {
          const reference = await computeArrivalReference(supabase, productId, today, arrival, tracked.predict);
          if (!reference) {
            reason = "reference_missing";
          } else {
            result.anchor = {
              kind: reference.anchorKind, anchor_date: reference.anchorDate,
              qty_base: reference.anchorQty,
              estimated_first_day_sales: reference.midDayCorrectionApplied
                ? tracked.predict(reference.anchorDate) : null,
            };
            if (reference.historyUnavailable) reason = "historical_sales_missing";
            else if (!product.default_moq) reason = "moq_missing";
            else if (!product.default_order_step) reason = "unit_missing";
            else if (reference.value <= 0) {
              const sevenDay = dateRange(arrival, addDays(arrival, 6)).reduce((sum, d) => sum + tracked.predict(d), 0);
              const target = Math.max(product.default_moq, sevenDay);
              const step = product.default_order_step as number;
              result.recommendation = {
                arrival_date: arrival,
                recommended_qty: step * Math.ceil(Math.round(target / step * 1e6) / 1e6),
                basis_json: {
                  reference_kind: reference.anchorKind, reference_value: reference.value,
                  reference_data_insufficient: reference.dataInsufficient,
                  seven_day_demand: sevenDay, warning_codes: model.warningCodes, model_version: "ols-v1",
                },
              };
            }
          }
        }
        const negativeForecasts = tracked.negatives();
        if (negativeForecasts.length) model.warningCodes.push("negative_forecast");
        const diagnostics = {
          evaluation, negative_forecasts: negativeForecasts,
          diagnostic_start: addDays(today,1), diagnostic_end: diagnosticEnd,
        };
        result.model = {
          model_version: "ols-v1", training_start: model.trainingStart, training_end: model.trainingEnd,
          n_observed: model.nObserved, n_missing: model.nMissing,
          coefficients: model.coefficients, warning_codes: model.warningCodes, ...diagnostics,
        };
        const recommendation = result.recommendation as {basis_json: Record<string,unknown>} | undefined;
        if (recommendation) Object.assign(recommendation.basis_json,diagnostics);
      }
      result.calc_reason = reason;
      results.push({ product_id: productId, status: await finish(reason ? "blocked" : "done", result) });
    } catch (e) {
      try {
        results.push({ product_id: productId, status: await finish("error", {}, String(e)) });
      } catch (finishError) {
        // Leave the lease intact: its expiry permits recovery instead of losing the job.
        console.error("QUEUE_FINISH_ERROR", productId, String(finishError));
        results.push({ product_id: productId, status: "error" });
      }
    }
  }
  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "content-type": "application/json" },
  });
});
