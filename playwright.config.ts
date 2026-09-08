import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8787", actionTimeout: 10_000, navigationTimeout: 15_000 }
});
