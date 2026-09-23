// 예측·추천 배치 Edge Function. 상세_알고리즘_설계.md §5~7, 시스템_구조_설계.md "계산과 정기 작업".
//
// recompute_queue에서 작은 배치(기본 20품목)를 가져와 회귀모델을 갱신하고 추천을 계산한다.
// Deno 런타임은 src/lib의 TS 모듈을 tsconfig 경로("@/*")나 번들러 없이 바로 가져올 수 없으므로
// 핵심 계산식을 이 파일에 이식했다. src/lib/regression.ts·recommendation.ts·inventoryAnchor.ts와
// 로직이 갈라지지 않도록, 두 쪽을 수정할 때는 항상 함께 확인한다.
//
// 미구현 범위 (docs/미확인_항목.md 참고, 완료로 표시하지 않음):
//  - 실사·최근입고 시각 비교에서 같은 시각에 걸친 사건의 순서(included_event_seq)는 occurred_at
//    단순 비교로 근사했다. 초 단위까지 같은 시각이 실제로 발생하면 정확하지 않을 수 있다.
//  - 이 함수는 실제 Supabase 프로젝트에 배포해 실행 로그로 검증한 적이 없다.
//
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (Supabase가 자동 주입)

import { createClient } from "npm:@supabase/supabase-js@2";
import { Matrix, SVD } from "npm:ml-matrix@6";

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

  function predict(date: IsoDate): number {
    const idx = dayIndexOf.has(date)
      ? dayIndexOf.get(date)!
      : lastIdx + (dateRange(trainingEnd, date).length - 1);
    const row = [1, (idx - mean) / std, ...dowDummyRow(dow(date))];
    const raw = row.reduce((acc, v, i) => acc + v * beta[i], 0);
    return Math.max(0, raw);
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
    predict,
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
  dailyMap: Map<string, number>,
  predict: (d: IsoDate) => number,
): Promise<ReferenceResult | null> {
  const { data: lastCountRows } = await supabase
    .from("quantity_events")
    .select("occurred_at, qty_base, day_boundary")
    .eq("product_id", productId)
    .eq("kind", "count")
    .eq("active", true)
    .order("occurred_at", { ascending: false })
    .limit(1);
  const lastCount = lastCountRows?.[0];

  if (lastCount) {
    const countDate = (lastCount.occurred_at as string).slice(0, 10);
    const isEndOfDay = lastCount.day_boundary === "end_of_day";

    let midDayCorrection = 0;
    let midDayCorrectionApplied = false;
    if (!isEndOfDay) {
      midDayCorrection = predict(countDate);
      midDayCorrectionApplied = true;
    }

    const { data: afterEvents } = await supabase
      .from("quantity_events")
      .select("kind, qty_base")
      .eq("product_id", productId)
      .eq("active", true)
      .in("kind", ["receipt", "stock_adjustment"])
      .gt("occurred_at", lastCount.occurred_at);
    const receiptsAfter = (afterEvents ?? [])
      .filter((e: { kind: string }) => e.kind === "receipt")
      .reduce((a: number, e: { qty_base: number }) => a + e.qty_base, 0);
    const adjustmentsAfter = (afterEvents ?? [])
      .filter((e: { kind: string }) => e.kind === "stock_adjustment")
      .reduce((a: number, e: { qty_base: number }) => a + e.qty_base, 0);

    const dayAfterCount = addDays(countDate, 1);
    const actualRange = dateRange(dayAfterCount, today);
    let actualSum = 0;
    let dataInsufficient = false;
    for (const d of actualRange) {
      const v = dailyMap.get(d);
      if (v === undefined) dataInsufficient = true;
      else actualSum += v;
    }
    const forecastStart = dayAfterCount > addDays(today, 1) ? dayAfterCount : addDays(today, 1);
    const forecastSum = dateRange(forecastStart, arrival).reduce((acc, d) => acc + predict(d), 0);

    const value = lastCount.qty_base + receiptsAfter + adjustmentsAfter - midDayCorrection - actualSum - forecastSum;
    return {
      value,
      anchorKind: "stock_count",
      anchorDate: countDate,
      anchorQty: lastCount.qty_base,
      dataInsufficient,
      forecastUnavailable: false,
      midDayCorrectionApplied,
    };
  }

  const { data: lastReceiptRows } = await supabase
    .from("quantity_events")
    .select("occurred_at, qty_base")
    .eq("product_id", productId)
    .eq("kind", "receipt")
    .eq("active", true)
    .order("occurred_at", { ascending: false })
    .limit(1);
  if (!lastReceiptRows || lastReceiptRows.length === 0) return null;

  const B = (lastReceiptRows[0].occurred_at as string).slice(0, 10);
  const { data: receiptsOnB } = await supabase
    .from("quantity_events")
    .select("qty_base")
    .eq("product_id", productId)
    .eq("kind", "receipt")
    .eq("active", true)
    .gte("occurred_at", `${B}T00:00:00+09:00`)
    .lt("occurred_at", `${addDays(B, 1)}T00:00:00+09:00`);
  const Q = (receiptsOnB ?? []).reduce((a: number, r: { qty_base: number }) => a + r.qty_base, 0);

  const actualRange = B <= today ? dateRange(B, today) : [];
  let actualSum = 0;
  let dataInsufficient = false;
  for (const d of actualRange) {
    const v = dailyMap.get(d);
    if (v === undefined) dataInsufficient = true;
    else actualSum += v;
  }
  const forecastStart = B > addDays(today, 1) ? B : addDays(today, 1);
  const forecastSum = dateRange(forecastStart, arrival).reduce((acc, d) => acc + predict(d), 0);
  const value = Q - actualSum - forecastSum;

  return {
    value,
    anchorKind: "last_receipt",
    anchorDate: B,
    anchorQty: Q,
    dataInsufficient,
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

  // 대기 중인 작업을 먼저 "처리 중"으로 표시해 선점(lease)한다. 다른 동시 실행이 같은 품목을
  // 다시 집어가지 않도록 하기 위함이다 (시스템_구조_설계.md "중복 실행 잠금").
  const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
  const { data: candidateRows, error: candidateError } = await supabase
    .from("recompute_queue")
    .select("product_id, required_revision, need_training, attempts")
    .in("status", ["pending"])
    .limit(BATCH_SIZE);
  if (candidateError) {
    return new Response(`QUEUE_READ_ERROR: ${candidateError.message}`, { status: 500 });
  }
  // 오래 멈춘(리스 만료) processing 항목도 되찾아온다.
  const { data: staleRows } = await supabase
    .from("recompute_queue")
    .select("product_id, required_revision, need_training, attempts")
    .eq("status", "processing")
    .lt("lease_until", new Date().toISOString())
    .limit(BATCH_SIZE);

  const queueRows = [...(candidateRows ?? []), ...(staleRows ?? [])].slice(0, BATCH_SIZE);
  if (queueRows.length === 0) {
    return new Response(JSON.stringify({ processed: 0 }), { headers: { "content-type": "application/json" } });
  }

  const claimedIds = queueRows.map((r) => r.product_id);
  await supabase
    .from("recompute_queue")
    .update({ status: "processing", lease_until: leaseUntil })
    .in("product_id", claimedIds);

  const today = new Date().toISOString().slice(0, 10);
  const windowStart = addDays(today, -(TRAINING_WINDOW_DAYS - 1));

  const { data: holidayRows } = await supabase
    .from("holiday_dates")
    .select("holiday_date")
    .gte("holiday_date", today)
    .lte("holiday_date", addDays(today, 30));
  const holidaySet = new Set((holidayRows ?? []).map((h) => h.holiday_date as string));
  const { data: coverageRows } = await supabase
    .from("holiday_sync_runs")
    .select("coverage_start, coverage_end")
    .eq("status", "success")
    .order("fetched_at", { ascending: false })
    .limit(1);
  const coverage = coverageRows?.[0];
  const isCovered = (d: IsoDate) =>
    !!coverage && d >= (coverage.coverage_start as string) && d <= (coverage.coverage_end as string);

  const results: Array<{ product_id: string; status: string }> = [];

  for (const row of queueRows) {
    const productId = row.product_id as string;
    try {
      const { data: product } = await supabase
        .from("products")
        .select("id, observed_from, default_moq, default_order_step")
        .eq("id", productId)
        .single();
      if (!product) throw new Error("PRODUCT_NOT_FOUND");

      const { data: dailyRows } = await supabase
        .from("sales_daily")
        .select("sale_date, net_qty")
        .eq("product_id", productId)
        .gte("sale_date", windowStart)
        .lte("sale_date", today);
      const { data: coverageDaily } = await supabase
        .from("sales_coverage")
        .select("sale_date, status")
        .gte("sale_date", windowStart)
        .lte("sale_date", today);

      const dailyMap = new Map((dailyRows ?? []).map((r) => [r.sale_date as string, r.net_qty as number]));
      const coverageMap = new Map((coverageDaily ?? []).map((r) => [r.sale_date as string, r.status as string]));

      const observations: Observation[] = dateRange(windowStart, today).map((d) => {
        if (d < (product.observed_from as string)) return { date: d, status: "not_observed" };
        if (coverageMap.get(d) !== "complete") return { date: d, status: "missing" };
        return { date: d, status: "observed", netQty: dailyMap.get(d) ?? 0 };
      });

      const model = trainModel(observations);

      if (model.status === "fitted") {
        await supabase.from("forecast_models").upsert({
          product_id: productId,
          model_version: "ols-v1",
          training_start: model.trainingStart,
          training_end: model.trainingEnd,
          n_observed: model.nObserved,
          n_missing: model.nMissing,
          coefficients: model.coefficients,
          warning_codes: model.warningCodes,
          input_revision: row.required_revision,
          computed_at: new Date().toISOString(),
        });

        // 참고값(inventory_anchors) 갱신과 추천 생성은 도착일을 함께 필요로 하므로
        // 공휴일 자료가 확보된 경우에만 수행한다. 공휴일 자료가 없다고 참고값 계산 자체를
        // 영구히 건너뛰지는 않는다 — 다음 배치 실행 때 공휴일 캐시가 채워지면 갱신된다.
        if (isCovered(today)) {
          const arrival = calculateArrivalDate(today, isCovered, (d) => holidaySet.has(d));
          if (arrival) {
            const reference = await computeArrivalReference(
              supabase,
              productId,
              today,
              arrival,
              dailyMap,
              model.predict,
            );

            if (reference) {
              await supabase.from("inventory_anchors").upsert({
                product_id: productId,
                kind: reference.anchorKind,
                anchor_date: reference.anchorDate,
                sales_start_date: reference.anchorDate,
                qty_base: reference.anchorQty,
                sales_before_start: 0,
                estimated_first_day_sales: reference.midDayCorrectionApplied
                  ? model.predict(reference.anchorDate)
                  : null,
                model_version: "ols-v1",
                revision: 1,
                updated_at: new Date().toISOString(),
              });
            }

            if (reference && reference.value <= 0 && product.default_moq && product.default_order_step) {
              const sevenDay = dateRange(arrival, addDays(arrival, 6)).reduce(
                (acc, d) => acc + model.predict(d),
                0,
              );
              const M = product.default_moq as number;
              const U = product.default_order_step as number;
              const target = Math.max(M, sevenDay);
              const qty = U * Math.ceil(Math.round((target / U) * 1e6) / 1e6);
              const basis = {
                reference_kind: reference.anchorKind,
                reference_value: reference.value,
                reference_data_insufficient: reference.dataInsufficient,
                seven_day_demand: sevenDay,
                warning_codes: model.warningCodes,
                model_version: "ols-v1",
              };

              // recommendations는 "품목별 미종결 추천 최대 1개"라는 부분 유니크 인덱스
              // (status <> 'received')만 가지고 있어 supabase-js의 일반 upsert(onConflict)로는
              // 조건부 인덱스를 매칭시킬 수 없다. 열려 있는 추천이 있으면 갱신, 없으면 새로 만든다.
              const { data: openRec } = await supabase
                .from("recommendations")
                .select("id, status")
                .eq("product_id", productId)
                .neq("status", "received")
                .maybeSingle();

              if (openRec && openRec.status === "review") {
                await supabase
                  .from("recommendations")
                  .update({
                    arrival_date: arrival,
                    recommended_qty: qty,
                    basis_json: basis,
                    input_revision: row.required_revision,
                  })
                  .eq("id", openRec.id);
              } else if (!openRec) {
                await supabase.from("recommendations").insert({
                  product_id: productId,
                  status: "review",
                  decision: "active",
                  arrival_date: arrival,
                  recommended_qty: qty,
                  basis_json: basis,
                  input_revision: row.required_revision,
                });
              }
              // openRec.status === 'waiting'인 경우는 FR-28대로 기존 발주를 재생성하지 않는다.
            }
          }
        }
      }

      await supabase
        .from("recompute_queue")
        .update({ status: "done", updated_at: new Date().toISOString() })
        .eq("product_id", productId);
      results.push({ product_id: productId, status: "done" });
    } catch (e) {
      await supabase
        .from("recompute_queue")
        .update({
          status: "error",
          last_error: String(e),
          attempts: ((row as { attempts?: number }).attempts ?? 0) + 1,
        })
        .eq("product_id", productId);
      results.push({ product_id: productId, status: "error" });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "content-type": "application/json" },
  });
});
