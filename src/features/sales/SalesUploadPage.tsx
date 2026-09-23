import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import {
  parseFlexibleDate,
  parseFlexibleQuantity,
  findDateGaps,
  classifySalesRows,
  decodeCsvBytes,
  type RowOverride,
} from "@/lib/salesFileParsing";
import {
  detectCatposTalkFileColumns,
  parseCatposTalkFileRows,
  type CatposParseError,
} from "@/lib/catposTalkFileParser";
import type { IsoDate } from "@/lib/date";
import { matchSalesItems, type MatchResult } from "@/lib/productMatching";
import { ProductSearchBox } from "@/features/products/ProductSearchBox";
import type { ProductSearchResult } from "@/lib/useProductSearch";

// IR-02 판매 업로드. FR-05~10.
// 열이 CatPOS "톡파일" 판매내역 구조(거래 헤더 + 상품상세 텍스트 행, catposTalkFileParser.ts
// 참고)와 일치하면 전용 파서를 자동으로 쓴다. 이 구조는 사용자가 제공한 실제 판매내역 표본으로
// 확인했다 — 다만 반품·취소 표현 방식은 그 표본 기간에 사례가 없어 여전히 확인되지 않았다
// (D-02, docs/미확인_항목.md). 헤더가 일치하지 않으면 열을 직접 지정하는 범용 CSV/XLSX
// 가져오기로 대체한다.
//
// FR-06: "해석할 수 없는 날짜·수량·품목이 있으면 확정 저장 전에 수정할 수 있게 한다... 잘못된
// 행을 임의의 날짜·수량으로 바꾸거나 조용히 누락하지 않는다." 이 화면은 그래서 세 종류의 행을
// 구분한다.
//   1) 완전히 빈 행(품목·날짜·수량 모두 없음) — 표 서식상 흔한 여백이므로 조용히 무시한다.
//   2) 품목명이 있지만 "건너뛰기"를 직원이 명시적으로 선택한 행(합계·헤더 반복 등 비거래 행으로
//      직원이 확인한 경우) — 화면에 몇 건인지 표시하되 저장을 막지 않는다.
//   3) 품목은 실제 상품으로 연결됐는데 날짜·수량을 해석할 수 없는 행 — 실제 거래로 보이므로
//      저장을 막고, 직원이 값을 고치거나 그 행만 명시적으로 제외해야 다음 단계로 진행된다.

type Step = "pick" | "map" | "match" | "preview" | "done";

interface SheetRow {
  [column: string]: unknown;
}

interface ParsedRow {
  rowNo: number;
  rawItem: string;
  rawDateText: string;
  rawQtyText: string;
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

function rawToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function SalesUploadPage() {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("pick");
  const [mode, setMode] = useState<"generic" | "catpos">("generic");
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [dateCol, setDateCol] = useState("");
  const [itemCol, setItemCol] = useState("");
  const [qtyCol, setQtyCol] = useState("");
  const [catposLineItems, setCatposLineItems] = useState<
    { rowNo: number; itemNameRaw: string; saleDate: IsoDate; quantity: number }[]
  >([]);
  const [catposErrors, setCatposErrors] = useState<CatposParseError[]>([]);
  const [catposErrorsAcknowledged, setCatposErrorsAcknowledged] = useState(false);
  const [itemMatches, setItemMatches] = useState<Record<string, string | "skip">>({});
  const [matchInfo, setMatchInfo] = useState<Record<string, MatchResult>>({});
  const [matchLoading, setMatchLoading] = useState(false);
  const [pickerOpenFor, setPickerOpenFor] = useState<string | null>(null);
  const [saveAliasFor, setSaveAliasFor] = useState<Record<string, boolean>>({});
  const [rowOverrides, setRowOverrides] = useState<Record<number, RowOverride>>({});
  const [gapsAcknowledged, setGapsAcknowledged] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ applied_rows: number; skipped_rows: number; affected_products: number } | null>(
    null,
  );

