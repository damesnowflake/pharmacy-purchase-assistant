import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { parseFlexibleDate, parseFlexibleQuantity, normalizeAliasText } from "@/lib/salesFileParsing";
import type { IsoDate } from "@/lib/date";

// IR-02 판매 업로드. FR-05~10.
// 실제 CatPOS 내보내기 표본이 없어(D-02, docs/미확인_항목.md) 특정 POS 포맷을 가정하지 않는
// 범용 CSV/XLSX 열 매핑 임포터로 구현했다. 동작은 실제 확인했지만 "CatPOS 호환"이라고
// 표시하지 않는다 — 실제 파일로 열 구조·반품 표기를 확인한 뒤 파서를 좁혀야 한다.

type Step = "pick" | "map" | "match" | "preview" | "done";

interface SheetRow {
  [column: string]: unknown;
}

interface ProductOption {
  id: string;
  name: string;
  spec: string;
}

interface ParsedRow {
  rowNo: number;
  rawItem: string;
  rawDate: unknown;
  rawQty: unknown;
  isoDate: IsoDate | null;
  qty: number | null;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function SalesUploadPage() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("pick");
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [dateCol, setDateCol] = useState("");
  const [itemCol, setItemCol] = useState("");
  const [qtyCol, setQtyCol] = useState("");
  const [itemMatches, setItemMatches] = useState<Record<string, string | "skip">>({});
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ applied_rows: number; skipped_rows: number; affected_products: number } | null>(
    null,
  );

  async function handleFile(file: File) {
    setMessage(null);
    const buffer = await file.arrayBuffer();
    const { read, utils } = await import("xlsx"); // 초기 번들 크기를 줄이기 위해 필요할 때만 불러온다.
    const wb = read(buffer, { type: "array", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const asArrays = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    if (asArrays.length < 2) {
      setMessage("데이터 행을 찾을 수 없습니다. 첫 행이 열 이름이어야 합니다.");
      return;
    }
    const headerRow = asArrays[0].map((h) => String(h ?? "").trim());
    const dataRows: SheetRow[] = asArrays.slice(1).map((arr) => {
      const obj: SheetRow = {};
      headerRow.forEach((h, i) => (obj[h] = arr[i]));
      return obj;
    });
    setFileBuffer(buffer);
    setFileName(file.name);
    setHeaders(headerRow);
    setRows(dataRows);

    // 흔한 한글 헤더명으로 기본값을 추정한다. 실제 CatPOS 헤더와 다를 수 있어 사용자가 확인·수정한다.
    const guess = (candidates: string[]) => headerRow.find((h) => candidates.some((c) => h.includes(c))) ?? "";
    setDateCol(guess(["판매일", "일자", "날짜"]));
    setItemCol(guess(["품목", "품명", "상품"]));
    setQtyCol(guess(["수량", "판매수량"]));
    setStep("map");
  }

  const parsedRows: ParsedRow[] = useMemo(() => {
    if (step === "pick" || !dateCol || !itemCol || !qtyCol) return [];
    return rows.map((r, i) => {
      const rawItem = String(r[itemCol] ?? "").trim();
      const rawDate = r[dateCol];
      const rawQty = r[qtyCol];
      return {
        rowNo: i + 1,
        rawItem,
        rawDate,
        rawQty,
        isoDate: parseFlexibleDate(rawDate),
        qty: parseFlexibleQuantity(rawQty),
      };
    });
  }, [rows, dateCol, itemCol, qtyCol, step]);

  const distinctItems = useMemo(
    () => Array.from(new Set(parsedRows.map((r) => r.rawItem).filter(Boolean))),
    [parsedRows],
  );

  async function goToMatching() {
    setMessage(null);
    const { data, error } = await supabase
      .from("products")
      .select("id, name, spec, product_aliases(alias, normalized_alias)")
      .eq("active", true);
    if (error) {
      setMessage(`품목 목록 조회 실패: ${error.message}`);
      return;
    }
    const options = (data ?? []).map((p) => ({ id: p.id as string, name: p.name as string, spec: p.spec as string }));
    setProductOptions(options);

    const aliasIndex = new Map<string, string>();
    for (const p of data ?? []) {
      aliasIndex.set(normalizeAliasText(p.name as string), p.id as string);
      for (const a of (p.product_aliases ?? []) as { normalized_alias: string }[]) {
        aliasIndex.set(a.normalized_alias, p.id as string);
      }
    }
    const initial: Record<string, string | "skip"> = {};
    for (const item of distinctItems) {
      const found = aliasIndex.get(normalizeAliasText(item));
      if (found) initial[item] = found;
    }
    setItemMatches(initial);
    setStep("match");
  }

  const unresolvedCount = distinctItems.filter((i) => !itemMatches[i]).length;

  const validRows = useMemo(() => {
    return parsedRows
      .map((r) => {
        const matched = itemMatches[r.rawItem];
        if (!matched || matched === "skip") return null;
        if (r.isoDate === null || r.qty === null) return null;
        return { productId: matched, saleDate: r.isoDate, netQty: r.qty };
      })
      .filter((r): r is { productId: string; saleDate: IsoDate; netQty: number } => r !== null);
  }, [parsedRows, itemMatches]);

  const invalidCount = parsedRows.length - validRows.length;
  const periodStart = validRows.length > 0 ? validRows.reduce((a, b) => (b.saleDate < a ? b.saleDate : a), validRows[0].saleDate) : null;
  const periodEnd = validRows.length > 0 ? validRows.reduce((a, b) => (b.saleDate > a ? b.saleDate : a), validRows[0].saleDate) : null;

  const submit = useMutation({
    mutationFn: async () => {
      if (!fileBuffer || !periodStart || !periodEnd) throw new Error("업로드할 유효한 행이 없습니다.");
      const fileHash = await sha256Hex(fileBuffer);

      const { data: beginData, error: beginError } = await supabase.rpc("begin_sales_import", {
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_file_hash: fileHash,
        p_mode: "full_period",
      });
      if (beginError) throw beginError;
      const importId = beginData.import_id as string;

      const BATCH_SIZE = 500;
      for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
        const batch = validRows.slice(i, i + BATCH_SIZE).map((r, j) => ({
          row_no: i + j + 1,
          product_id: r.productId,
          sale_date: r.saleDate,
          net_qty: r.netQty,
        }));
        const { error: stageError } = await supabase.rpc("stage_sales_rows", {
          p_import_id: importId,
          p_batch_no: Math.floor(i / BATCH_SIZE) + 1,
          p_rows: batch,
        });
        if (stageError) throw stageError;
      }

      const { data: commitData, error: commitError } = await supabase.rpc("commit_sales_import", {
        p_import_id: importId,
        p_expected_row_count: validRows.length,
      });
      if (commitError) throw commitError;

      // 판매 업로드 후 스케줄을 기다리지 않고 재계산을 요청한다 (시스템_구조_설계.md).
      // Edge Function이 아직 배포되지 않았을 수 있으므로 실패해도 업로드 자체는 성공으로 둔다.
      try {
        await supabase.functions.invoke("forecast-batch", { body: {} });
      } catch {
        // 배포 전이면 조용히 무시한다. recompute_queue에는 이미 예약되어 있다.
      }

      return commitData as { applied_rows: number; skipped_rows: number; affected_products: number };
    },
    onSuccess: (data) => {
      setResult(data);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
    onError: (e: Error) => setMessage(`업로드 실패: ${e.message}`),
  });

  return (
    <div className="sales-upload-page">
      <h2>판매 업로드</h2>
      <p className="form-message">
        실제 CatPOS 내보내기 열 이름이 확인되지 않아 열 매핑을 직접 확인하는 범용 가져오기입니다
        (docs/미확인_항목.md D-02). 반품·취소가 파일에 별도 행으로 표시되는지는 실제 표본으로
        확인해야 하며, 지금은 입력한 수량을 그대로 순판매수량으로 합산합니다.
      </p>
      {message && <p className="form-message error-text">{message}</p>}

      {step === "pick" && (
        <label>
          판매 파일 선택 (CSV/XLSX, 첫 행은 열 이름)
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </label>
      )}

      {step === "map" && (
        <div>
          <p>{fileName} · {rows.length}행 인식</p>
          <label>
            판매일 열
            <select value={dateCol} onChange={(e) => setDateCol(e.target.value)}>
              <option value="">선택</option>
              {headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </label>
          <label>
            품목 열
            <select value={itemCol} onChange={(e) => setItemCol(e.target.value)}>
              <option value="">선택</option>
              {headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </label>
          <label>
            수량 열
            <select value={qtyCol} onChange={(e) => setQtyCol(e.target.value)}>
              <option value="">선택</option>
              {headers.map((h) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!dateCol || !itemCol || !qtyCol} onClick={goToMatching}>
            다음: 품목 연결
          </button>
        </div>
      )}

      {step === "match" && (
        <div>
          <p>서로 다른 품목명 {distinctItems.length}개 중 미연결 {unresolvedCount}개</p>
          <table className="dense-table">
            <thead>
              <tr>
                <th>파일 상 품목명</th>
                <th>연결할 품목</th>
              </tr>
            </thead>
            <tbody>
              {distinctItems.map((item) => (
                <tr key={item}>
                  <td>{item}</td>
                  <td>
                    <select
                      value={itemMatches[item] ?? ""}
                      onChange={(e) =>
                        setItemMatches((prev) => ({ ...prev, [item]: e.target.value as string | "skip" }))
                      }
                    >
                      <option value="">선택 필요</option>
                      <option value="skip">건너뛰기(반영하지 않음)</option>
                      {productOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} {p.spec}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" disabled={unresolvedCount > 0} onClick={() => setStep("preview")}>
            다음: 미리보기
          </button>
        </div>
      )}

      {step === "preview" && (
        <div>
          <p>
            자료 기간: {periodStart} ~ {periodEnd} · 반영 예정 {validRows.length}행 · 해석 불가/건너뜀{" "}
            {invalidCount}행
          </p>
          <p className="form-message">
            같은 기간의 기존 판매 집계는 이 파일 내용으로 통째로 교체됩니다 (전체기간 보고서 처리
            방식, FR-07).
          </p>
          <button type="button" onClick={() => setStep("map")}>
            뒤로
          </button>
          <button type="button" disabled={submit.isPending || validRows.length === 0} onClick={() => submit.mutate()}>
            {submit.isPending ? "저장 중..." : "저장"}
          </button>
        </div>
      )}

      {step === "done" && result && (
        <div>
          <p className="form-message">
            반영 완료: {result.applied_rows}행 반영, {result.skipped_rows}행 건너뜀, 영향받은 품목{" "}
            {result.affected_products}개.
          </p>
          <button
            type="button"
            onClick={() => {
              setStep("pick");
              setFileBuffer(null);
              setRows([]);
              setResult(null);
            }}
          >
            새 파일 업로드
          </button>
        </div>
      )}
    </div>
  );
}
