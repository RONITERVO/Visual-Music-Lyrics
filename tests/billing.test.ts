import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

test("billing pause blocks both purchase routes before auth or Stripe; explicit enable still requires auth", async () => {
  const names = ["ELEVENLABS_PURCHASES_ENABLED", "STRIPE_SECRET_KEY", "APP_URL"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  // No Stripe request is possible in this test: disabled routes stop first, enabled routes require auth.
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_fixture";
  process.env.APP_URL = "http://localhost";
  const { api } = await import("../functions/src/index.ts");
  const server = createServer(api);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const routes = ["/api/billing/elevenlabs/", "/billing/elevenlabs/"]
    .flatMap(prefix => [prefix + "checkout-session", prefix + "payment-intent"]);
  try {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.ELEVENLABS_PURCHASES_ENABLED;
      else process.env.ELEVENLABS_PURCHASES_ENABLED = value;
      const status = await fetch(origin + "/api/billing/elevenlabs/status");
      assert.equal(status.headers.get("cache-control"), "no-store");
      assert.equal((await status.json()).purchasesEnabled, false);
      for (const route of routes) {
        const response = await fetch(origin + route, { method: "POST" });
        assert.equal(response.status, 503, `${value}: ${route}`);
        assert.equal((await response.json()).code, "purchases_paused");
      }
    }
    // Balances remain available behind their original authentication boundary.
    const balance = await fetch(origin + "/api/entitlements/me");
    assert.equal(balance.status, 401);

    process.env.ELEVENLABS_PURCHASES_ENABLED = "true";
    assert.equal((await (await fetch(origin + "/billing/elevenlabs/status")).json()).purchasesEnabled, true);
    for (const route of routes) {
      const response = await fetch(origin + route, { method: "POST" });
      assert.equal(response.status, 401);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
