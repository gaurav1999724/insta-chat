import path from "node:path";
import { defineConfig } from "vitest/config";

// No Next.js/SWC involved here on purpose — Vitest transforms TS/TSX with
// esbuild directly. tsconfig.json's `jsx: "preserve"` is for Next's own
// compiler, so it's overridden below; without this, esbuild would emit raw
// JSX and every component test would fail to even parse.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/integration/**/*.test.ts",
    ],
    exclude: ["tests/e2e/**"],
    // Dummy but schema-valid values so importing `@/lib/validation/env`
    // (required transitively by half this codebase) never throws in tests
    // — never real secrets, per spec §66 "never use real credentials in
    // automated tests." Individual tests override/mock further as needed
    // Tests use dummy values and never real credentials.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      NEXTAUTH_SECRET: "test-secret-not-real-0123456789",
      NEXTAUTH_URL: "http://localhost:3000",
      SOCIALAPI_TOKEN: "test-socialapi-token",
      SOCIALAPI_WEBHOOK_SECRET: "test-webhook-secret",
    },
  },
});
