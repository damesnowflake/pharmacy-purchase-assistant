import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";

interface SupplierRow {
  id: string;
  name: string;
  minimum_drug_amount: number;
  minimum_other_amount: number;
  promotion_note: string | null;
}

interface ClosedDateRow {
  supplier_id: string;
  closed_date: string;
  reason: string | null;
}

// FR-18~19: 거래처별 최소주문금액·프로모션 메모, 거래처 자체 휴무일.
export function SuppliersPanel() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState({ name: "", drug: "200000", other: "50000", note: "" });
  const [closedDateForm, setClosedDateForm] = useState<Record<string, { date: string; reason: string }>>({});

  const { data: suppliers } = useQuery({
    queryKey: ["suppliers", "settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id, name, minimum_drug_amount, minimum_other_amount, promotion_note")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data as SupplierRow[];
    },
  });

  const { data: closedDates } = useQuery({
    queryKey: ["supplier_closed_dates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("supplier_closed_dates")
        .select("supplier_id, closed_date, reason")
        .order("closed_date");
      if (error) throw error;
      return data as ClosedDateRow[];
    },
  });

  const saveSupplier = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("save_supplier", {
        p_id: null,
        p_name: newSupplier.name,
        p_minimum_drug_amount: Number(newSupplier.drug),
        p_minimum_other_amount: Number(newSupplier.other),
        p_promotion_note: newSupplier.note || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setMessage("거래처가 저장되었습니다.");
      setNewSupplier({ name: "", drug: "200000", other: "50000", note: "" });
      queryClient.invalidateQueries({ queryKey: ["suppliers"] });
    },
    onError: (e: Error) => setMessage(`저장 실패: ${e.message}`),
  });

  const addClosedDate = useMutation({
    mutationFn: async (supplierId: string) => {
      const form = closedDateForm[supplierId];
      if (!form?.date) throw new Error("휴무일을 선택하세요.");
      const { error } = await supabase.rpc("set_supplier_closed_date", {
        p_supplier_id: supplierId,
        p_closed_date: form.date,
        p_reason: form.reason || null,
        p_remove: false,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["supplier_closed_dates"] });
    },
    onError: (e: Error) => setMessage(`휴무일 저장 실패: ${e.message}`),
  });

  const removeClosedDate = useMutation({
    mutationFn: async (row: ClosedDateRow) => {
      const { error } = await supabase.rpc("set_supplier_closed_date", {
        p_supplier_id: row.supplier_id,
        p_closed_date: row.closed_date,
        p_reason: null,
        p_remove: true,
      });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["supplier_closed_dates"] }),
  });

  return (
    <div>
      <h3>거래처</h3>
      {message && <p className="form-message">{message}</p>}
      <table className="dense-table">
        <thead>
          <tr>
            <th>이름</th>
            <th className="num">의약품 최소금액</th>
            <th className="num">의약외품 최소금액</th>
            <th>프로모션 메모</th>
            <th>휴무일 추가</th>
          </tr>
        </thead>
        <tbody>
          {(suppliers ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td className="num">{s.minimum_drug_amount.toLocaleString()}</td>
              <td className="num">{s.minimum_other_amount.toLocaleString()}</td>
              <td>{s.promotion_note ?? "-"}</td>
              <td>
                <input
                  type="date"
                  onChange={(e) =>
                    setClosedDateForm((prev) => ({
                      ...prev,
                      [s.id]: { ...prev[s.id], date: e.target.value },
                    }))
                  }
                />
                <input
                  placeholder="사유"
                  style={{ width: "80px" }}
                  onChange={(e) =>
                    setClosedDateForm((prev) => ({
                      ...prev,
                      [s.id]: { ...prev[s.id], reason: e.target.value },
                    }))
                  }
                />
                <button type="button" onClick={() => addClosedDate.mutate(s.id)}>
                  추가
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>새 거래처 추가</h4>
      <label>
        이름
        <input value={newSupplier.name} onChange={(e) => setNewSupplier((p) => ({ ...p, name: e.target.value }))} />
      </label>
      <label>
        의약품 최소주문금액
        <input
          type="number"
          value={newSupplier.drug}
          onChange={(e) => setNewSupplier((p) => ({ ...p, drug: e.target.value }))}
        />
      </label>
      <label>
        의약외품 최소주문금액
        <input
          type="number"
          value={newSupplier.other}
          onChange={(e) => setNewSupplier((p) => ({ ...p, other: e.target.value }))}
        />
      </label>
      <label>
        프로모션 메모
        <input value={newSupplier.note} onChange={(e) => setNewSupplier((p) => ({ ...p, note: e.target.value }))} />
      </label>
      <button type="button" disabled={!newSupplier.name || saveSupplier.isPending} onClick={() => saveSupplier.mutate()}>
        거래처 추가
      </button>

      <h4>등록된 휴무일</h4>
      <table className="dense-table">
        <thead>
          <tr>
            <th>거래처</th>
            <th>날짜</th>
            <th>사유</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(closedDates ?? []).map((c) => (
            <tr key={`${c.supplier_id}-${c.closed_date}`}>
              <td>{suppliers?.find((s) => s.id === c.supplier_id)?.name ?? c.supplier_id}</td>
              <td>{c.closed_date}</td>
              <td>{c.reason ?? "-"}</td>
              <td>
                <button type="button" onClick={() => removeClosedDate.mutate(c)}>
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
