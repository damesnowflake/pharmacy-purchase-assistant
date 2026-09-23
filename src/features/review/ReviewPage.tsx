import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/features/auth/AuthContext";

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
}

// IR-04 사입 검토: 체크리스트, 수요·수량 근거, 도착일, 경고, 수량 수정·보류·제외·발주 완료.
// 발주 완료·보류·제외는 관리자만 가능하다 (FR-03). 직원은 근거를 조회만 한다.
export function ReviewPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({});
  const [orderFormOpenFor, setOrderFormOpenFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["recommendations", "review"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recommendations")
        .select(
          "id, product_id, status, decision, arrival_date, recommended_qty, version, basis_json, products(name, spec, base_unit)",
        )
        .eq("status", "review")
        .order("arrival_date", { ascending: true });
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

  const decide = useMutation({
    mutationFn: async (input: { rec: RecommendationRow; decision: "deferred" | "excluded" | "active" }) => {
      const qtyStr = qtyEdits[input.rec.id];
      const qty = qtyStr !== undefined && qtyStr !== "" ? Number(qtyStr) : null;
      const { error } = await supabase.rpc("decide_recommendation", {
        p_recommendation_id: input.rec.id,
        p_expected_version: input.rec.version,
        p_decision: input.decision,
        p_recommended_qty: qty,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setMessage("반영되었습니다.");
      invalidateAfterDecision(queryClient);
    },
    onError: (e: Error) => setMessage(`처리 실패: ${e.message}`),
  });

  const confirmOrder = useMutation({
    mutationFn: async (input: {
      rec: RecommendationRow;
      supplierId: string;
      unit: string;
      orderDate: string;
    }) => {
      const qtyStr = qtyEdits[input.rec.id];
      const qty = qtyStr !== undefined && qtyStr !== "" ? Number(qtyStr) : input.rec.recommended_qty;
      const { error } = await supabase.rpc("confirm_order", {
        p_request_id: crypto.randomUUID(),
        p_recommendation_id: input.rec.id,
        p_product_id: input.rec.product_id,
        p_supplier_id: input.supplierId,
        p_qty: qty,
        p_unit: input.unit,
        p_order_date: input.orderDate,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setMessage("발주 완료로 표시되었습니다. 입고 대기로 이동했습니다.");
      setOrderFormOpenFor(null);
      invalidateAfterDecision(queryClient);
    },
    onError: (e: Error) => setMessage(`발주 완료 처리 실패: ${e.message}`),
  });

  if (isLoading) return <div className="center-message">불러오는 중...</div>;
  if (error) return <div className="center-message error">조회 실패: {(error as Error).message}</div>;
  if (!data || data.length === 0) {
    return <div className="center-message">현재 사입 검토 대상이 없습니다.</div>;
  }

  const isAdmin = profile?.role === "admin";

  return (
    <div>
      {message && <p className="form-message">{message}</p>}
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
          {data.map((r) => {
            const warnings = Array.isArray(r.basis_json?.warning_codes)
              ? (r.basis_json.warning_codes as string[])
              : [];
            const referenceKind = r.basis_json?.reference_kind as string | undefined;
            const referenceValue = r.basis_json?.reference_value as number | undefined;
            const referenceInsufficient = Boolean(r.basis_json?.reference_data_insufficient);
            return (
              <tr key={r.id}>
                <td>{r.products?.name ?? r.product_id}</td>
                <td>{r.products?.spec}</td>
                <td>{referenceKind === "stock_count" ? "실사" : referenceKind === "last_receipt" ? "최근 입고" : "-"}</td>
                <td className="num">
                  {referenceValue ?? "-"}
                  {referenceInsufficient && <span className="warning-badge" style={{ marginLeft: 4 }}>자료 부족</span>}
                </td>
                <td className="num">{r.arrival_date}</td>
                <td className="num">
                  {isAdmin ? (
                    <input
                      type="number"
                      min="0"
                      step="any"
                      defaultValue={r.recommended_qty}
                      onChange={(e) => setQtyEdits((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      style={{ width: "80px" }}
                    />
                  ) : (
                    r.recommended_qty
                  )}
                </td>
                <td>{r.products?.base_unit}</td>
                <td>
                  {warnings.length > 0 ? (
                    <span className="warning-badge">{warnings.join(", ")}</span>
                  ) : (
                    "-"
                  )}
                </td>
                {isAdmin && (
                  <td>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      <button type="button" onClick={() => decide.mutate({ rec: r, decision: "deferred" })}>
                        보류
                      </button>
                      <button type="button" onClick={() => decide.mutate({ rec: r, decision: "excluded" })}>
                        제외
                      </button>
                      <button type="button" onClick={() => setOrderFormOpenFor(r.id)}>
                        발주 완료
                      </button>
                    </div>
                    {orderFormOpenFor === r.id && (
                      <OrderConfirmForm
                        rec={r}
                        suppliers={suppliers ?? []}
                        onCancel={() => setOrderFormOpenFor(null)}
                        onSubmit={(supplierId, unit, orderDate) =>
                          confirmOrder.mutate({ rec: r, supplierId, unit, orderDate })
                        }
                        submitting={confirmOrder.isPending}
                      />
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrderConfirmForm({
  rec,
  suppliers,
  onCancel,
  onSubmit,
  submitting,
}: {
  rec: RecommendationRow;
  suppliers: SupplierOption[];
  onCancel: () => void;
  onSubmit: (supplierId: string, unit: string, orderDate: string) => void;
  submitting: boolean;
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const unit = rec.products?.base_unit ?? "";

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
        <button
          type="button"
          disabled={!supplierId || submitting}
          onClick={() => onSubmit(supplierId, unit, orderDate)}
        >
          {submitting ? "처리 중..." : "확정"}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
