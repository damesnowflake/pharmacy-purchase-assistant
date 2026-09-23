import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";

interface SupplierRow {
  id: string;
  name: string;
  promotion_note: string | null;
}

interface ClosedDateRow {
  supplier_id: string;
  closed_date: string;
  reason: string | null;
}

// FR-18~19(갱신): 거래처 기본정보·프로모션 메모, 거래처 자체 휴무일.
// 최소구매금액 입력·기본값·경고는 제거했다 — 구매 담당자가 실제 주문 시 직접 판단하므로
// 시스템에서 요구하지 않는다(최종 검수 보완 사항, docs/미확인_항목.md 참고).
export function SuppliersPanel() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState({ name: "", note: "" });
  const [closedDateForm, setClosedDateForm] = useState<Record<string, { date: string; reason: string }>>({});

  const { data: suppliers } = useQuery({
    queryKey: ["suppliers", "settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("suppliers")
        .select("id, name, promotion_note")
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
        p_promotion_note: newSupplier.note || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setMessage("거래처가 저장되었습니다.");
      setNewSupplier({ name: "", note: "" });
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
            <th>프로모션 메모</th>
            <th>휴무일 추가</th>
          </tr>
        </thead>
        <tbody>
          {(suppliers ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
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
