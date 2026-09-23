import { describe,it,expect } from "vitest";
import { evaluateForecast,trackNegativeForecasts,type QualityObservation } from "../supabase/functions/_shared/forecastQuality";
import { trainDemandModel } from "../src/lib/regression";
import { addCalendarDays } from "../src/lib/date";
import { forecastWarningLabel } from "../src/lib/forecastWarnings";
const data = (n:number,fn:(i:number)=>number):QualityObservation[] => Array.from({length:n},(_,i)=>({
  date:addCalendarDays("2026-03-01",i),status:"observed",netQty:fn(i),
}));
const train = (rows:QualityObservation[]) => {
  const model=trainDemandModel(rows,"ols-v1");
  return model.status==="fitted" ? (date:string)=>model.predict(date).clamped : null;
};
describe("operational forecast evaluation",()=>{
  it("holds out each actual target and never trains on its future",()=>{
    const result=evaluateForecast(data(60,()=>10),rows=> date=>{
      expect(rows.every(r=>r.date<date)).toBe(true);
      return 10;
    });
    expect(result).toMatchObject({status:"evaluated",n:28,mae:0,wape:0,baseline_mae:0,partial:false});
  });
  it("evaluates deployed OLS style predictions against the same-origin mean",()=>{
    const result=evaluateForecast(data(90,i=>20+i),train);
    expect(result.n).toBe(28);
    expect(result.mae!).toBeLessThan(1e-8);
    expect(result.baseline_mae!).toBeGreaterThan(20);
  });
  it("32 observed days yield a labelled partial evaluation, not fake 28-day accuracy",()=>{
    const result=evaluateForecast(data(32,()=>10),train);
    expect(result.n).toBe(24);
    expect(result.partial).toBe(true);
  });
  it("zero actual demand has no WAPE denominator",()=>{
    const result=evaluateForecast(data(60,()=>0),train);
    expect(result).toMatchObject({n:28,mae:0,wape:null,baseline_wape:null});
  });
  it("missing and pre-observation days are not zero-valued holdouts",()=>{
    const rows=data(60,()=>10);
    rows[50].status="missing";rows[51].status="not_observed";
    const result=evaluateForecast(rows,train);
    expect(result.n).toBe(26);
    expect(result.observed_days).toBe(26);
    expect(result.partial).toBe(true);
  });
  it("rank-deficient and insufficient history stays unevaluated",()=>{
    expect(evaluateForecast(data(7,()=>10),train)).toMatchObject({status:"insufficient_data",n:0,mae:null,wape:null});
    expect(evaluateForecast(data(60,()=>10),()=>null).n).toBe(0);
  });
  it("failed numeric computation never yields an apparently valid score",()=>{
    expect(()=>evaluateForecast(data(60,()=>10),()=>()=>NaN)).toThrow("NON_FINITE");
  });
});
describe("negative forecasts",()=>{
  it("preserves raw negatives, applies zero, and deduplicates dates",()=>{
    const tracked=trackNegativeForecasts(()=>-4.5);
    expect(tracked.predict("2026-09-24")).toBe(0);
    tracked.predict("2026-09-24");
    expect(tracked.negatives()).toEqual([{date:"2026-09-24",raw:-4.5,applied:0}]);
    expect(forecastWarningLabel("negative_forecast")).toContain("음수 예측");
  });
  it("positive and zero predictions are unchanged and do not create a warning",()=>{
    const tracked=trackNegativeForecasts(d=>d==="a"?0:8);
    expect(tracked.predict("a")).toBe(0);expect(tracked.predict("b")).toBe(8);
    expect(tracked.negatives()).toEqual([]);
  });
  it("rejects non-finite predictions",()=>{
    expect(()=>trackNegativeForecasts(()=>Infinity).predict("2026-09-24")).toThrow("NON_FINITE");
  });
});
