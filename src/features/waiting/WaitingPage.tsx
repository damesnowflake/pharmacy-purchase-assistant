import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/features/auth/AuthContext";
import { getBusinessDate, toKstDatetimeLocal, revisedEventTimestamp } from "@/lib/date";
import { useIdempotentRequest } from "@/lib/useIdempotentRequest";
import type { ProductSearchResult } from "@/lib/useProductSearch";

interface ProductStateRow {
  product_id: string;
  pending_qty: number;
  last_settled_at: string | null;
  products: { name: string; spec: string; base_unit: string } | null;
}

interface SupplierOption {
  id: string;
  name: string;
}

interface HistoryRow {
  event_id: string;
  product_id: string;
  product_name: string;
  product_spec: string;
  base_unit: string;
  kind: "receipt" | "order" | "count" | "order_cancel" | "stock_adjustment";
  occurred_at: string;
  input_qty: number;
  input_unit: string;
  qty_base: number;
  excess_qty_base: number;
  supplier_id: string | null;
  supplier_name: string | null;
  recommendation_id: string | null;
  closed_reason: "received" | "cancelled" | "not_needed" | null;
  active: boolean;
  revises_event_id: string | null;
  created_by: string;
  created_by_name: string | null;
  version: number;
  total_count: number;
}

interface ExcessRow {
  event_id: string;
  product_id: string;
  product_name: string;
  product_spec: string;
  base_unit: string;
  occurred_at: string;
  input_qty: number;
  excess_qty_base: number;
}

const KIND_LABEL: Record<string, string> = {
  receipt: "입고",
  order: "발주",
  count: "실사",
  order_cancel: "발주 취소",
  stock_adjustment: "재고 조정",
};

// IR-05 입고 대기·이력: 품목별 발주량·입고량·대기량, 완료 이력과 초과/미연결 입고 표시.
export function WaitingPage() {
  const [tab, setTab] = useState<"pending" | "history" | "excess">("pending");

  return (
    <div>
      <div style={{ display: "flex", gap: "4px", marginBottom: "12px" }}>
        <button type="button" onClick={() => setTab("pending")} disabled={tab === "pending"}>
          입고 대기
        </button>
        <button type="button" onClick={() => setTab("history")} disabled={tab === "history"}>
          이력
        </button>
        <button type="button" onClick={() => setTab("excess")} disabled={tab === "excess"}>
          초과 입고
        </button>
      </div>
      {tab === "pending" && <PendingPanel />}
      {tab === "history" && <HistoryPanel />}
      {tab === "excess" && <ExcessPanel />}
    </div>
  );
}

