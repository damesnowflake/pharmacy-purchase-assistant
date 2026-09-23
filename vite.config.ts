/// <reference types="vitest" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 배포 대상은 개발계획.md 기준 Cloudflare Pages다. 하위 경로 없이 루트로 배포하므로 base는 "/".
// GitHub Pages 하위 경로로 배포 대상이 바뀌면 base를 "/pharmacy-purchase-assistant/"로 변경한다.
export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
