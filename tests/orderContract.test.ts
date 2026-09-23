import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), invalidate: vi.fn(),
  mutations: [] as Array<{
    mutationFn: (input: unknown) => Promise<void>;
    onError: (error: Error) => void;
  }>,
}));
vi.mock("@/lib/supabaseClient", () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock("@/features/auth/AuthContext", () => ({ useAuth: () => ({ profile: { role: "admin" } }) }));
vi.mock("@/lib/useIdempotentRequest", () => ({ useIdempotentRequest: () => ({
  getRequestId: () => "stable-request-id", clearPending: vi.fn(),
}) }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: (options: { queryKey: string[] }) => ({
    data: options.queryKey[0] === "recommendations" ? [{
      id: "rec", product_id: "product", version: 7, recommended_qty: 12,
      basis_json: {}, products: { name: "test product", spec: "", base_unit: "개" },
    }] : undefined,
    isLoading: false, error: null,
  }),
  useMutation: (options: typeof mocks.mutations[number]) => {
    mocks.mutations.push(options);
    return { mutate: vi.fn(), isPending: false };
  },
}));
import { ReviewPage } from "@/features/review/ReviewPage";

describe("order confirmation RPC contract", () => {
  beforeEach(() => {
    mocks.mutations.length = 0;
    mocks.rpc.mockReset().mockResolvedValue({ error: null });
    mocks.invalidate.mockClear();
    renderToStaticMarkup(createElement(ReviewPage));
  });
  it("sends the displayed recommendation's version", async () => {
    await mocks.mutations[1].mutationFn({
      rec: { id: "rec", product_id: "product", version: 7, recommended_qty: 12 },
      supplierId: "supplier", unit: "개", orderDate: "2026-09-23",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("confirm_order", expect.objectContaining({
      p_expected_recommendation_version: 7, p_recommendation_id: "rec", p_qty: 12,
    }));
  });
  it("refreshes stale recommendations after a version conflict", () => {
    mocks.mutations[1].onError(new Error("VERSION_CONFLICT"));
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["recommendations"] });
  });
});
