import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { extractRowCandidates, type OcrRowCandidate } from "@/lib/ocrRowExtraction";
import { normalizeAliasText } from "@/lib/salesFileParsing";

// FR-11~12, IR-08, NFR-08: 기기 내 OCR로 품목·수량 후보를 뽑고, 직원이 수정·확정한 값만
// 서버로 보낸다. 사진 원본과 OCR 전체 원문은 이 컴포넌트 밖으로 나가지 않으며, 저장 성공 여부와
// 무관하게 결과를 확정한 뒤에는 이미지·워커를 즉시 해제한다.
// 실제 입고장 사진 표본과 iPhone 실기기 확인이 없어(D-04, docs/미확인_항목.md), 줄 끝 숫자를
// 수량으로 보는 v1 규칙의 인식 정확도는 검증되지 않았다 — 그래서 모든 후보를 직원이 반드시
// 확인·수정한 뒤에만 저장되도록 만들었다.

interface ProductOption {
  id: string;
  name: string;
  spec: string;
  base_unit: string;
}

interface ResolvedCandidate extends OcrRowCandidate {
  key: string;
  productId: string | "skip" | "";
  qtyText: string;
}

export function OcrCapture({
  onResolved,
}: {
  onResolved: (line: { productId: string; label: string; quantity: string; unit: string }) => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "recognizing" | "review">("idle");
  const [progress, setProgress] = useState(0);
  const [candidates, setCandidates] = useState<ResolvedCandidate[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [aliasIndex, setAliasIndex] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  useEffect(() => {
    imageUrlRef.current = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    // 이 화면을 벗어나면 미리보기 이미지 메모리를 해제한다.
    return () => {
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    };
  }, []);

  async function loadProductIndex() {
    const { data, error } = await supabase
      .from("products")
      .select("id, name, spec, base_unit, product_aliases(normalized_alias)")
      .eq("active", true);
    if (error) {
      setError(`품목 목록 조회 실패: ${error.message}`);
      return;
    }
    setProductOptions((data ?? []).map((p) => ({ id: p.id, name: p.name, spec: p.spec, base_unit: p.base_unit })));
    const idx = new Map<string, string>();
    for (const p of data ?? []) {
      idx.set(normalizeAliasText(p.name as string), p.id as string);
      for (const a of (p.product_aliases ?? []) as { normalized_alias: string }[]) {
        idx.set(a.normalized_alias, p.id as string);
      }
    }
    setAliasIndex(idx);
  }

  async function handleFile(file: File) {
    setError(null);
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setStatus("recognizing");
    setProgress(0);
    await loadProductIndex();

    // Tesseract.js는 번들 크기가 커서(WASM 코어 포함) 실제로 촬영을 시작할 때만 불러온다.
    const { createWorker } = await import("tesseract.js");
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      worker = await createWorker("kor+eng", 1, {
        logger: (m) => {
          if (m.status === "recognizing text") setProgress(m.progress);
        },
      });
      const { data } = await worker.recognize(file, {}, { blocks: true });
      const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
      const rowCandidates = extractRowCandidates(lines);

      const resolved: ResolvedCandidate[] = rowCandidates.map((c, i) => {
        const guess = aliasIndex.get(normalizeAliasText(c.itemCandidate));
        return {
          ...c,
          key: `${i}-${c.rawText}`,
          productId: guess ?? "",
          qtyText: c.qtyCandidate !== null ? String(c.qtyCandidate) : "",
        };
      });
      setCandidates(resolved);
      setStatus("review");
    } catch (e) {
      setError(`인식 실패: ${(e as Error).message}. 수동 입력을 이용하세요.`);
      setStatus("idle");
    } finally {
      // 인식 후 사진 원본은 더 이상 필요하지 않다. Worker도 즉시 종료해 메모리를 비운다.
      if (worker) await worker.terminate();
    }
  }

  function updateCandidate(key: string, patch: Partial<ResolvedCandidate>) {
    setCandidates((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function confirmAll() {
    for (const c of candidates) {
      if (!c.productId || c.productId === "skip") continue;
      const qty = Number(c.qtyText);
      if (!qty || qty <= 0) continue;
      const product = productOptions.find((p) => p.id === c.productId);
      if (!product) continue;
      onResolved({
        productId: product.id,
        label: `${product.name} ${product.spec}`.trim(),
        quantity: String(qty),
        unit: product.base_unit,
      });
    }
    reset();
  }

  function reset() {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageUrl(null);
    setCandidates([]);
    setStatus("idle");
    setProgress(0);
  }

  const readyCount = candidates.filter((c) => c.productId && c.productId !== "skip" && Number(c.qtyText) > 0).length;

  return (
    <div className="ocr-capture">
      {status === "idle" && (
        <label>
          촬영 또는 사진 선택
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </label>
      )}
      {error && <p className="form-message error-text">{error}</p>}

      {status === "recognizing" && (
        <p className="form-message">기기 내 인식 중... {Math.round(progress * 100)}%</p>
      )}

      {status === "review" && (
        <div>
          <p className="form-message">
            인식된 줄 {candidates.length}개 중 확정 가능 {readyCount}개. 품목과 수량을 확인·수정한
            뒤 저장 목록에 담으세요. 사진과 인식 원문은 서버로 전송되지 않습니다.
          </p>
          <table className="dense-table">
            <thead>
              <tr>
                <th>인식된 줄</th>
                <th>품목 연결</th>
                <th className="num">수량</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={c.key}>
                  <td>{c.rawText}</td>
                  <td>
                    <select
                      value={c.productId}
                      onChange={(e) => updateCandidate(c.key, { productId: e.target.value })}
                    >
                      <option value="">선택 필요</option>
                      <option value="skip">건너뛰기</option>
                      {productOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} {p.spec}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={c.qtyText}
                      onChange={(e) => updateCandidate(c.key, { qtyText: e.target.value })}
                      style={{ width: "70px" }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: "6px" }}>
            <button type="button" disabled={readyCount === 0} onClick={confirmAll}>
              확정한 {readyCount}건 목록에 담기
            </button>
            <button type="button" onClick={reset}>
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