function PendingPanel() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = profile?.role === "admin";
  const [message, setMessage] = useState<string | null>(null);
  const [cancelOpenFor, setCancelOpenFor] = useState<string | null>(null);
  const [orderOpenFor, setOrderOpenFor] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["product_state", "pending"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_state")
        .select("product_id, pending_qty, last_settled_at, products(name, spec, base_unit)")
        .gt("pending_qty", 0)
        .order("last_settled_at", { ascending: false });
      if (error) throw error;
      return data as unknown as ProductStateRow[];
    },
  });

  const { data: suppliers } = useQuery({
    queryKey: ["suppliers", "active"],
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("id, name").eq("active", true);
      if (error) throw error;
      return data as SupplierOption[];
    },
    enabled: isAdmin,
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["product_state"] });
    queryClient.invalidateQueries({ queryKey: ["recommendations"] });
  }

  if (isLoading) return <div className="center-message">불러오는 중...</div>;
  if (error) return <div className="center-message error">조회 실패: {(error as Error).message}</div>;
  if (!data || data.length === 0) {
    return <div className="center-message">입고 대기 중인 품목이 없습니다.</div>;
  }

  return (
    <div>
      {message && <p className="form-message">{message}</p>}
      <table className="dense-table">
        <thead>
          <tr>
            <th>품목</th>
            <th>규격</th>
            <th className="num">대기 수량</th>
            <th>단위</th>
            <th>마지막 갱신</th>
            {isAdmin && <th>조치</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <Fragment key={r.product_id}>
              <tr>
                <td>{r.products?.name ?? r.product_id}</td>
                <td>{r.products?.spec}</td>
                <td className="num">{r.pending_qty}</td>
                <td>{r.products?.base_unit}</td>
                <td>{r.last_settled_at ?? "-"}</td>
                {isAdmin && (
                  <td>
                    <div style={{ display: "flex", gap: "4px" }}>
                      <button type="button" onClick={() => setOrderOpenFor(r.product_id)}>
                        추가 발주 기록
                      </button>
                      <button type="button" onClick={() => setCancelOpenFor(r.product_id)}>
                        발주 취소
                      </button>
                    </div>
                  </td>
                )}
              </tr>
              {isAdmin && cancelOpenFor === r.product_id && (
                <tr key={`${r.product_id}-cancel`}>
                  <td colSpan={6}>
                    <CancelOrderInline
                      productId={r.product_id}
                      maxQty={r.pending_qty}
                      onCancel={() => setCancelOpenFor(null)}
                      onDone={(msg) => {
                        setMessage(msg);
                        setCancelOpenFor(null);
                        invalidate();
                      }}
                    />
                  </td>
                </tr>
              )}
              {isAdmin && orderOpenFor === r.product_id && (
                <tr key={`${r.product_id}-order`}>
                  <td colSpan={6}>
                    <AdditionalOrderInline
                      product={{
                        product_id: r.product_id,
                        name: r.products?.name ?? "",
                        spec: r.products?.spec ?? "",
                        base_unit: r.products?.base_unit ?? "",
                        default_moq: null,
                        default_order_step: null,
                      }}
                      suppliers={suppliers ?? []}
                      onCancel={() => setOrderOpenFor(null)}
                      onDone={(msg) => {
                        setMessage(msg);
                        setOrderOpenFor(null);
                        invalidate();
                      }}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CancelOrderInline({
  productId,
  maxQty,
  onCancel,
  onDone,
}: {
  productId: string;
  maxQty: number;
  onCancel: () => void;
  onDone: (msg: string) => void;
}) {
  const { profile } = useAuth();
  const [qty, setQty] = useState(String(maxQty));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { getRequestId, clearPending } = useIdempotentRequest(`cancel_order:${profile?.user_id ?? ""}:${productId}`);

  const submit = useMutation({
    mutationFn: async () => {
      const qtyNum = Number(qty);
      if (!qtyNum || qtyNum <= 0) throw new Error("CLIENT_VALIDATION: 취소 수량을 입력하세요.");
      const requestId = getRequestId(JSON.stringify({ productId, qty: qtyNum, reason }));
      const { error } = await supabase.rpc("cancel_order", {
        p_request_id: requestId,
        p_product_id: productId,
        p_qty: qtyNum,
        p_reason: reason || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      clearPending();
      onDone(`발주 ${qty}건을 취소로 반영했습니다.`);
    },
    onError: (e: Error) => {
      if (e.message.includes("CLIENT_VALIDATION") || e.message.includes("INVALID")) clearPending();
      setError(`취소 실패: ${e.message}`);
    },
  });

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "8px" }}>
      {error && <p className="form-message error-text">{error}</p>}
      <label>
        취소 수량 (남은 대기 {maxQty})
        <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label>
        사유 (선택)
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="button" disabled={submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? "처리 중..." : "취소 확정"}
      </button>
      <button type="button" onClick={onCancel}>
        닫기
      </button>
    </div>
  );
}

// 시나리오 12: 이미 대기 중인 품목에 추가 발주를 기록한다(추천 없음). 상품은 이미 정해져 있다.
function AdditionalOrderInline({
  product,
  suppliers,
  onCancel,
  onDone,
}: {
  product: ProductSearchResult;
  suppliers: SupplierOption[];
  onCancel: () => void;
  onDone: (msg: string) => void;
}) {
  const { profile } = useAuth();
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [qty, setQty] = useState("");
  const [orderDate, setOrderDate] = useState(getBusinessDate());
  const [error, setError] = useState<string | null>(null);
  const { getRequestId, clearPending } = useIdempotentRequest(
    `additional_order:${profile?.user_id ?? ""}:${product.product_id}`,
  );

  const submit = useMutation({
    mutationFn: async () => {
      const qtyNum = Number(qty);
      if (!qtyNum || qtyNum <= 0) throw new Error("CLIENT_VALIDATION: 수량을 입력하세요.");
      if (!supplierId) throw new Error("CLIENT_VALIDATION: 거래처를 선택하세요.");
      const requestId = getRequestId(
        JSON.stringify({ product: product.product_id, supplier: supplierId, qty: qtyNum, date: orderDate }),
      );
      const { error } = await supabase.rpc("confirm_order", {
        p_request_id: requestId,
        p_recommendation_id: null,
        p_expected_recommendation_version: null,
        p_product_id: product.product_id,
        p_supplier_id: supplierId,
        p_qty: qtyNum,
        p_unit: product.base_unit,
        p_order_date: orderDate,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      clearPending();
      onDone(`${product.name}에 ${qty}${product.base_unit} 추가 발주를 기록했습니다.`);
    },
    onError: (e: Error) => {
      if (e.message.includes("CLIENT_VALIDATION") || e.message.includes("INVALID")) clearPending();
      setError(`발주 기록 실패: ${e.message}`);
    },
  });

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "8px" }}>
      {error && <p className="form-message error-text">{error}</p>}
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
        추가 수량 ({product.base_unit})
        <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label>
        발주일
        <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
      </label>
      <button type="button" disabled={submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? "처리 중..." : "추가 발주 기록"}
      </button>
      <button type="button" onClick={onCancel}>
        닫기
      </button>
    </div>
  );
}

const PAGE_SIZE = 30;

function HistoryPanel() {
  const { profile } = useAuth();
  const isAdmin = profile?.role === "admin";
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kind, setKind] = useState<string>("");
  const [page, setPage] = useState(0);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["movement_history", search, from, to, kind, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_movement_history", {
        p_search: search,
        p_from: from || null,
        p_to: to || null,
        p_kind: kind || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data as HistoryRow[];
    },
  });

  const totalCount = data?.[0]?.total_count ?? 0;

  function canEdit(row: HistoryRow) {
    if (!row.active) return false;
    if (row.kind === "order" || row.kind === "order_cancel") return isAdmin;
    return true; // receipt, count: 직원·관리자 모두
  }

  return (
    <div>
      {message && <p className="form-message">{message}</p>}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
        <input placeholder="품목명·규격 검색" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
        <label>
          시작일
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
        </label>
        <label>
          종료일
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
        </label>
        <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(0); }}>
          <option value="">전체 종류</option>
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <div className="center-message">불러오는 중...</div>}
      {error && <div className="center-message error">조회 실패: {(error as Error).message}</div>}
      {!isLoading && (!data || data.length === 0) && <div className="center-message">이력이 없습니다.</div>}

      {!isLoading && data && data.length > 0 && (
        <>
          <table className="dense-table">
            <thead>
              <tr>
                <th>발생일시</th>
                <th>품목</th>
                <th>규격</th>
                <th>구분</th>
                <th className="num">수량</th>
                <th>단위</th>
                <th>거래처</th>
                <th>등록자</th>
                <th>비고</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <Fragment key={r.event_id}>
                  <tr>
                    <td>{r.occurred_at}</td>
                    <td>{r.product_name}</td>
                    <td>{r.product_spec}</td>
                    <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="num">{r.input_qty}</td>
                    <td>{r.input_unit}</td>
                    <td>{r.supplier_name ?? "-"}</td>
                    <td>{r.created_by_name ?? "-"}</td>
                    <td>
                      {!r.active && "정정됨"}
                      {r.closed_reason === "cancelled" && "일부 취소로 종결"}
                      {r.closed_reason === "received" && "수령 완료"}
                      {r.excess_qty_base > 0 && ` · 초과 ${r.excess_qty_base}`}
                    </td>
                    <td>
                      {canEdit(r) && (
                        <button type="button" onClick={() => setEditEventId(r.event_id)}>
                          수정
                        </button>
                      )}
                    </td>
                  </tr>
                  {editEventId === r.event_id && (
                    <tr key={`${r.event_id}-edit`}>
                      <td colSpan={10}>
                        <ReviseEventForm
                          row={r}
                          onCancel={() => setEditEventId(null)}
                          onDone={(msg) => {
                            setMessage(msg);
                            setEditEventId(null);
                            queryClient.invalidateQueries({ queryKey: ["movement_history"] });
                            queryClient.invalidateQueries({ queryKey: ["product_state"] });
                            queryClient.invalidateQueries({ queryKey: ["recommendations"] });
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              이전
            </button>
            <span>
              {page * PAGE_SIZE + 1}~{Math.min((page + 1) * PAGE_SIZE, totalCount)} / {totalCount}
            </span>
            <button type="button" disabled={(page + 1) * PAGE_SIZE >= totalCount} onClick={() => setPage((p) => p + 1)}>
              다음
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ReviseEventForm({
  row,
  onCancel,
  onDone,
}: {
  row: HistoryRow;
  onCancel: () => void;
  onDone: (msg: string) => void;
}) {
  const { profile } = useAuth();
  const [qty, setQty] = useState(String(row.input_qty));
  const [unit, setUnit] = useState(row.input_unit);
  const [occurredAt, setOccurredAt] = useState(toKstDatetimeLocal(row.occurred_at));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { getRequestId, clearPending } = useIdempotentRequest(`revise:${profile?.user_id ?? ""}:${row.event_id}`);

  const submit = useMutation({
    mutationFn: async (input: { void: boolean }) => {
      const timestamp = input.void ? null : revisedEventTimestamp(row.occurred_at, occurredAt);
      const requestId = getRequestId(JSON.stringify({ version: row.version, void: input.void, qty, unit, timestamp, reason }));
      const { error } = await supabase.rpc("revise_quantity_event", {
        p_request_id: requestId,
        p_event_id: row.event_id,
        p_expected_version: row.version,
        p_void: input.void,
        p_new_qty: input.void ? null : Number(qty),
        p_new_unit: input.void ? null : unit,
        p_new_occurred_at: timestamp,
        p_reason: reason || null,
      });
      if (error) throw error;
    },
    onSuccess: (_d, input) => {
      clearPending();
      onDone(input.void ? "해당 기록을 무효화했습니다." : "정정을 저장했습니다.");
    },
    onError: (e: Error) => {
      if (e.message.includes("VERSION_CONFLICT") || e.message.includes("INVALID") || e.message.includes("FORBIDDEN")) {
        clearPending();
      }
      setError(`처리 실패: ${e.message}`);
    },
  });

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "8px" }}>
      {error && <p className="form-message error-text">{error}</p>}
      <label>
        수량
        <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label>
        단위
        <input value={unit} onChange={(e) => setUnit(e.target.value)} />
      </label>
      <label>
        발생일시 (한국시간)
        <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </label>
      <label>
        사유 (선택)
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div style={{ display: "flex", gap: "6px" }}>
        <button type="button" disabled={submit.isPending} onClick={() => submit.mutate({ void: false })}>
          {submit.isPending ? "처리 중..." : "정정 저장"}
        </button>
        <button type="button" disabled={submit.isPending} onClick={() => submit.mutate({ void: true })}>
          오입력 무효화
        </button>
        <button type="button" onClick={onCancel}>
          닫기
        </button>
      </div>
    </div>
  );
}

function ExcessPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["excess_receipts"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_excess_receipts");
      if (error) throw error;
      return data as ExcessRow[];
    },
  });

  if (isLoading) return <div className="center-message">불러오는 중...</div>;
  if (error) return <div className="center-message error">조회 실패: {(error as Error).message}</div>;
  if (!data || data.length === 0) {
    return <div className="center-message">초과 입고가 없습니다.</div>;
  }

  return (
    <table className="dense-table">
      <thead>
        <tr>
          <th>품목</th>
          <th>규격</th>
          <th>입고일</th>
          <th className="num">실제 입고량</th>
          <th className="num">초과 수량</th>
          <th>단위</th>
        </tr>
      </thead>
      <tbody>
        {data.map((r) => (
          <tr key={r.event_id}>
            <td>{r.product_name}</td>
            <td>{r.product_spec}</td>
            <td>{r.occurred_at}</td>
            <td className="num">{r.input_qty}</td>
            <td className="num">{r.excess_qty_base}</td>
            <td>{r.base_unit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
