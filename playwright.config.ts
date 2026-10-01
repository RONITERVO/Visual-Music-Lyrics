import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser", timeout: 60_000, workers: 1,
  use: { baseURL: "http://127.0.0.1:4552", browserName: "chromium", channel: "msedge", headless: true },
  webServer: { command: "npm run dev:local", url: "http://127.0.0.1:4552", reuseExistingServer: true, env: { PORT: "4552" } },
});
