// Never infer quantity from the last number: it is usually a price or total.
export interface OcrWord {
  text: string;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  confidence?: number;
}
export interface OcrLine { text: string; words: OcrWord[] }
export interface OcrRowCandidate {
  rawText: string;
  itemCandidate: string;
  qtyCandidate: number | null;
  quantitySource: "column" | "label" | "unresolved";
}
const normalized = (s: string) => s.replace(/\s|[:：]/g, "");
const headers = new Set(["품명", "품목", "상품명", "품명및규격", "품명규격", "규격", "수량", "단가", "공급가액", "공급금액", "금액", "부가세", "총금액", "합계", "품목코드", "덧수량"]);
function headerWords(words: OcrWord[]): OcrWord[] {
  const result: OcrWord[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!words[i].bbox) continue;
    let best: OcrWord | undefined;
    let end = i;
    for (let j = i; j < Math.min(words.length, i + 6); j++) {
      const box = words[j].bbox;
      if (!box) break;
      if (j > i && box.x0 - words[j - 1].bbox!.x1 > (box.y1 - box.y0) * 2) break;
      const text = normalized(words.slice(i, j + 1).map(w => w.text).join(""));
      if (headers.has(text)) {
        best = { text, bbox: { ...words[i].bbox!, x1: box.x1 } };
        end = j;
      }
    }
    if (best) { result.push(best); i = end; }
  }
  return result;
}
function quantity(text: string): number | null {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text.trim())) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Different OCR blocks can contain different columns of the same visual row.
function visualRows(lines: OcrLine[]): OcrLine[] {
  const words = lines.flatMap(l => l.words).filter(w => w.text.trim());
  if (!words.length || words.some(w => !w.bbox)) return lines;
  const groups: OcrWord[][] = [];
  for (const word of words.sort((a, b) => a.bbox!.y0 - b.bbox!.y0)) {
    const b = word.bbox!;
    const cy = (b.y0 + b.y1) / 2;
    const group = groups.find(g => {
      const a = g[0].bbox!;
      return Math.abs(cy - (a.y0 + a.y1) / 2) <= Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5;
    });
    if (group) group.push(word); else groups.push([word]);
  }
  return groups.map(g => {
    g.sort((a, b) => a.bbox!.x0 - b.bbox!.x0);
    return { text: g.map(w => w.text).join(" "), words: g };
  });
}

export function extractRowCandidates(lines: OcrLine[]): OcrRowCandidate[] {
  let columns: { left: number; right: number; itemLeft: number; itemRight: number } | undefined;
  let previousItem = "";
  const result: OcrRowCandidate[] = [];
  for (const line of visualRows(lines)) {
    const text = line.text.trim();
    if (!text) continue;
    const words = line.words.filter(w => w.text.trim());
    const named = headerWords(words);
    const qtyHeader = named.find(w => normalized(w.text) === "수량");
    const itemHeader = named.find(w => ["품명", "품목", "상품명", "품명및규격", "품명규격"].includes(normalized(w.text)));
    if (qtyHeader && itemHeader && named.length >= 3) {
      previousItem = "";
      const center = (w: OcrWord) => (w.bbox!.x0 + w.bbox!.x1) / 2;
      named.sort((a, b) => center(a) - center(b));
      const i = named.indexOf(qtyHeader), j = named.indexOf(itemHeader);
      if (i > 0 && i < named.length - 1) columns = {
        left: (center(named[i - 1]) + center(qtyHeader)) / 2,
        right: (center(named[i + 1]) + center(qtyHeader)) / 2,
        itemLeft: j === 0 ? -Infinity : (center(named[j - 1]) + center(itemHeader)) / 2,
        itemRight: named[j + 1] ? (center(named[j + 1]) + center(itemHeader)) / 2 : center(qtyHeader),
      };
      else columns = undefined;
      continue;
    }
    if (/^(합\s*계|소\s*계|총\s*액|총\s*금\s*액|공급가액|부가세)(?:\s|:|：|$)/.test(text)) continue;
    if (columns && words.every(w => w.bbox)) {
      const inside = (w: OcrWord, left: number, right: number) => {
        const x = (w.bbox!.x0 + w.bbox!.x1) / 2;
        return x >= left && x < right;
      };
      let item = words.filter(w => inside(w, columns!.itemLeft, columns!.itemRight)).map(w => w.text).join(" ");
      const qtyWords = words.filter(w => inside(w, columns!.left, columns!.right));
      const spec = words.filter(w => inside(w, columns!.itemRight, columns!.left)).map(w => w.text).join(" ");
      if (item) previousItem = item;
      else if (spec) item = `${previousItem} ${spec}`.trim();
      // Keep blank-name quantity rows for manual resolution; never silently lose a delivery.
      if (!item && !qtyWords.length) continue;
      const value = qtyWords.length === 1 && (qtyWords[0].confidence ?? 100) >= 60 ? quantity(qtyWords[0].text) : null;
      result.push({ rawText: text, itemCandidate: item, qtyCandidate: value, quantitySource: value === null ? "unresolved" : "column" });
    } else {
      const explicit = text.match(/(?:^|\s)수량\s*[:：]\s*([\d,.]+)(?=\s|$)/);
      const value = explicit ? quantity(explicit[1]) : null;
      result.push({ rawText: text, itemCandidate: explicit ? text.replace(explicit[0], " ").trim() : text,
        qtyCandidate: value, quantitySource: value === null ? "unresolved" : "label" });
    }
  }
  return result;
}
