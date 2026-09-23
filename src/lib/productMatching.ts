import { supabase } from "./supabaseClient";
import { normalizeAliasText } from "./salesFileParsing";
import type { ProductSearchResult } from "./useProductSearch";

// 시나리오 5·6: 판매 파일의 서로 다른 품목명마다 search_products로 후보를 조회한다. 예전에는
// 상품 전체를 한 번에 select해 이름만으로 정규화한 Map<string,string>에 넣었는데, 이름이
// 같고 규격이 다른 상품이 있으면 뒤에 온 상품이 앞의 상품을 덮어썼다(시나리오 6의 핵심 버그).
// 이제는 후보를 이름당 배열로 유지해, 후보가 정확히 하나뿐이고 이름이 완전히 일치할 때만
// 자동 연결하고 그 외에는 화면에서 직접 고르게 한다. 또한 상품이 몇천 개여도 응답 제한(기본
// 1,000행) 때문에 누락되는 일이 없다 — 품목마다 검색이라 애초에 전체를 가져오지 않는다.

export interface MatchResult {
  autoMatchedId: string | null; // 후보가 정확히 하나고 이름이 완전히 일치하면 그 상품 ID
  candidates: ProductSearchResult[];
}

async function searchOne(item: string): Promise<ProductSearchResult[]> {
  const { data, error } = await supabase.rpc("search_products", { p_query: item, p_limit: 8 });
  if (error) throw error;
  return (data ?? []) as ProductSearchResult[];
}

/** 동시 요청 수를 제한하며 배열을 처리한다. 품목 수가 많아도(수천 개) 브라우저·서버에 무리를 주지 않는다. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function matchSalesItems(
  distinctItems: string[],
  concurrency = 8,
): Promise<Map<string, MatchResult>> {
  const resultsArr = await mapWithConcurrency(distinctItems, concurrency, async (item) => {
    const candidates = await searchOne(item);
    const normalizedItem = normalizeAliasText(item);
    const exactNameMatches = candidates.filter((c) => normalizeAliasText(c.name) === normalizedItem);
    const autoMatchedId = exactNameMatches.length === 1 ? exactNameMatches[0].product_id : null;
    return { item, autoMatchedId, candidates };
  });

  const map = new Map<string, MatchResult>();
  for (const r of resultsArr) {
    map.set(r.item, { autoMatchedId: r.autoMatchedId, candidates: r.candidates });
  }
  return map;
}
