import { test, expect } from "@playwright/test";

for (const availability of ["paused", "unavailable", "enabled"] as const) {
  test(`Scribe purchases are ${availability} without losing the existing balance`, async ({ page }) => {
    let checkouts = 0;
    await page.route("**/api/entitlements/me", route => route.fulfill({ json: {
      uid: "fixture", elevenLabsPaidSeconds: 3600, elevenLabsUsedSeconds: 0,
      elevenLabsReservedSeconds: 0, elevenLabsRemainingSeconds: 3600,
    } }));
    await page.route("**/api/billing/elevenlabs/status", async route => {
      if (availability === "unavailable") return route.fulfill({ status: 503, body: "Offline" });
      return route.fulfill({ json: {
        purchasesEnabled: availability === "enabled",
        message: availability === "paused" ? "Scribe purchases are temporarily paused. Your existing balance is kept." : "",
      } });
    });
    await page.route("**/api/billing/elevenlabs/checkout-session", route => {
      checkouts++;
      // Simulate a pause taking effect after the UI fetched availability.
      return route.fulfill({ status: 503, json: { error: "Scribe purchases are temporarily paused.", code: "purchases_paused" } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Open library and playback controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const buy = page.getByRole("button", { name: "Buy 1h" });
    await expect(page.getByText("1h 0m", { exact: true })).toBeVisible();
    if (availability === "enabled") {
      await expect(buy).toBeEnabled();
      await buy.click();
      await expect(page.getByText("Scribe purchases are temporarily paused.", { exact: true })).toBeVisible();
      expect(checkouts).toBe(1);
      await expect(page).toHaveURL("/");
    } else {
      await expect(buy).toBeDisabled();
      await expect(page.getByText(availability === "paused"
        ? "Scribe purchases are temporarily paused. Your existing balance is kept."
        : "Purchases are unavailable right now. Please try again later.", { exact: true })).toBeVisible();
      expect(checkouts).toBe(0);
    }
  });
}
