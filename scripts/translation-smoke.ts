/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import "dotenv/config";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parseTranscript } from "../src/lib/parser";

const PORT = Number(process.env.TRANSLATION_SMOKE_PORT || 3197);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SERVER_START_TIMEOUT_MS = 45_000;
const GEMINI_MODEL = "gemini-flash-lite-latest";

const u = (value) => value;

const GEMINI_CASES = [
  {
    id: "app-live-fi-to-en",
    sourceLanguage: "fi",
    targetLanguage: "en",
    lines: [
      u("T\u00e4m\u00e4 ilta on hiljainen, mutta syd\u00e4n ei nuku."),
      u("Pid\u00e4n valot p\u00e4\u00e4ll\u00e4, kunnes l\u00f6yd\u00e4mme kotiin."),
      u("\u00c4l\u00e4 p\u00e4\u00e4st\u00e4 irti, vaikka meri nousee."),
    ],
    qualityChecks: [
      { index: 0, all: [/heart/i, /sleep/i] },
      { index: 1, all: [/lights?/i, /home/i] },
      { index: 2, all: [/(let go|release)/i, /sea/i] },
    ],
  },
  {
    id: "app-live-en-to-fi",
    sourceLanguage: "en",
    targetLanguage: "fi",
    lines: [
      "The room goes quiet when the chorus starts.",
      "I keep the small light on beside the door.",
      "We will find the road back through the rain.",
    ],
    qualityChecks: [
      { index: 0, includes: [u("kertos\u00e4e")] },
      { index: 1, includes: ["ove"] },
      { index: 2, includes: ["sate"] },
    ],
  },
  {
    id: "app-mixed-common-to-en",
    sourceLanguage: "",
    targetLanguage: "en",
    lines: [
      "La ciudad respira debajo de la lluvia.",
      "La lumiere tremble au fond de la fenetre.",
      "Die Strasse wird still, doch mein Herz bleibt wach.",
      "La notte si apre sopra i tetti bagnati.",
      "A rua acende quando voce sorri.",
      u("\u96e8\u306e\u97f3\u304c\u7a93\u8fba\u3067\u8e0a\u308b\u3002"),
      u("\ube44\uac00 \uc624\uba74 \uac70\ub9ac\ub294 \uc870\uc6a9\ud574\uc838."),
      u("\u092c\u093e\u0930\u093f\u0936 \u092e\u0947\u0902 \u0936\u0939\u0930 \u0927\u0940\u0930\u0947 \u0938\u0947 \u0917\u093e\u0924\u093e \u0939\u0948\u0964"),
      u("\u96e8\u843d\u4e0b\u65f6\uff0c\u8857\u706f\u6162\u6162\u9192\u6765\u3002"),
    ],
    qualityChecks: [
      { index: 0, all: [/city/i, /rain/i] },
      { index: 1, all: [/light/i, /window/i] },
      { index: 2, all: [/(street|road)/i, /heart/i] },
      { index: 3, all: [/night/i, /roof/i] },
      { index: 4, all: [/(street|road)/i, /smile/i] },
      { index: 5, all: [/rain/i, /window/i] },
      { index: 6, all: [/rain/i, /(street|road)/i] },
      { index: 7, all: [/city/i, /(sing|song)/i] },
      { index: 8, all: [/(streetlight|street lamp|lamp)/i, /(wake|awake)/i] },
    ],
  },
  {
    id: "app-section-en-to-es",
    sourceLanguage: "en",
    targetLanguage: "es",
    lines: [
      "Every echo turns into a doorway.",
      "I follow the beat until morning arrives.",
    ],
    qualityChecks: [
      { index: 0, includes: ["puerta"] },
      { index: 1, includes: [u("ma\u00f1ana")] },
    ],
  },
];

