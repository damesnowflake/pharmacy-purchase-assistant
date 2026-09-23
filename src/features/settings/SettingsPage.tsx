import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { SuppliersPanel } from "./SuppliersPanel";
import { CapacityPanel } from "./CapacityPanel";
import { ProductSearchBox } from "@/features/products/ProductSearchBox";
import { ProductRegisterForm } from "@/features/products/ProductRegisterForm";
import { useProductUnits } from "@/lib/useProductUnits";
import type { ProductSearchResult } from "@/lib/useProductSearch";

interface ProductRow {
  id: string;
  name: string;
  spec: string;
  base_unit: string;
  default_moq: number | null;
  default_order_step: number | null;
  version: number;
}

// IR-06 설정(관리자): 상품 등록·검색·MOQ·발주 단위, 거래처·휴무일.
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
  const [message, setMessage] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 선택된 상품 하나만 조회한다. 상품이 수천 개여도(실제 배포 환경 기준) 전체를 한 번에 내려받지
  // 않는다 — 예전에는 활성 상품 전체를 select해 PostgREST 기본 응답 제한(1,000행)에 걸리면
  // 뒤쪽 상품이 화면에서 통째로 사라졌다.
  const { data: selected, isLoading } = useQuery({
    queryKey: ["products", "settings", selectedId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("id, name, spec, base_unit, default_moq, default_order_step, version")
        .eq("id", selectedId as string)
        .single();
      if (error) throw error;
      return data as ProductRow;
    },
    enabled: Boolean(selectedId),
  });

  function handleRegistered(p: ProductSearchResult) {
    setMessage(`${p.name} ${p.spec} 등록(또는 기존 선택) 완료.`);
    setShowRegister(false);
    setSelectedId(p.product_id);
    queryClient.invalidateQueries({ queryKey: ["products"] });
  }

  return (
    <div>
      <h2>품목 설정</h2>
      {message && <p className="form-message">{message}</p>}

      <ProductSearchBox
        allowRegisterNew={false}
        placeholder="품목 검색 후 선택하면 아래에서 MOQ·발주단위·포장단위를 고칠 수 있습니다"
        onSelect={(p) => setSelectedId(p.product_id)}
      />

      <button type="button" onClick={() => setShowRegister((v) => !v)}>
        {showRegister ? "새 상품 등록 닫기" : "새 상품 등록"}
      </button>
      {showRegister && <ProductRegisterForm onRegistered={handleRegistered} onCancel={() => setShowRegister(false)} />}

      {isLoading && <p className="form-message">불러오는 중...</p>}
      {selected && <ProductEditCard product={selected} onSaved={(m) => setMessage(m)} />}
    </div>
  );
}

function ProductEditCard({ product, onSaved }: { product: ProductRow; onSaved: (m: string) => void }) {
  const queryClient = useQueryClient();
  const [moq, setMoq] = useState(String(product.default_moq ?? ""));
  const [step, setStep] = useState(String(product.default_order_step ?? ""));
  const { data: units, isLoading: unitsLoading } = useProductUnits(product.id);
  const [newUnitCode, setNewUnitCode] = useState("");
  const [newUnitFactor, setNewUnitFactor] = useState("");

  const saveSettings = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("save_product_settings", {
        p_product_id: product.id,
        p_expected_version: product.version,
        p_default_moq: moq.trim() ? Number(moq) : null,
        p_default_order_step: step.trim() ? Number(step) : null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      onSaved("MOQ·발주 단위를 저장했습니다.");
      queryClient.invalidateQueries({ queryKey: ["products", "settings"] });
    },
    onError: (e: Error) => onSaved(`저장 실패: ${e.message}`),
  });

  const saveUnit = useMutation({
    mutationFn: async (input: { unitCode: string; factor: number | null; remove: boolean }) => {
      const { error } = await supabase.rpc("save_product_unit", {
        p_product_id: product.id,
        p_unit_code: input.unitCode,
        p_factor_to_base: input.factor,
        p_remove: input.remove,
      });
      if (error) throw error;
    },
    onSuccess: (_d, input) => {
      onSaved(input.remove ? "단위를 삭제했습니다." : "포장 단위를 저장했습니다.");
      setNewUnitCode("");
      setNewUnitFactor("");
      queryClient.invalidateQueries({ queryKey: ["product_units", product.id] });
    },
    onError: (e: Error) => onSaved(`단위 저장 실패: ${e.message}`),
  });

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "10px", marginTop: "10px" }}>
      <h3>
        {product.name} {product.spec} (기준단위: {product.base_unit})
      </h3>

      <label>
        MOQ (없으면 추천 계산 시 입력 필요로 표시)
        <input type="number" min="0" step="any" value={moq} onChange={(e) => setMoq(e.target.value)} />
      </label>
      <label>
        발주 단위
        <input type="number" min="0" step="any" value={step} onChange={(e) => setStep(e.target.value)} />
      </label>
      <button type="button" disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>
        {saveSettings.isPending ? "저장 중..." : "MOQ·발주 단위 저장"}
      </button>

      <h4 style={{ marginTop: "12px" }}>포장 단위</h4>
      {unitsLoading && <p className="form-message">불러오는 중...</p>}
      {units && (
        <table className="dense-table">
          <thead>
            <tr>
              <th>단위</th>
              <th className="num">기준단위 환산값</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.unit_code}>
                <td>{u.unit_code}</td>
                <td className="num">{u.factor_to_base}</td>
                <td>
                  {u.unit_code !== product.base_unit && (
                    <button
                      type="button"
                      onClick={() => saveUnit.mutate({ unitCode: u.unit_code, factor: null, remove: true })}
                    >
                      삭제
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: "flex", gap: "6px", alignItems: "flex-end" }}>
        <label>
          새 단위 (예: 박스)
          <input value={newUnitCode} onChange={(e) => setNewUnitCode(e.target.value)} />
        </label>
        <label>
          {product.base_unit} 환산값 (예: 박스=10{product.base_unit}이면 10)
          <input type="number" min="0" step="any" value={newUnitFactor} onChange={(e) => setNewUnitFactor(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={!newUnitCode.trim() || !newUnitFactor.trim() || saveUnit.isPending}
          onClick={() => saveUnit.mutate({ unitCode: newUnitCode.trim(), factor: Number(newUnitFactor), remove: false })}
        >
          추가·수정
        </button>
      </div>
    </div>
  );
}
