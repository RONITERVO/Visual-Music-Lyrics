/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const PORT = Number(process.env.BACKEND_CONTRACT_PORT || 3198);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const APP_ORIGIN = "https://app.example.test";
const SERVER_START_TIMEOUT_MS = 45_000;
const USE_BUILT_SERVER = process.argv.includes("--built");

function assert(condition: any, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function startServer() {
  if (USE_BUILT_SERVER) {
    assert(existsSync("dist/server.cjs"), "dist/server.cjs is missing; run npm run build first");
  }

  const serverArgs = USE_BUILT_SERVER
    ? ["dist/server.cjs"]
    : ["node_modules/tsx/dist/cli.mjs", "server.ts"];

  const child = spawn(process.execPath, serverArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_URL: APP_ORIGIN,
      DISABLE_HMR: "true",
      BACKEND_ONLY: "true",
      NODE_ENV: USE_BUILT_SERVER ? "production" : "development",
      ELEVENLABS_API_KEY: "",
      GEMINI_API_KEYS: "",
      YOUTUBE_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) process.stdout.write(`[server] ${line}\n`);
  });
  child.stderr.on("data", (chunk) => {
    const line = String(chunk).trim();
    if (line) process.stderr.write(`[server] ${line}\n`);
  });

  return child;
}

async function fetchJson(path: string, options: RequestInit = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data };
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
    try {
      const { response, data } = await fetchJson("/api/health");
      if (response.ok && data?.status === "ok") return;
    } catch {}
    await delay(500);
  }
  throw new Error(`Server did not start at ${BASE_URL}`);
}

async function assertHealthAndCors() {
  const { response, data } = await fetchJson("/api/health", {
    headers: { Origin: APP_ORIGIN },
  });
  assert(response.ok, `health returned ${response.status}`);
  assert(data?.status === "ok", "health response missing ok status");
  assert(response.headers.get("access-control-allow-origin") === APP_ORIGIN, "matching APP_URL origin was not allowed");
  assert(
    String(response.headers.get("access-control-expose-headers") || "").includes("X-YouTube-Resolve-Cache"),
    "YouTube cache header was not CORS-exposed",
  );

  const options = await fetch(`${BASE_URL}/api/translate/gemini`, {
    method: "OPTIONS",
    headers: {
      Origin: APP_ORIGIN,
      "Access-Control-Request-Method": "POST",
    },
    signal: AbortSignal.timeout(10_000),
  });
  assert(options.status === 204, `OPTIONS returned ${options.status}`);
  assert(options.headers.get("access-control-allow-origin") === APP_ORIGIN, "OPTIONS did not allow APP_URL origin");
}

async function assertJsonError(path: string, body: any, expectedStatus: number, expectedMessage: RegExp) {
  const { response, data } = await fetchJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
    body: JSON.stringify(body),
  });
  assert(response.status === expectedStatus, `${path} returned ${response.status}, expected ${expectedStatus}`);
  assert(expectedMessage.test(String(data?.error || "")), `${path} returned unexpected error: ${data?.error}`);
}

async function assertLiveScribeNoKeyCloses() {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/api/elevenlabs/scribe-live`, {
      headers: { Origin: APP_ORIGIN },
    });
    let sawError = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("live Scribe WebSocket did not close after no-key error"));
    }, 10_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "start",
        audioBase64: Buffer.from("not-audio").toString("base64"),
        fileName: "tiny.wav",
      }));
    });

    ws.on("message", (data) => {
      const payload = JSON.parse(String(data));
      if (payload?.type === "error") {
        sawError = /ELEVENLABS_API_KEY|ElevenLabs.*server|media service/i.test(String(payload.error || ""));
      }
    });

    ws.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert(sawError, "live Scribe WebSocket closed without the expected error payload");
        assert(code === 1008, `live Scribe WebSocket closed with ${code}, expected 1008`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const server = startServer();
  try {
    await waitForServer();
    await assertHealthAndCors();
    await assertJsonError("/api/youtube/resolve", { input: "" }, 400, /YouTube video or channel URL/i);
    await assertJsonError("/api/youtube/download", { videoId: "bad" }, 400, /YouTube video URL/i);
    await assertJsonError("/api/youtube/captions", { videoId: "bad" }, 400, /YouTube video URL/i);
    await assertJsonError("/api/translate/gemini", { segments: [{ primary: "hello" }], targetLanguage: "en" }, 400, /GEMINI_API_KEYS|Gemini.*server/i);
    await assertJsonError("/api/translate/gemini", { segments: [{ primary: "hello" }], targetLanguage: "en", apiKey: "browser-key-is-ignored" }, 400, /GEMINI_API_KEYS|Gemini.*server/i);
    await assertLiveScribeNoKeyCloses();
    console.log("backend contract smoke ok");
  } finally {
    if (server.exitCode == null && !server.killed) server.kill();
    await Promise.race([once(server, "close"), delay(5000)]).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
