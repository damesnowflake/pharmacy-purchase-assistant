import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/features/auth/AuthContext";
import { useProductSearch, type ProductSearchResult } from "@/lib/useProductSearch";

/**
 * 상품 등록 폼. 직원·관리자 모두 기본정보(품명·규격·기준단위·별칭·POS코드/바코드)를 등록할 수
 * 있다. MOQ·발주단위는 발주 설정이라 관리자에게만 입력란을 보여준다 — 그래도 직원이 API를
 * 직접 호출해 넣으려 하면 create_product RPC가 거부한다(화면과 DB 양쪽에서 강제).
 *
 * 이름을 입력하는 동안 비슷한 기존 상품을 보여줘 중복 등록을 줄인다. 같은 이름이라도 규격이
 * 다르면 별도 상품으로 등록할 수 있다(막지 않음, 안내만 한다).
 */
export function ProductRegisterForm({
  initialName = "",
  onRegistered,
  onCancel,
}: {
  initialName?: string;
  onRegistered: (p: ProductSearchResult) => void;
  onCancel: () => void;
}) {
  const { profile } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = profile?.role === "admin";

  const [name, setName] = useState(initialName);
  const [spec, setSpec] = useState("");
  const [baseUnit, setBaseUnit] = useState("");
  const [allowsFraction, setAllowsFraction] = useState(false);
  const [alias, setAlias] = useState("");
  const [sourceCode, setSourceCode] = useState("");
  const [moq, setMoq] = useState("");
  const [orderStep, setOrderStep] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: similar } = useProductSearch(name.trim());

  const register = useMutation({
    mutationFn: async () => {
      const aliases = alias.trim()
        ? [{ source: "manual", source_code: sourceCode.trim() || null, alias: alias.trim() }]
        : [];
      const { data, error } = await supabase.rpc("create_product", {
        p_name: name.trim(),
        p_spec: spec.trim(),
        p_base_unit: baseUnit.trim(),
        p_allows_fraction: allowsFraction,
        p_observed_from: null,
        p_aliases: aliases,
        p_default_moq: isAdmin && moq.trim() ? Number(moq) : null,
        p_default_order_step: isAdmin && orderStep.trim() ? Number(orderStep) : null,
      });
      if (error) throw error;
      return data as { product_id: string; version: number; base_unit: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      onRegistered({
        product_id: data.product_id,
        name: name.trim(),
        spec: spec.trim(),
        base_unit: data.base_unit,
        default_moq: isAdmin && moq.trim() ? Number(moq) : null,
        default_order_step: isAdmin && orderStep.trim() ? Number(orderStep) : null,
      });
    },
    onError: (e: Error) => setError(`등록 실패: ${e.message}`),
  });

  const canSubmit = name.trim() !== "" && baseUnit.trim() !== "" && !register.isPending;

  return (
    <div className="product-register-form" style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "10px", marginTop: "6px" }}>
      <h4>새 상품 등록</h4>

      {similar && similar.length > 0 && (
        <div>
          <p className="form-message">
            이미 비슷한 이름의 상품이 있습니다. 같은 상품이면 아래에서 선택하세요(규격이 다르면
            새로 등록해도 됩니다).
          </p>
          <ul className="search-results">
            {similar.map((p) => (
              <li key={p.product_id}>
                <button type="button" onClick={() => onRegistered(p)}>
                  이 상품 사용: {p.name} {p.spec} ({p.base_unit})
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="form-message error-text">{error}</p>}

      <label>
        상품명
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        규격
        <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="예: 500mg, 30정" />
      </label>
      <label>
        기준 단위
        <input value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} placeholder="예: 정, 병, 박스" />
      </label>
      <label style={{ flexDirection: "row", alignItems: "center", gap: "6px" }}>
        <input type="checkbox" checked={allowsFraction} onChange={(e) => setAllowsFraction(e.target.checked)} />
        소수 수량 허용
      </label>
      <label>
        별칭 (선택)
        <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="POS 상 표시 이름 등" />
      </label>
      <label>
        POS 코드·바코드 (선택)
        <input value={sourceCode} onChange={(e) => setSourceCode(e.target.value)} />
      </label>

      {isAdmin && (
        <>
          <label>
            MOQ (선택, 없으면 추천 계산 시 입력 필요로 표시됨)
            <input type="number" min="0" step="any" value={moq} onChange={(e) => setMoq(e.target.value)} />
          </label>
          <label>
            발주 단위 (선택)
            <input type="number" min="0" step="any" value={orderStep} onChange={(e) => setOrderStep(e.target.value)} />
          </label>
        </>
      )}

      <div style={{ display: "flex", gap: "6px" }}>
        <button type="button" disabled={!canSubmit} onClick={() => register.mutate()}>
          {register.isPending ? "등록 중..." : "등록"}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
