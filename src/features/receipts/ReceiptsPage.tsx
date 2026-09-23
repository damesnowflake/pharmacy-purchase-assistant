import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { OcrCapture } from "./OcrCapture";

interface ProductOption {
  id: string;
  name: string;
  spec: string;
  base_unit: string;
}

interface ReceiptLine {
  productId: string;
  label: string;
  quantity: string;
  unit: string;
}

// IR-03 입고 등록. FR-11~14. 수동 입력과 기기 내 OCR(Tesseract.js) 촬영 입력 모두 지원한다.
// OCR 인식 정확도는 실제 입고장 사진·iPhone 실기기로 검증되지 않았다 (D-04,
// docs/미확인_항목.md) — 그래서 OCR 결과는 항상 이 화면의 확정 목록을 거쳐야 저장된다.
export function ReceiptsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [showOcr, setShowOcr] = useState(false);

  const { data: options } = useQuery({
    queryKey: ["products", "search", search],
    queryFn: async () => {
      let query = supabase.from("products").select("id, name, spec, base_unit").eq("active", true).limit(20);
      if (search.trim()) query = query.ilike("name", `%${search.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data as ProductOption[];
    },
  });

  function upsertLine(next: ReceiptLine) {
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === next.productId && l.unit === next.unit);
      if (!existing) return [...prev, next];
      const merged = (Number(existing.quantity) || 0) + (Number(next.quantity) || 0);
      return prev.map((l) => (l === existing ? { ...l, quantity: String(merged) } : l));
    });
  }

  function addLine(p: ProductOption) {
    upsertLine({ productId: p.id, label: `${p.name} ${p.spec}`.trim(), quantity: "", unit: p.base_unit });
  }

  function updateLine(productId: string, patch: Partial<ReceiptLine>) {
    setLines((prev) => prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));
  }

  function removeLine(productId: string) {
    setLines((prev) => prev.filter((l) => l.productId !== productId));
  }

  const submit = useMutation({
    mutationFn: async () => {
      const items = lines.map((l) => ({
        product_id: l.productId,
        quantity: Number(l.quantity),
        unit: l.unit,
      }));
      if (items.some((i) => !i.quantity || i.quantity <= 0)) {
        throw new Error("모든 품목의 실제 입고 수량을 입력하세요.");
      }
      const { data, error } = await supabase.rpc("register_receipt", {
        p_request_id: crypto.randomUUID(),
        p_occurred_at: new Date().toISOString(),
        p_items: items,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      setMessage("입고가 저장되었습니다.");
      setLines([]);
      queryClient.invalidateQueries({ queryKey: ["product_state"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
    onError: (e: Error) => setMessage(`저장 실패: ${e.message}`),
  });

  return (
    <div className="receipts-page">
      <section className="receipts-manual">
        <h2>입고 등록</h2>

        <button type="button" onClick={() => setShowOcr((v) => !v)}>
          {showOcr ? "촬영 입력 닫기" : "촬영으로 입력"}
        </button>
        {showOcr && <OcrCapture onResolved={upsertLine} />}

        <h3>수동 입력</h3>
        <label>
          품목 검색
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="품명으로 검색" />
        </label>
        {options && options.length > 0 && (
          <ul className="search-results">
            {options.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => addLine(p)}>
                  {p.name} {p.spec} 추가
                </button>
              </li>
            ))}
          </ul>
        )}

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
                <tr key={l.productId}>
                  <td>{l.label}</td>
                  <td className="num">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={l.quantity}
                      onChange={(e) => updateLine(l.productId, { quantity: e.target.value })}
                    />
                  </td>
                  <td>{l.unit}</td>
                  <td>
                    <button type="button" onClick={() => removeLine(l.productId)}>
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
    </div>
  );
}
