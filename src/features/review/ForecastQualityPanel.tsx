import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import type { ForecastEvaluation, NegativeForecast } from "../../../supabase/functions/_shared/forecastQuality";
import { forecastWarningLabel } from "@/lib/forecastWarnings";

interface QualityRow {
  product_id: string; name: string; spec: string; base_unit: string;
  training_end: string | null; computed_at: string | null; n_observed: number | null;
  evaluation: Partial<ForecastEvaluation>;
  negative_forecasts: NegativeForecast[]; warning_codes: string[]; is_stale: boolean;
}
const number = (v: number | null | undefined) => v == null ? "—" : v.toLocaleString("ko-KR",{maximumFractionDigits:3});
const percent = (v: number | null | undefined) => v == null ? "N/A" : `${(v*100).toFixed(1)}%`;

export function ForecastQualityPanel() {
  const [open,setOpen] = useState(false);
  const [query,setQuery] = useState("");
  const [negativeOnly,setNegativeOnly] = useState(false);
  const [page,setPage] = useState(0);
  const { data,error,isFetching } = useQuery({
    queryKey:["forecast_quality",query,negativeOnly,page],
    enabled:open,
    queryFn:async () => {
      const {data,error}=await supabase.rpc("forecast_quality_page",{p_query:query,p_negative_only:negativeOnly,p_offset:page*25,p_limit:25});
      if(error)throw error;
      return data as {total:number;items:QualityRow[]};
    },refetchInterval:30_000,
  });
  return <section>
    <button type="button" onClick={()=>setOpen(v=>!v)} aria-expanded={open}>예측 품질·음수 경고 {open ? "닫기":"보기"}</button>
    {open && <div>
      <p>최근 28일을 날짜별로 과거 자료만 사용해 재예측한 오차입니다. 실제 운영 중 미리 저장했던 예측의 성적표나 정확도 보증은 아닙니다. 평균 오차(MAE)는 기준단위, WAPE는 총 절대판매량 대비 오차입니다.</p>
      <label>품목 검색 <input value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}} /></label>
      <label><input type="checkbox" checked={negativeOnly} onChange={e=>{setNegativeOnly(e.target.checked);setPage(0);}} />음수 예측 품목만</label>
      {isFetching && <p>불러오는 중...</p>}
      {error && <p className="error-text">조회 실패: {(error as Error).message}</p>}
      {data && <>
        <p>총 {data.total}개 · {page+1}페이지</p>
        <div style={{overflowX:"auto"}}><table className="dense-table"><thead><tr><th>품목</th><th>학습·평가</th><th>오차</th><th>경고</th></tr></thead><tbody>
          {data.items.map(r=><tr key={r.product_id}>
            <td>{r.name} {r.spec}</td>
            <td>학습 종료 {r.training_end ?? "—"} · 관측 {r.n_observed ?? 0}일
              {r.is_stale && <div className="warning-badge">이전 자료 기준 · 최신 계산 대기</div>}
              <div>{r.evaluation.status === "evaluated"
                ? `${r.evaluation.window_start}~${r.evaluation.window_end} · 평가 ${r.evaluation.n}/${r.evaluation.requested_days}일${r.evaluation.partial ? " (부분 평가)":""}`
                : r.evaluation.status === "insufficient_data" ? "평가 자료 부족" : "평가 전"}</div>
            </td>
            <td>{r.evaluation.status === "evaluated" ? <>
              <div>MAE {number(r.evaluation.mae)} {r.base_unit} · WAPE {percent(r.evaluation.wape)}</div>
              <div>단순 평균: MAE {number(r.evaluation.baseline_mae)} · WAPE {percent(r.evaluation.baseline_wape)}</div>
              {r.evaluation.wape == null && <div>실판매 절대합이 0이라 WAPE를 계산하지 않습니다.</div>}
              {(r.evaluation.mae ?? 0) > (r.evaluation.baseline_mae ?? Infinity) && <div className="warning-badge">단순 평균보다 오차 큼 — 담당자 검토</div>}
            </> : "—"}</td>
            <td>{r.warning_codes.map(w=><div key={w}>{forecastWarningLabel(w)}</div>)}
              {!!r.negative_forecasts.length && <details><summary>음수 원값 {r.negative_forecasts.length}일 확인</summary>
                {r.negative_forecasts.map(n=><div key={n.date}>{n.date}: {n.raw} → 0 {r.base_unit}</div>)}
              </details>}
            </td>
          </tr>)}
        </tbody></table></div>
        {data.items.length===0 && <p>해당하는 품목이 없습니다.</p>}
        <button type="button" disabled={page===0} onClick={()=>setPage(p=>p-1)}>이전</button>
        <button type="button" disabled={(page+1)*25>=data.total} onClick={()=>setPage(p=>p+1)}>다음</button>
      </>}
    </div>}
  </section>;
}