function makeSegments(lines) {
  return lines.map((primary, index) => {
    const start = Number((index * 3.4).toFixed(3));
    const end = Number((start + 3.1).toFixed(3));
    const words = primary.split(/\s+/).filter(Boolean);
    return {
      id: `seg-${index}`,
      start,
      end,
      primary,
      translation: "",
      secondary: "",
      raw: primary,
      speaker: "",
      section: "",
      role: "lyric",
      kind: "lyric",
      words: words.map((text, wordIndex) => ({
        text,
        start: Number((start + wordIndex * 0.32).toFixed(3)),
        end: Number((start + wordIndex * 0.32 + 0.26).toFixed(3)),
      })),
      characterTimeline: [],
      order: index,
      source: "elevenlabs-scribe-v2-realtime",
      language_code: "",
    };
  });
}

async function fetchJson(url: string, options: any = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
    try {
      await fetchJson(`${BASE_URL}/api/health`, { timeoutMs: 2_000 });
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error(`Server did not start at ${BASE_URL}`);
}

function startServer() {
  const hasProductionBuild = existsSync("dist/index.html") && existsSync("dist/server.cjs");
  const serverArgs = hasProductionBuild ? ["dist/server.cjs"] : ["node_modules/tsx/dist/cli.mjs", "server.ts"];
  const child = spawn(process.execPath, serverArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DISABLE_HMR: "true",
      NODE_ENV: hasProductionBuild ? "production" : (process.env.NODE_ENV || "development"),
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

function isTransientProviderError(error) {
  const message = String(error?.message || error || "");
  return /quota|rate limit|high demand|try again later|temporarily|unavailable|503|429/i.test(message);
}

function assertGeminiMetadata(testCase, data) {
  if (!data.translationSource) {
    throw new Error(`gemini ${testCase.id}: missing translationSource`);
  }
  if (data.translationSource !== GEMINI_MODEL || data.translationModel !== GEMINI_MODEL) {
    throw new Error(`gemini ${testCase.id}: expected ${GEMINI_MODEL} metadata`);
  }
}

function assertValidTranslation(testCase, requestSegments, data) {
  if (!Array.isArray(data?.segments)) {
    throw new Error(`gemini ${testCase.id}: response did not include segments`);
  }
  if (data.segments.length !== requestSegments.length) {
    throw new Error(`gemini ${testCase.id}: segment count changed`);
  }
  assertGeminiMetadata(testCase, data);

  const exactCopies = [];
  data.segments.forEach((segment, index) => {
    const before = requestSegments[index];
    const translation = String(segment?.translation || "").trim();
    if (!translation) {
      throw new Error(`gemini ${testCase.id}: missing translation for segment ${index}`);
    }
    if (segment.primary !== before.primary || segment.start !== before.start || segment.end !== before.end) {
      throw new Error(`gemini ${testCase.id}: source timing/text mutated at segment ${index}`);
    }
    if (JSON.stringify(segment.words) !== JSON.stringify(before.words)) {
      throw new Error(`gemini ${testCase.id}: word timing mutated at segment ${index}`);
    }
    if (/[{}<>]|\btranslation\b\s*:/i.test(translation)) {
      throw new Error(`gemini ${testCase.id}: translation contains markup or JSON at segment ${index}`);
    }
    if (translation.toLowerCase() === String(before.primary).trim().toLowerCase()) {
      exactCopies.push(index);
    }
  });

  if (testCase.sourceLanguage !== testCase.targetLanguage && exactCopies.length === data.segments.length) {
    throw new Error(`gemini ${testCase.id}: all translations copied the source text`);
  }
}

function assertGeminiQuality(testCase, data) {
  for (const check of testCase.qualityChecks || []) {
    const translation = String(data.segments[check.index]?.translation || "").toLowerCase();
    for (const text of check.includes || []) {
      if (!translation.includes(String(text).toLowerCase())) {
        throw new Error(`gemini ${testCase.id}: segment ${check.index} missed expected term ${text}`);
      }
    }
    for (const pattern of check.all || []) {
      if (!pattern.test(translation)) {
        throw new Error(`gemini ${testCase.id}: segment ${check.index} failed quality pattern ${pattern}`);
      }
    }
  }
}

function assertSavedTimingRoundTrip(testCase, requestSegments, data) {
  const timingText = JSON.stringify({
    source: "elevenlabs-scribe-v2-realtime",
    transcriptionSource: "elevenlabs-scribe-v2-realtime",
    translationSource: data.translationSource,
    commitStrategy: "manual",
    manualCommitMarks: [15, 30],
    sourceLanguage: testCase.sourceLanguage || "auto",
    targetLanguage: testCase.targetLanguage,
    generatedAt: "2026-05-31T00:00:00.000Z",
    segments: data.segments,
  }, null, 2);

  const parsed = JSON.parse(timingText);
  if (parsed.translationSource !== data.translationSource || parsed.targetLanguage !== testCase.targetLanguage) {
    throw new Error(`gemini ${testCase.id}: saved timing metadata did not round-trip`);
  }
  if (!Array.isArray(parsed.segments) || parsed.segments.length !== requestSegments.length) {
    throw new Error(`gemini ${testCase.id}: saved timing segment count did not round-trip`);
  }

  parsed.segments.forEach((segment, index) => {
    const before = requestSegments[index];
    const reloadedTranslationSource = segment.translationSource || parsed.translationSource;
    if (reloadedTranslationSource !== data.translationSource) {
      throw new Error(`gemini ${testCase.id}: parser-style translationSource fallback failed`);
    }
    if (segment.primary !== before.primary || segment.raw !== before.raw) {
      throw new Error(`gemini ${testCase.id}: saved timing source text changed at segment ${index}`);
    }
    if (!String(segment.translation || "").trim()) {
      throw new Error(`gemini ${testCase.id}: saved timing missing translation at segment ${index}`);
    }
    if (JSON.stringify(segment.words) !== JSON.stringify(before.words)) {
      throw new Error(`gemini ${testCase.id}: saved timing word timings changed at segment ${index}`);
    }
  });

  const parsedByApp = parseTranscript(timingText, "json");
  if (parsedByApp.kind !== "timed" || parsedByApp.segments.length !== requestSegments.length) {
    throw new Error(`gemini ${testCase.id}: app parser did not reload saved timing segments`);
  }
  parsedByApp.segments.forEach((segment, index) => {
    const before = requestSegments[index];
    if (segment.primary !== before.primary || segment.raw !== before.raw) {
      throw new Error(`gemini ${testCase.id}: app parser changed source text at segment ${index}`);
    }
    if (!String(segment.translation || "").trim()) {
      throw new Error(`gemini ${testCase.id}: app parser dropped translation at segment ${index}`);
    }
    if (segment.translationSource !== data.translationSource) {
      throw new Error(`gemini ${testCase.id}: app parser dropped translationSource at segment ${index}`);
    }
    if (JSON.stringify(segment.words) !== JSON.stringify(before.words)) {
      throw new Error(`gemini ${testCase.id}: app parser changed word timings at segment ${index}`);
    }
  });
}

async function translateCase(testCase) {
  const requestSegments = makeSegments(testCase.lines);
  let data = null;
  let lastError = null;
  const body: any = {
    segments: requestSegments,
    sourceLanguage: testCase.sourceLanguage,
    targetLanguage: testCase.targetLanguage,
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      data = await fetchJson(`${BASE_URL}/api/translate/gemini`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        timeoutMs: 75_000,
        body: JSON.stringify(body),
      });
      break;
    } catch (error) {
      lastError = error;
      if (!isTransientProviderError(error) || attempt === 3) throw error;
      await delay(5000 * attempt);
    }
  }

  if (!data) throw lastError || new Error(`gemini ${testCase.id}: no response`);
  assertValidTranslation(testCase, requestSegments, data);
  assertGeminiQuality(testCase, data);
  assertSavedTimingRoundTrip(testCase, requestSegments, data);
  return data;
}

async function runGeminiSmoke() {
  console.log("\nGemini Flash Lite");

  for (const testCase of GEMINI_CASES) {
    const data = await translateCase(testCase);
    const preview = data.segments.map((segment) => segment.translation).join(" | ");
    console.log(`ok ${testCase.id}: ${preview}`);
    await delay(1200);
  }
}

async function main() {
  if (!process.env.GEMINI_API_KEYS) {
    throw new Error("GEMINI_API_KEYS is required for this smoke test.");
  }

  const server = startServer();
  try {
    await waitForServer();
    await runGeminiSmoke();
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
