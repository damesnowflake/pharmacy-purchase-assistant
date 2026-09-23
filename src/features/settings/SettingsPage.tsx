import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { SuppliersPanel } from "./SuppliersPanel";
import { CapacityPanel } from "./CapacityPanel";

interface ProductRow {
  id: string;
  name: string;
  spec: string;
  base_unit: string;
  default_moq: number | null;
  default_order_step: number | null;
  version: number;
}

// IR-06 설정(관리자): 품목 MOQ·발주 단위, 거래처·최소주문금액·휴무일.
// 품목별 거래처 발주조건(purchase_terms) 개별 편집 화면은 이후 단계에서 추가한다.
export function SettingsPage() {
  const [tab, setTab] = useState<"products" | "suppliers" | "capacity">("products");
  return (
    <div>
      <div style={{ display: "flex", gap: "4px", marginBottom: "12px" }}>
        <button type="button" onClick={() => setTab("products")} disabled={tab === "products"}>
          품목
        </button>
        <button type="button" onClick={() => setTab("suppliers")} disabled={tab === "suppliers"}>
          거래처
        </button>
        <button type="button" onClick={() => setTab("capacity")} disabled={tab === "capacity"}>
          용량
        </button>
      </div>
      {tab === "products" && <ProductSettingsPanel />}
      {tab === "suppliers" && <SuppliersPanel />}
      {tab === "capacity" && <CapacityPanel />}
    </div>
  );
}

function ProductSettingsPanel() {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, { moq: string; step: string }>>({});
  const [message, setMessage] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["products", "settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, spec, base_unit, default_moq, default_order_step, version")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data as ProductRow[];
    },
  });

  const save = useMutation({
    mutationFn: async (p: ProductRow) => {
      const edit = edits[p.id];
      const moq = edit?.moq !== undefined ? Number(edit.moq) : p.default_moq;
      const step = edit?.step !== undefined ? Number(edit.step) : p.default_order_step;
      const { error } = await supabase.rpc("save_product_settings", {
        p_product_id: p.id,
        p_expected_version: p.version,
        p_default_moq: moq,
        p_default_order_step: step,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setMessage("저장되었습니다.");
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (e: Error) => setMessage(`저장 실패: ${e.message}`),
  });

  if (isLoading) return <div className="center-message">불러오는 중...</div>;
  if (error) return <div className="center-message error">조회 실패: {(error as Error).message}</div>;

  return (
    <div>
      <h2>품목 설정 (MOQ·발주 단위)</h2>
      {message && <p className="form-message">{message}</p>}
      <table className="dense-table">
        <thead>
          <tr>
            <th>품목</th>
            <th>규격</th>
            <th className="num">MOQ</th>
            <th className="num">발주 단위</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.spec}</td>
              <td className="num">
                <input
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={p.default_moq ?? ""}
                  placeholder="입력 필요"
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], moq: e.target.value } }))
                  }
                />
              </td>
              <td className="num">
                <input
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={p.default_order_step ?? ""}
                  placeholder="입력 필요"
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [p.id]: { ...prev[p.id], step: e.target.value } }))
                  }
                />
              </td>
              <td>
                <button type="button" onClick={() => save.mutate(p)} disabled={save.isPending}>
                  저장
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
