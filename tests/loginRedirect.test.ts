import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, navigate } = vi.hoisted(() => ({
  auth: { session: null as null | { user: { id: string } }, loading: false },
  navigate: vi.fn((_props: { to: string; replace?: boolean }) => null),
}));

vi.mock("@/features/auth/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("@/lib/supabaseClient", () => ({ supabase: {} }));
vi.mock("react-router-dom", () => ({ Navigate: navigate }));

import { LoginPage } from "@/features/auth/LoginPage";

describe("login route session transitions", () => {
  beforeEach(() => {
    auth.session = null;
    auth.loading = false;
    navigate.mockClear();
  });

  it("shows the login form without a session", () => {
    expect(renderToStaticMarkup(createElement(LoginPage))).toContain("<form");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("redirects to review when authentication supplies a session", () => {
    renderToStaticMarkup(createElement(LoginPage));
    auth.session = { user: { id: "signed-in-user" } };
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).not.toContain("<form");
    expect(navigate.mock.calls[0]?.[0]).toMatchObject({ to: "/review", replace: true });
  });

  it("waits for session restoration before showing the login form", () => {
    auth.loading = true;
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(html).toContain("불러오는 중");
    expect(html).not.toContain("<form");
    expect(navigate).not.toHaveBeenCalled();

    auth.loading = false;
    auth.session = { user: { id: "restored-user" } };
    renderToStaticMarkup(createElement(LoginPage));
    expect(navigate.mock.calls[0]?.[0]).toMatchObject({ to: "/review", replace: true });
  });
});
