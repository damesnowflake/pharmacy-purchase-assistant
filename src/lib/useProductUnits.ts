import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";

export interface ProductUnit {
  unit_code: string;
  factor_to_base: number;
}

export function useProductUnits(productId: string | null | undefined) {
  return useQuery({
    queryKey: ["product_units", productId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("product_units")
        .select("unit_code, factor_to_base")
        .eq("product_id", productId as string)
        .order("factor_to_base", { ascending: true });
      if (error) throw error;
      return data as ProductUnit[];
    },
    enabled: Boolean(productId),
  });
}
