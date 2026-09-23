import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/features/auth/AuthContext";
import { useIdempotentRequest } from "@/lib/useIdempotentRequest";
import { OcrCapture } from "./OcrCapture";
import { ProductSearchBox } from "@/features/products/ProductSearchBox";
import type { ProductSearchResult } from "@/lib/useProductSearch";
import type { ProductUnit } from "@/lib/useProductUnits";

interface ReceiptLine {
  lineId: string;
  productId: string;
  label: string;
  quantity: string;
  unit: string;
  units: ProductUnit[];
}

function kstNowInputValue(): string {
  // datetime-local 입력의 기본값은 한국시간 "지금"이어야 한다(시나리오 4). 브라우저 로컬
  // 시간대가 달라도 항상 같은 값이 나오도록 Intl로 한국시간 시:분까지 직접 구성한다.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** datetime-local의 "YYYY-MM-DDTHH:mm" 값을 한국시간으로 해석해 타임스탬프 문자열로 만든다.
 * 브라우저가 어떤 시간대에서 실행되든(직원 iPhone·다른 지역 PC 등) 항상 한국시간으로 저장된다. */
function toKstTimestamp(datetimeLocalValue: string): string {
  return `${datetimeLocalValue}:00+09:00`;
}

// IR-03 입고 등록. FR-11~14. 수동 입력과 기기 내 OCR(Tesseract.js) 촬영 입력 모두 지원한다.
// OCR 인식 정확도는 실제 입고장 사진·iPhone 실기기로 검증되지 않았다 (D-04,
// docs/미확인_항목.md) — 그래서 OCR 결과는 항상 이 화면의 확정 목록을 거쳐야 저장된다.
//
// 상품 검색에서 결과가 없으면 같은 화면에서 새 상품을 등록할 수 있다(ProductSearchBox).
// 등록이 끝나면 그 상품이 자동으로 입고 행에 추가되고, 이미 입력해 둔 다른 행·수량은 그대로
// 유지된다(별도 상태를 건드리지 않고 lines 배열에 더하기만 함).
export function ReceiptsPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [occurredAt, setOccurredAt] = useState(kstNowInputValue());
  const [message, setMessage] = useState<string | null>(null);
  const [showOcr, setShowOcr] = useState(false);

  async function fetchUnits(productId: string): Promise<ProductUnit[]> {
    const { data, error } = await supabase
      .from("product_units")
      .select("unit_code, factor_to_base")
      .eq("product_id", productId)
      .order("factor_to_base", { ascending: true });
    if (error) return [];
    return (data ?? []) as ProductUnit[];
  }

  function upsertLine(next: { productId: string; label: string; quantity: string; unit: string; units: ProductUnit[] }) {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === next.productId && l.unit === next.unit);
      if (!existing) return [...prev, { ...next, lineId: crypto.randomUUID() }];
      const merged = (Number(existing.quantity) || 0) + (Number(next.quantity) || 0);
      return prev.map((l) => (l === existing ? { ...l, quantity: String(merged) } : l));
    });
  }

  async function addProduct(p: ProductSearchResult) {
    const units = await fetchUnits(p.product_id);
    upsertLine({
      productId: p.product_id,
      label: `${p.name} ${p.spec}`.trim(),
      quantity: "",
      unit: p.base_unit,
      units: units.length > 0 ? units : [{ unit_code: p.base_unit, factor_to_base: 1 }],
    });
  }

  async function addFromOcr(line: { productId: string; label: string; quantity: string; unit: string }) {
    const units = await fetchUnits(line.productId);
    upsertLine({ ...line, units: units.length > 0 ? units : [{ unit_code: line.unit, factor_to_base: 1 }] });
  }

  function updateLine(lineId: string, patch: Partial<ReceiptLine>) {
    setLines((prev) => prev.map((l) => (l.lineId === lineId ? { ...l, ...patch } : l)));
  }

  function removeLine(lineId: string) {
    setLines((prev) => prev.filter((l) => l.lineId !== lineId));
  }

  const { getRequestId, clearPending } = useIdempotentRequest(`receipt_draft:${profile?.user_id ?? ""}`);

  const submit = useMutation({
    mutationFn: async () => {
      const items = lines.map((l) => ({
        product_id: l.productId,
        quantity: Number(l.quantity),
        unit: l.unit,
      }));
      if (items.length === 0 || items.some((i) => !i.quantity || i.quantity <= 0)) {
        throw new Error("CLIENT_VALIDATION: 모든 품목의 실제 입고 수량을 입력하세요.");
      }
      // 시나리오 2: 첫 저장 시도의 입력을 그대로 고정해, 응답 유실 후 재시도·새로고침 후
      // 재시도가 새 입고를 만들지 않고 같은 request_id로 같은 내용을 다시 보내게 한다.
      const occurredAtKst = toKstTimestamp(occurredAt);
      const requestId = getRequestId(JSON.stringify({ occurredAt: occurredAtKst, items }));
      const { data, error } = await supabase.rpc("register_receipt", {
        p_request_id: requestId,
        p_occurred_at: occurredAtKst,
        p_items: items,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      clearPending();
      setMessage("입고가 저장되었습니다.");
      setLines([]);
      setOccurredAt(kstNowInputValue());
      queryClient.invalidateQueries({ queryKey: ["product_state"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
    onError: (e: Error) => {
      // 확정된 입력 오류(클라이언트 검증, 또는 서버의 수량·단위 검사)는 아무것도 저장되지
      // 않았다고 알려진 경우이므로, 값을 고친 뒤 새 요청으로 다시 시도할 수 있게 정리한다.
      // 그 외(통신 오류 등 저장 여부를 알 수 없는 경우)는 request_id를 유지해 "재시도"
      // 버튼이 같은 내용을 같은 ID로 다시 보내게 한다.
      const confirmedNoSave =
        e.message.includes("CLIENT_VALIDATION") ||
        e.message.includes("INVALID_QUANTITY") ||
        e.message.includes("UNKNOWN_UNIT") ||
        e.message.includes("FRACTION_NOT_ALLOWED") ||
        e.message.includes("EMPTY_ITEMS");
      if (confirmedNoSave) clearPending();
      setMessage(confirmedNoSave ? `저장 실패: ${e.message}` : `저장 결과를 확인할 수 없습니다. 같은 내용으로 재시도하세요: ${e.message}`);
    },
  });

  return (
    <div className="receipts-page">
      <section className="receipts-manual">
        <h2>입고 등록</h2>

        <label>
          입고 일시 (한국시간)
          <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        </label>

        <button type="button" onClick={() => setShowOcr((v) => !v)}>
          {showOcr ? "촬영 입력 닫기" : "촬영으로 입력"}
        </button>
        {showOcr && <OcrCapture onResolved={addFromOcr} />}

        <h3>수동 입력</h3>
        <ProductSearchBox onSelect={addProduct} placeholder="품명·규격·별칭·바코드로 검색" />

        {lines.length > 0 && (
          <table className="dense-table">
            <thead>
              <tr>
                <th>품목</th>
                <th className="num">수량</th>
                <th>단위</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineId}>
                  <td>{l.label}</td>
                  <td className="num">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={l.quantity}
                      onChange={(e) => updateLine(l.lineId, { quantity: e.target.value })}
                      disabled={submit.isPending}
                    />
                  </td>
                  <td>
                    {l.units.length > 1 ? (
                      <select
                        value={l.unit}
                        onChange={(e) => updateLine(l.lineId, { unit: e.target.value })}
                        disabled={submit.isPending}
                      >
                        {l.units.map((u) => (
                          <option key={u.unit_code} value={u.unit_code}>
                            {u.unit_code}
                          </option>
                        ))}
                      </select>
                    ) : (
                      l.unit
                    )}
                  </td>
                  <td>
                    <button type="button" onClick={() => removeLine(l.lineId)} disabled={submit.isPending}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {lines.length > 0 && (
          <button type="button" onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending ? "저장 중..." : "입고 저장"}
          </button>
        )}
        {message && <p className="form-message">{message}</p>}
      </section>

      <StockCountPanel />
    </div>
  );
}

// 시나리오 9: 상품별 실사 입력. 직원·관리자 모두 가능하다(register_stock_count는 이미
// current_active_profile만 확인한다). 화면 경로가 없었을 뿐이라 여기에 최소한으로 추가한다.
function StockCountPanel() {
  const { profile } = useAuth();
  const [product, setProduct] = useState<ProductSearchResult | null>(null);
  const [qty, setQty] = useState("");
  const [occurredAt, setOccurredAt] = useState(kstNowInputValue());
  const [dayBoundary, setDayBoundary] = useState<"end_of_day" | "mid_day">("end_of_day");
  const [message, setMessage] = useState<string | null>(null);

  const { getRequestId, clearPending } = useIdempotentRequest(`stock_count_draft:${profile?.user_id ?? ""}`);

  const submit = useMutation({
    mutationFn: async () => {
      if (!product) throw new Error("CLIENT_VALIDATION: 상품을 먼저 검색해 선택하세요.");
      const qtyNum = Number(qty);
      if (qty === "" || qtyNum < 0) throw new Error("CLIENT_VALIDATION: 실사 수량을 입력하세요(0 이상).");
      const occurredAtKst = toKstTimestamp(occurredAt);
      const requestId = getRequestId(
        JSON.stringify({ product: product.product_id, qty: qtyNum, occurredAt: occurredAtKst, dayBoundary }),
      );
      const { error } = await supabase.rpc("register_stock_count", {
        p_request_id: requestId,
        p_product_id: product.product_id,
        p_qty: qtyNum,
        p_occurred_at: occurredAtKst,
        p_day_boundary: dayBoundary,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      clearPending();
      setMessage(`실사를 저장했습니다: ${product?.name} ${qty}${product?.base_unit}`);
      setProduct(null);
      setQty("");
      setOccurredAt(kstNowInputValue());
    },
    onError: (e: Error) => {
      const confirmedNoSave = e.message.includes("CLIENT_VALIDATION") || e.message.includes("INVALID");
      if (confirmedNoSave) clearPending();
      setMessage(confirmedNoSave ? `저장 실패: ${e.message}` : `저장 결과를 확인할 수 없습니다. 같은 내용으로 재시도하세요: ${e.message}`);
    },
  });

  return (
    <section style={{ marginTop: "20px" }}>
      <h2>실사 입력</h2>
      {message && <p className="form-message">{message}</p>}
      {!product ? (
        <ProductSearchBox onSelect={setProduct} placeholder="실사할 품목 검색" allowRegisterNew={false} />
      ) : (
        <p>
          선택된 상품: {product.name} {product.spec} ({product.base_unit})
          <button type="button" onClick={() => setProduct(null)}>
            변경
          </button>
        </p>
      )}
      <label>
        실사 수량 (기준단위, 0 가능)
        <input type="number" min="0" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label>
        실사 시각 (한국시간)
        <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </label>
      <label>
        기준 시점
        <select value={dayBoundary} onChange={(e) => setDayBoundary(e.target.value as "end_of_day" | "mid_day")}>
          <option value="end_of_day">마감 후(당일 판매 반영됨)</option>
          <option value="mid_day">장중(당일 남은 판매 예측으로 보정)</option>
        </select>
      </label>
      <button type="button" disabled={!product || submit.isPending} onClick={() => submit.mutate()}>
        {submit.isPending ? "저장 중..." : "실사 저장"}
      </button>
    </section>
  );
}