  async function handleFile(file: File) {
    setMessage(null);
    const buffer = await file.arrayBuffer();
    const { read, utils } = await import("xlsx"); // 초기 번들 크기를 줄이기 위해 필요할 때만 불러온다.

    // CSV는 SheetJS에 원시 버퍼를 그대로 넘기면 BOM 없는 UTF-8을 다른 코드페이지로 오인식해
    // 한글이 깨질 수 있어(decodeCsvBytes 주석 참고) 직접 디코드한 문자열로 읽는다.
    // cellDates는 두 형식 모두 false로 둔다: 날짜 셀을 JS Date로 바꾸면(SheetJS가 CSV의 날짜
    // "문자열"을 브라우저 로컬 시간대로 해석해) 자정 근처 날짜가 하루 밀리는 문제가 있었다.
    // 대신 엑셀 일련번호(숫자) 또는 원문 문자열로 받아 parseFlexibleDate가 시간대와 무관하게
    // 직접 해석하게 한다.
    const isCsv = file.name.toLowerCase().endsWith(".csv");
    const wb = isCsv
      ? read(decodeCsvBytes(new Uint8Array(buffer)), { type: "string", cellDates: false })
      : read(buffer, { type: "array", cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const asArrays = utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    if (asArrays.length < 2) {
      setMessage("데이터 행을 찾을 수 없습니다. 첫 행이 열 이름이어야 합니다.");
      return;
    }
    const headerRow = asArrays[0].map((h) => String(h ?? "").trim());
    const dataRowsRaw = asArrays.slice(1);

    setFileBuffer(buffer);
    setFileName(file.name);
    setHeaders(headerRow);
    setRowOverrides({});
    setGapsAcknowledged(false);
    setCatposErrorsAcknowledged(false);
    setMatchInfo({});
    setItemMatches({});
    setSaveAliasFor({});
    setPickerOpenFor(null);

    const catposColumns = detectCatposTalkFileColumns(headerRow);
    if (catposColumns) {
      // CatPOS 톡파일 구조로 인식됨: 거래 헤더+상품상세 행을 바로 해석해 열 매핑 단계를 건너뛴다.
      const parsed = parseCatposTalkFileRows(dataRowsRaw, catposColumns);
      setMode("catpos");
      setCatposLineItems(
        parsed.lineItems.map((li) => ({
          rowNo: li.rowNo,
          itemNameRaw: li.itemNameRaw,
          saleDate: li.saleDate,
          quantity: li.quantity,
        })),
      );
      setCatposErrors(parsed.errors);
      setStep("match");
      return;
    }

    setMode("generic");
    const dataRows: SheetRow[] = dataRowsRaw.map((arr) => {
      const obj: SheetRow = {};
      headerRow.forEach((h, i) => (obj[h] = arr[i]));
      return obj;
    });
    setRows(dataRows);

    // 흔한 한글 헤더명으로 기본값을 추정한다. 실제 CatPOS 헤더와 다를 수 있어 사용자가 확인·수정한다.
    const guess = (candidates: string[]) => headerRow.find((h) => candidates.some((c) => h.includes(c))) ?? "";
    setDateCol(guess(["판매일", "일자", "날짜"]));
    setItemCol(guess(["품목", "품명", "상품"]));
    setQtyCol(guess(["수량", "판매수량"]));
    setStep("map");
  }

  const parsedRows: ParsedRow[] = useMemo(() => {
    if (mode === "catpos") {
      return catposLineItems.map((li) => ({
        rowNo: li.rowNo,
        rawItem: li.itemNameRaw,
        rawDateText: li.saleDate,
        rawQtyText: String(li.quantity),
        rawDate: li.saleDate,
        rawQty: li.quantity,
        isoDate: li.saleDate,
        qty: li.quantity,
      }));
    }
    if (step === "pick" || !dateCol || !itemCol || !qtyCol) return [];
    return rows.map((r, i) => {
      const rawItem = String(r[itemCol] ?? "").trim();
      const rawDate = r[dateCol];
      const rawQty = r[qtyCol];
      const isoDate = parseFlexibleDate(rawDate);
      return {
        rowNo: i + 1,
        rawItem,
        // 날짜 열은 엑셀 일련번호(숫자)로 들어올 수 있어, 해석에 성공했으면 사람이 읽고 고칠 수
        // 있는 IsoDate 문자열을 기본 표시값으로 쓴다(원문 숫자를 그대로 보여주지 않는다).
        rawDateText: isoDate ?? rawToText(rawDate),
        rawQtyText: rawToText(rawQty),
        rawDate,
        rawQty,
        isoDate,
        qty: parseFlexibleQuantity(rawQty),
      };
    });
  }, [rows, dateCol, itemCol, qtyCol, step, mode, catposLineItems]);

  // 품목·날짜·수량이 모두 비어 있는 행만 "완전히 빈 행"으로 조용히 무시한다. 그 외에는 실제
  // 거래 행일 가능성이 있으므로 무시하지 않는다.
  const isBlankRow = (r: ParsedRow) => !r.rawItem && !r.rawDateText.trim() && !r.rawQtyText.trim();

  const contentRows = useMemo(() => parsedRows.filter((r) => !isBlankRow(r)), [parsedRows]);
  const blankRowCount = parsedRows.length - contentRows.length;

  const distinctItems = useMemo(
    () => Array.from(new Set(contentRows.map((r) => r.rawItem).filter(Boolean))),
    [contentRows],
  );

  // match 단계에 처음 들어올 때 품목명마다 search_products로 후보를 조회한다(이름·규격·별칭·
  // POS코드/바코드 전부 대상). 상품 전체를 한 번에 내려받지 않으므로 상품이 몇천 개여도
  // 응답 제한에 걸리지 않는다. 이름이 정확히 일치하는 후보가 하나뿐일 때만 자동 연결하고,
  // 같은 이름의 서로 다른 규격이 여러 개면 자동으로 하나를 골라 덮어쓰지 않는다(시나리오 6).
  useEffect(() => {
    if (step !== "match" || distinctItems.length === 0 || Object.keys(matchInfo).length > 0) return;
    let cancelled = false;
    (async () => {
      setMessage(null);
      setMatchLoading(true);
      try {
        const found = await matchSalesItems(distinctItems);
        if (cancelled) return;
        const infoObj: Record<string, MatchResult> = {};
        const initialMatches: Record<string, string | "skip"> = {};
        for (const [item, info] of found.entries()) {
          infoObj[item] = info;
          if (info.autoMatchedId) initialMatches[item] = info.autoMatchedId;
        }
        setMatchInfo(infoObj);
        setItemMatches((prev) => ({ ...initialMatches, ...prev }));
      } catch (e) {
        if (!cancelled) setMessage(`품목 검색 실패: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setMatchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, distinctItems.length]);

  const linkAlias = useMutation({
    mutationFn: async (input: { productId: string; alias: string }) => {
      const { error } = await supabase.rpc("add_product_alias", {
        p_product_id: input.productId,
        p_alias: input.alias,
        p_source: "sales_upload",
      });
      if (error) throw error;
    },
  });

  function chooseMatch(item: string, productId: string) {
    setItemMatches((prev) => ({ ...prev, [item]: productId }));
    setPickerOpenFor(null);
    if (saveAliasFor[item] !== false) {
      linkAlias.mutate({ productId, alias: item });
    }
  }

  // 품목명이 있는데 아직 아무것도 선택하지 않은 경우만 "미연결"로 본다. 품목명이 비어 있는
  // 행(날짜·수량만 있는 이상 행)은 품목 매칭 단계에서 처리할 대상이 아니라, 아래 행별 문제
  // 목록에서 다룬다.
  const unresolvedCount = distinctItems.filter((i) => !itemMatches[i]).length;

  const contentRowsByRowNo = useMemo(() => new Map(contentRows.map((r) => [r.rowNo, r])), [contentRows]);

  const classified = useMemo(
    () => classifySalesRows(contentRows, itemMatches, rowOverrides),
    [contentRows, itemMatches, rowOverrides],
  );

  const { valid: validRows, skippedByItemChoice, excludedByUser } = classified;
  // 렌더링에는 원본 rawDateText/rawQtyText(표시용)가 필요하므로 rowNo로 원본 행을 다시 찾는다.
  const blockingIssues = classified.blocking.map((b) => contentRowsByRowNo.get(b.rowNo)!);

  const periodStart =
    validRows.length > 0 ? validRows.reduce((a, b) => (b.saleDate < a ? b.saleDate : a), validRows[0].saleDate) : null;
  const periodEnd =
    validRows.length > 0 ? validRows.reduce((a, b) => (b.saleDate > a ? b.saleDate : a), validRows[0].saleDate) : null;

  const dateGaps = useMemo(() => {
    if (!periodStart || !periodEnd) return [];
    const present = new Set(validRows.map((r) => r.saleDate));
    return findDateGaps(present, periodStart, periodEnd);
  }, [validRows, periodStart, periodEnd]);

  const canSave =
    blockingIssues.length === 0 && validRows.length > 0 && (dateGaps.length === 0 || gapsAcknowledged);

  function updateOverride(rowNo: number, patch: Partial<RowOverride>) {
    setRowOverrides((prev) => ({ ...prev, [rowNo]: { ...prev[rowNo], ...patch } }));
    setGapsAcknowledged(false);
  }

  const submit = useMutation({
    mutationFn: async () => {
      if (!fileBuffer || !periodStart || !periodEnd) throw new Error("업로드할 유효한 행이 없습니다.");
      if (blockingIssues.length > 0) throw new Error("해석되지 않은 거래 행이 남아 있습니다.");
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
        CatPOS 톡파일 판매내역과 같은 열 구조(no·판매일자·판매상품·거래구분 등)면 자동으로
        인식해 바로 품목을 연결합니다. 그 구조가 아니면 열을 직접 지정하는 범용 CSV/XLSX
        가져오기로 진행합니다. 두 경우 모두 반품·취소가 실제로 어떻게 표시되는지는 사례로
        확인하지 못했습니다(docs/미확인_항목.md D-02) — 지금은 입력된 수량을 그대로
        순판매수량으로 반영합니다.
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
          <button type="button" disabled={!dateCol || !itemCol || !qtyCol} onClick={() => setStep("match")}>
            다음: 품목 연결
          </button>
        </div>
      )}

      {step === "match" && (
        <div>
          {mode === "catpos" && (
            <p className="form-message">
              CatPOS 톡파일 판매내역 구조로 인식해 열 매핑 없이 바로 품목을 연결합니다. 반품·취소
              표현 방식은 아직 실제 사례로 확인하지 못했습니다(docs/미확인_항목.md D-02).
            </p>
          )}
          {mode === "catpos" && catposErrors.length > 0 && (
            <div>
              <p className="form-message error-text">
                {catposErrors.length}개 행의 형식을 해석할 수 없어 조용히 빠뜨리지 않고 목록으로
                남겼습니다. 파일이 예상과 다른 구조라는 뜻일 수 있습니다. 아래 내용을 확인한 뒤
                진행하세요.
              </p>
              <table className="dense-table">
                <thead>
                  <tr>
                    <th>파일 내 위치</th>
                    <th>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {catposErrors.slice(0, 20).map((e, i) => (
                    <tr key={i}>
                      <td>{e.rowIndex + 2}행째</td>
                      <td>{e.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {catposErrors.length > 20 && <p>...외 {catposErrors.length - 20}건</p>}
              <label style={{ flexDirection: "row", alignItems: "center", gap: "6px" }}>
                <input
                  type="checkbox"
                  checked={catposErrorsAcknowledged}
                  onChange={(e) => setCatposErrorsAcknowledged(e.target.checked)}
                />
                위 행들은 이번 업로드에 반영되지 않는다는 것을 확인했습니다.
              </label>
            </div>
          )}
          <p>
            서로 다른 품목명 {distinctItems.length}개 중 미연결 {unresolvedCount}개
            {matchLoading && " · 검색 중..."}
          </p>
          <table className="dense-table">
            <thead>
              <tr>
                <th>파일 상 품목명</th>
                <th>연결할 품목</th>
              </tr>
            </thead>
            <tbody>
              {distinctItems.map((item) => {
                const info = matchInfo[item];
                const matchedId = itemMatches[item];
                const matchedProduct =
                  matchedId && matchedId !== "skip"
                    ? info?.candidates.find((c) => c.product_id === matchedId)
                    : null;
                const isPickerOpen = pickerOpenFor === item;

                return (
                  <tr key={item}>
                    <td>{item}</td>
                    <td>
                      {matchedId === "skip" && (
                        <span>
                          건너뛰기(거래 행 아님)
                          <button type="button" onClick={() => setPickerOpenFor(item)}>
                            변경
                          </button>
                        </span>
                      )}
                      {matchedProduct && !isPickerOpen && (
                        <span>
                          {matchedProduct.name} {matchedProduct.spec} ({matchedProduct.base_unit})
                          <button type="button" onClick={() => setPickerOpenFor(item)}>
                            변경
                          </button>
                        </span>
                      )}
                      {!matchedId && !isPickerOpen && info && info.candidates.length > 0 && (
                        <div>
                          <p className="form-message">
                            이름이 같은 상품이 여러 규격으로 등록되어 있어 자동으로 고르지
                            않았습니다. 맞는 규격을 선택하세요.
                          </p>
                          <ul className="search-results">
                            {info.candidates.map((c) => (
                              <li key={c.product_id}>
                                <button type="button" onClick={() => chooseMatch(item, c.product_id)}>
                                  {c.name} {c.spec} ({c.base_unit})
                                </button>
                              </li>
                            ))}
                          </ul>
                          <button type="button" onClick={() => setPickerOpenFor(item)}>
                            다른 상품 검색
                          </button>
                          <button
                            type="button"
                            onClick={() => setItemMatches((prev) => ({ ...prev, [item]: "skip" }))}
                          >
                            건너뛰기(거래 행 아님)
                          </button>
                        </div>
                      )}
                      {!matchedId && !isPickerOpen && info && info.candidates.length === 0 && (
                        <div>
                          <p className="form-message">검색 결과가 없습니다.</p>
                          <button type="button" onClick={() => setPickerOpenFor(item)}>
                            상품 검색·등록
                          </button>
                          <button
                            type="button"
                            onClick={() => setItemMatches((prev) => ({ ...prev, [item]: "skip" }))}
                          >
                            건너뛰기(거래 행 아님)
                          </button>
                        </div>
                      )}
                      {isPickerOpen && (
                        <div style={{ border: "1px solid var(--border)", borderRadius: "6px", padding: "8px" }}>
                          <label style={{ flexDirection: "row", alignItems: "center", gap: "6px" }}>
                            <input
                              type="checkbox"
                              checked={saveAliasFor[item] !== false}
                              onChange={(e) =>
                                setSaveAliasFor((prev) => ({ ...prev, [item]: e.target.checked }))
                              }
                            />
                            이 연결을 다음 업로드에도 자동 인식되도록 저장
                          </label>
                          <ProductSearchBox
                            defaultObservedFrom={periodStart}
                            onSelect={(p: ProductSearchResult) => chooseMatch(item, p.product_id)}
                          />
                          <button type="button" onClick={() => setPickerOpenFor(null)}>
                            닫기
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            disabled={
              unresolvedCount > 0 ||
              matchLoading ||
              (mode === "catpos" && catposErrors.length > 0 && !catposErrorsAcknowledged)
            }
            onClick={() => setStep("preview")}
          >
            다음: 미리보기
          </button>
        </div>
      )}

      {step === "preview" && (
        <div>
          <p>
            반영 예정 {validRows.length}행 · 빈 행(무시됨) {blankRowCount}건 · 건너뛰기로 확인한
            품목의 행 {skippedByItemChoice}건 · 직접 제외한 행 {excludedByUser}건
          </p>

          {blockingIssues.length > 0 && (
            <div>
              <p className="form-message error-text">
                아래 {blockingIssues.length}개 행은 품목은 확인됐지만 날짜 또는 수량을 해석할 수
                없어 조용히 빠뜨릴 수 없습니다. 값을 고치거나, 거래 행이 아니라면 제외로
                표시하세요. 해결되기 전에는 저장할 수 없습니다.
              </p>
              <table className="dense-table">
                <thead>
                  <tr>
                    <th>행</th>
                    <th>품목(파일)</th>
                    <th>날짜 입력</th>
                    <th>수량 입력</th>
                    <th>제외</th>
                  </tr>
                </thead>
                <tbody>
                  {blockingIssues.map((r) => {
                    const ov = rowOverrides[r.rowNo] ?? {};
                    const dateText = ov.dateText ?? r.rawDateText;
                    const qtyText = ov.qtyText ?? r.rawQtyText;
                    const dateOk = parseFlexibleDate(dateText) !== null;
                    const qtyOk = parseFlexibleQuantity(qtyText) !== null;
                    return (
                      <tr key={r.rowNo}>
                        <td>{r.rowNo}</td>
                        <td>{r.rawItem || "(품목명 없음)"}</td>
                        <td>
                          <input
                            value={dateText}
                            onChange={(e) => updateOverride(r.rowNo, { dateText: e.target.value })}
                            style={{ borderColor: dateOk ? undefined : "var(--danger)" }}
                          />
                          {!dateOk && <div className="warning-badge">해석 불가</div>}
                        </td>
                        <td>
                          <input
                            value={qtyText}
                            onChange={(e) => updateOverride(r.rowNo, { qtyText: e.target.value })}
                            style={{ borderColor: qtyOk ? undefined : "var(--danger)" }}
                          />
                          {!qtyOk && <div className="warning-badge">해석 불가</div>}
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            checked={Boolean(ov.excluded)}
                            onChange={(e) => updateOverride(r.rowNo, { excluded: e.target.checked })}
                            title="이 행은 거래 행이 아님을 확인함"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {blockingIssues.length === 0 && periodStart && periodEnd && (
            <>
              <p>
                자료 기간: {periodStart} ~ {periodEnd}
              </p>
              {dateGaps.length > 0 && (
                <div>
                  <p className="form-message error-text">
                    이 기간 안에 자료가 전혀 없는 날짜가 {dateGaps.length}개 있습니다: {" "}
                    {dateGaps.join(", ")}. 실제로 판매가 없었던 날인지, 파일에서 빠진 날인지 확인
                    되지 않으면 이 날짜들도 "판매자료 확보 완료"로 잘못 기록될 수 있습니다.
                  </p>
                  <label style={{ flexDirection: "row", alignItems: "center", gap: "6px" }}>
                    <input
                      type="checkbox"
                      checked={gapsAcknowledged}
                      onChange={(e) => setGapsAcknowledged(e.target.checked)}
                    />
                    위 날짜들은 실제로 판매가 없었음을 확인했습니다(파일 누락이 아닙니다).
                  </label>
                </div>
              )}
              <p className="form-message">
                같은 기간의 기존 판매 집계는 이 파일 내용으로 통째로 교체됩니다 (전체기간 보고서
                처리 방식, FR-07).
              </p>
            </>
          )}

          <button type="button" onClick={() => setStep(mode === "catpos" ? "match" : "map")}>
            뒤로
          </button>
          <button type="button" disabled={submit.isPending || !canSave} onClick={() => submit.mutate()}>
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
              setCatposLineItems([]);
              setCatposErrors([]);
              setCatposErrorsAcknowledged(false);
              setResult(null);
              setRowOverrides({});
              setGapsAcknowledged(false);
              setMatchInfo({});
              setItemMatches({});
              setSaveAliasFor({});
              setPickerOpenFor(null);
            }}
          >
            새 파일 업로드
          </button>
        </div>
      )}
    </div>
  );
}
