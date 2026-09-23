import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/features/auth/AuthContext";
import { getBusinessDate } from "@/lib/date";
import { useIdempotentRequest } from "@/lib/useIdempotentRequest";
import { ProductSearchBox } from "@/features/products/ProductSearchBox";
import type { ProductSearchResult } from "@/lib/useProductSearch";
import { useSalesPriority, salesPriorityLabel, type SalesPrioritySummary } from "@/lib/useSalesPriority";

interface RecommendationRow {
  id: string;
  product_id: string;
  status: "review" | "waiting" | "received";
  decision: "active" | "deferred" | "excluded";
  arrival_date: string;
  recommended_qty: number;
  version: number;
  basis_json: Record<string, unknown>;
  products: { name: string; spec: string; base_unit: string } | null;
}

interface SupplierOption {
  id: string;
  name: string;
}

function invalidateAfterDecision(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["recommendations"] });
  queryClient.invalidateQueries({ queryKey: ["product_state"] });
  queryClient.invalidateQueries({ queryKey: ["calc_status_summary"] });
}

// IR-04 사입 검토: 체크리스트, 수요·수량 근거, 도착일, 경고, 수량 수정·보류·제외·발주 완료.
// 발주 완료·보류·제외·수동 발주는 관리자만 가능하다 (FR-03). 직원은 근거를 조회만 한다.
export function ReviewPage() {
  const priority = useSalesPriority();
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"active" | "deferred_excluded">("active");
  const [message, setMessage] = useState<string | null>(null);
  const [manualOrderOpen, setManualOrderOpen] = useState(false);

  const { data: calcSummary } = useQuery({
    queryKey: ["calc_status_summary"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("calc_status_summary");
      if (error) throw error;
      return data as { calculating: number; blocked: number; review: number;
        missing_reference?: number; missing_moq?: number; missing_order_step?: number; missing_historical_sales?: number };
    },
    refetchInterval: 30_000,
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["recommendations", "review", filter],
    queryFn: async () => {
      let q = supabase
        .from("recommendations")
        .select(
          "id, product_id, status, decision, arrival_date, recommended_qty, version, basis_json, products(name, spec, base_unit)",
        )
        .eq("status", "review")
        .order("arrival_date", { ascending: true });
      q = filter === "active" ? q.eq("decision", "active") : q.in("decision", ["deferred", "excluded"]);
      const { data, error } = await q;
      if (error) throw error;
      return data as unknown as RecommendationRow[];
    },
  });

  const { data: suppliers } = useQuery({
    queryKey: ["suppliers", "active"],
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("id, name").eq("active", true);
      if (error) throw error;
      return data as SupplierOption[];
    },
    enabled: profile?.role === "admin",
  });

  const isAdmin = profile?.role === "admin";

  return (
    <div>
      {calcSummary && (
        <p className="form-message">
          계산 중 {calcSummary.calculating}개 · 조건 확인 필요 {calcSummary.blocked}개 · 사입 검토{" "}
          {calcSummary.review}개
          {calcSummary.missing_reference !== undefined && (
            <span> · 입고/실사 필요 {calcSummary.missing_reference}개 · MOQ 필요 {calcSummary.missing_moq}개 · 발주단위 필요 {calcSummary.missing_order_step}개 (중복 집계)</span>
          )}
          {!!calcSummary.missing_historical_sales && <span className="error-text"> · 과거 판매자료 복원 불가 {calcSummary.missing_historical_sales}개 — 입고 화면에서 현재 수량을 실사로 등록하세요.</span>}
        </p>
      )}
      <div style={{ display: "flex", gap: "4px", marginBottom: "8px" }}>
        <button type="button" disabled={filter === "active"} onClick={() => setFilter("active")}>
          검토 대상
        </button>
        <button type="button" disabled={filter === "deferred_excluded"} onClick={() => setFilter("deferred_excluded")}>
          보류·제외 보기
        </button>
        {isAdmin && (
          <button type="button" onClick={() => setManualOrderOpen((v) => !v)}>
            {manualOrderOpen ? "수동 발주 기록 닫기" : "수동 발주 기록"}
          </button>
        )}
      </div>
      {message && <p className="form-message">{message}</p>}
      {priority.error && <p className="error-text">판매 순위를 불러오지 못했습니다. 실사 여부를 직접 확인하세요.</p>}
      {priority.data && (
        <details>
          <summary>판매 상위 50개 · {priority.data.window_start}~{priority.data.window_end} · 자료 확보 {priority.data.observed_days}/30일</summary>
          <p>순위는 실사 우선순위 안내에만 사용하며 추천수량과 기존 재고 기준점을 변경하지 않습니다.</p>
          <ol>{priority.data.products.map(p => <li key={p.product_id}>{p.name} {p.spec} — {p.net_qty} 기준단위{p.partial_window ? " (관측기간 부족)" : ""}</li>)}</ol>
          {!priority.data.products.length && <p>해당 기간에 양의 순판매량이 있는 품목이 없습니다.</p>}
        </details>
      )}

      {manualOrderOpen && isAdmin && (
        <ManualOrderPanel
          suppliers={suppliers ?? []}
          userId={profile?.user_id ?? ""}
          onDone={(msg) => {
            setMessage(msg);
            invalidateAfterDecision(queryClient);
          }}
        />
      )}

      {isLoading && <div className="center-message">불러오는 중...</div>}
      {error && <div className="center-message error">조회 실패: {(error as Error).message}</div>}
      {!isLoading && !error && (!data || data.length === 0) && (
        <div className="center-message">
          {filter === "active" ? "현재 사입 검토 대상이 없습니다." : "보류·제외한 항목이 없습니다."}
        </div>
      )}
      {!isLoading && data && data.length > 0 && (
        <table className="dense-table">
          <thead>
            <tr>
              <th>품목</th>
              <th>규격</th>
              <th>기준 종류</th>
              <th className="num">참고 잔량</th>
              <th className="num">도착일</th>
              <th className="num">추천 수량</th>
              <th>단위</th>
              <th>경고</th>
              {isAdmin && <th>조치</th>}
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <RecommendationTableRow
                key={r.id}
                rec={r}
                priority={priority.data}
                isAdmin={isAdmin}
                suppliers={suppliers ?? []}
                userId={profile?.user_id ?? ""}
                filter={filter}
                onMessage={setMessage}
                onChanged={() => invalidateAfterDecision(queryClient)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RecommendationTableRow({
  rec,
  priority,
  isAdmin,
  suppliers,
  userId,
  filter,
  onMessage,
  onChanged,
}: {
  rec: RecommendationRow;
  priority?: SalesPrioritySummary;
  isAdmin: boolean;
  suppliers: SupplierOption[];
  userId: string;
  filter: "active" | "deferred_excluded";
  onMessage: (m: string) => void;
  onChanged: () => void;
}) {
  const [qty, setQty] = useState<{ text: string; dirty: boolean }>({
    text: String(rec.recommended_qty),
    dirty: false,
  });
  const [orderFormOpen, setOrderFormOpen] = useState(false);

  // 미편집 수량은 최신 추천값을 반영하고, 편집 중인 값은 그대로 둔다.
  useEffect(() => {
    if (!qty.dirty) setQty({ text: String(rec.recommended_qty), dirty: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.recommended_qty, rec.version]);

  const decide = useMutation({
    mutationFn: async (decision: "deferred" | "excluded" | "active") => {
      const qtyNum = decision === "active" ? null : Number(qty.text);
      const { error } = await supabase.rpc("decide_recommendation", {
        p_recommendation_id: rec.id,
        p_expected_version: rec.version,
        p_decision: decision,
        p_recommended_qty: qty.dirty && qtyNum && qtyNum > 0 ? qtyNum : null,
      });
      if (error) throw error;
    },
    onSuccess: (_data, decision) => {
      onMessage(
        decision === "active"
          ? "다시 검토 대상으로 되돌렸습니다."
          : decision === "deferred"
            ? "보류로 표시했습니다."
            : "제외로 표시했습니다.",
      );
      onChanged();
    },
    onError: (e: Error) => onMessage(`처리 실패: ${e.message}`),
  });

  const { getRequestId, clearPending } = useIdempotentRequest(`confirm_order:${userId}:${rec.id}`);

  const confirmOrder = useMutation({
    mutationFn: async (input: { supplierId: string; unit: string; orderDate: string }) => {
      const qtyNum = Number(qty.text);
      if (!qtyNum || qtyNum <= 0) throw new Error("수량을 입력하세요.");
      const requestId = getRequestId(
        JSON.stringify({ rec: rec.id, v: rec.version, supplier: input.supplierId, qty: qtyNum, unit: input.unit, date: input.orderDate }),
      );
      const { error } = await supabase.rpc("confirm_order", {
        p_request_id: requestId,
        p_recommendation_id: rec.id,
        p_expected_recommendation_version: rec.version,
        p_product_id: rec.product_id,
        p_supplier_id: input.supplierId,
        p_qty: qtyNum,
        p_unit: input.unit,
        p_order_date: input.orderDate,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      clearPending();
      onMessage("발주 완료로 표시되었습니다. 입고 대기로 이동했습니다.");
      setOrderFormOpen(false);
      onChanged();
    },
    onError: (e: Error) => {
      // 버전 충돌·입력 오류처럼 확정된 실패는 다음 시도가 새 요청이 되도록 정리한다. 그 외
      // (통신 오류 등 결과를 알 수 없는 경우)는 request_id를 유지해 재시도가 중복 저장을
      // 만들지 않게 한다.
      if (e.message.includes("VERSION_CONFLICT") || e.message.includes("INVALID") || e.message.includes("RECOMMENDATION")) {
        clearPending();
      }
      if (e.message.includes("VERSION_CONFLICT")) {
        setOrderFormOpen(false);
        onChanged();
        onMessage("추천이 변경되었습니다. 최신 수량과 근거를 확인한 뒤 다시 발주 완료 처리해 주세요.");
      } else {
        onMessage(`발주 완료 처리 실패: ${e.message}`);
      }
    },
  });

  const warnings = Array.isArray(rec.basis_json?.warning_codes) ? (rec.basis_json.warning_codes as string[]) : [];
  const referenceKind = rec.basis_json?.reference_kind as string | undefined;
  const referenceValue = rec.basis_json?.reference_value as number | undefined;
  const referenceInsufficient = Boolean(rec.basis_json?.reference_data_insufficient);

  return (
    <tr>
      <td>{rec.products?.name ?? rec.product_id}<div className="form-message">{salesPriorityLabel(priority, rec.product_id)}</div></td>
      <td>{rec.products?.spec}</td>
      <td>{referenceKind === "stock_count" ? "실사" : referenceKind === "last_receipt" ? "최근 입고" : "-"}</td>
      <td className="num">
        {referenceValue ?? "-"}
        {referenceInsufficient && (
          <span className="warning-badge" style={{ marginLeft: 4 }}>
            자료 부족
          </span>
        )}
      </td>
      <td className="num">{rec.arrival_date}</td>
      <td className="num">
        {isAdmin && filter === "active" ? (
          <input
            type="number"
            min="0"
            step="any"
            value={qty.text}
            onChange={(e) => setQty({ text: e.target.value, dirty: true })}
            style={{ width: "80px" }}
          />
        ) : (
          rec.recommended_qty
        )}
      </td>
      <td>{rec.products?.base_unit}</td>
      <td>{warnings.length > 0 ? <span className="warning-badge">{warnings.join(", ")}</span> : "-"}</td>
      {isAdmin && (
        <td>
          {filter === "deferred_excluded" ? (
            <button type="button" onClick={() => decide.mutate("active")} disabled={decide.isPending}>
              다시 검토
            </button>
          ) : (
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              <button type="button" onClick={() => decide.mutate("deferred")} disabled={decide.isPending}>
                보류
              </button>
              <button type="button" onClick={() => decide.mutate("excluded")} disabled={decide.isPending}>
                제외
              </button>
              <button type="button" onClick={() => setOrderFormOpen(true)}>
                발주 완료
              </button>
            </div>
          )}
          {orderFormOpen && (
            <OrderConfirmForm
              unit={rec.products?.base_unit ?? ""}
              suppliers={suppliers}
              onCancel={() => setOrderFormOpen(false)}
              onSubmit={(supplierId, unit, orderDate) => confirmOrder.mutate({ supplierId, unit, orderDate })}
              submitting={confirmOrder.isPending}
            />
          )}
        </td>
      )}
    </tr>
  );
}

function OrderConfirmForm({
  suppliers,
  unit,
  onCancel,
  onSubmit,
  submitting,
}: {
  suppliers: SupplierOption[];
  unit: string;
  onCancel: () => void;
  onSubmit: (supplierId: string, unit: string, orderDate: string) => void;
  submitting: boolean;
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [orderDate, setOrderDate] = useState(getBusinessDate());

  return (
    <div style={{ marginTop: "6px", padding: "8px", border: "1px solid var(--border)", borderRadius: "6px" }}>
      <label>
        거래처
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        발주일
        <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
      </label>
      <div style={{ display: "flex", gap: "4px" }}>
        <button type="button" disabled={!supplierId || submitting} onClick={() => onSubmit(supplierId, unit, orderDate)}>
          {submitting ? "처리 중..." : "확정"}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}

// 시나리오 12: 추천에 없는 상품 주문(수동 발주). 상품 검색으로 고른 뒤 거래처·수량·단위·발주일을
// 입력한다. MOQ·모델·추천이 없어도 허용한다 — 실제 발주 사실을 기록하는 것이 목적이다.
function ManualOrderPanel({
  suppliers,
  userId,
  onDone,
}: {
  suppliers: SupplierOption[];
  userId: string;
  onDone: (message: string) => void;
}) {
  const [product, setProduct] = useState<ProductSearchResult | null>(null);
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [unit, setUnit] = useState("");
  const [qty, setQty] = useState("");
  const [orderDate, setOrderDate] = useState(getBusinessDate());
  const [error, setError] = useState<string | null>(null);

  const { getRequestId, clearPending } = useIdempotentRequest(`manual_order:${userId}`);

  const submit = useMutation({
    mutationFn: async () => {
      if (!product) throw new Error("상품을 먼저 검색해 선택하세요.");
      const qtyNum = Number(qty);
      if (!qtyNum || qtyNum <= 0) throw new Error("수량을 입력하세요.");
      if (!supplierId) throw new Error("거래처를 선택하세요.");
      const chosenUnit = unit || product.base_unit;
      const requestId = getRequestId(
        JSON.stringify({ product: product.product_id, supplier: supplierId, qty: qtyNum, unit: chosenUnit, date: orderDate }),
      );
      const { error } = await supabase.rpc("confirm_order", {
        p_request_id: requestId,
        p_recommendation_id: null,
        p_expected_recommendation_version: null,
        p_product_id: product.product_id,
        p_supplier_id: supplierId,
        p_qty: qtyNum,
        p_unit: chosenUnit,
        p_order_date: orderDate,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      clearPending();
      onDone(`수동 발주를 기록했습니다: ${product?.name} ${qty}${unit || product?.base_unit}`);
      setProduct(null);
      setQty("");
    },
    onError: (e: Error) => {
      clearPending();
      setError(`발주 기록 실패: ${e.message}`);
    },
  });

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "8px", marginBottom: "12px" }}>
      <h4>수동 발주 기록</h4>
      {error && <p className="form-message error-text">{error}</p>}
      {!product ? (
        <ProductSearchBox onSelect={(p) => setProduct(p)} />
      ) : (
        <p>
          선택된 상품: {product.name} {product.spec} ({product.base_unit})
          <button type="button" onClick={() => setProduct(null)}>
            변경
          </button>
        </p>
      )}
      <label>
        거래처
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">선택</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        수량
        <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label>
        단위 (비우면 기준단위)
        <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={product?.base_unit ?? ""} />
      </label>
      <label>
        발주일
        <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
      </label>
      <button type="button" disabled={!product || submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? "저장 중..." : "발주 기록"}
      </button>
    </div>
  );
}
