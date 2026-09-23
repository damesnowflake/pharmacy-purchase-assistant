import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabaseClient";

export interface ProductSearchResult {
  product_id: string;
  name: string;
  spec: string;
  base_unit: string;
  default_moq: number | null;
  default_order_step: number | null;
}

/**
 * 상품명·규격·별칭·POS 코드·바코드로 검색하는 공유 훅. search_products RPC(공백 정규화 포함)를
 * 그대로 감싸, 상품 관리 화면과 입고 화면이 같은 검색 결과·동작을 쓰게 한다.
 */
export function useProductSearch(query: string, limit = 20) {
  return useQuery({
    queryKey: ["products", "search", query, limit],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("search_products", { p_query: query, p_limit: limit });
      if (error) throw error;
      return data as ProductSearchResult[];
    },
  });
}
