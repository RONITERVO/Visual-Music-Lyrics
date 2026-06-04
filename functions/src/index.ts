/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import express from "express";
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { onRequest } from "firebase-functions/v2/https";
import Stripe from "stripe";

if (!getApps().length) initializeApp();

const db = getFirestore();
const REGION = process.env.FUNCTION_REGION || "europe-west1";
const GEMINI_TRANSLATE_MODEL = process.env.GEMINI_TRANSLATE_MODEL || "gemini-flash-lite-latest";
const GEMINI_SERVER_KEYS_ENV = "GEMINI_API_KEYS";
const GEMINI_TRANSLATE_BATCH_CHAR_LIMIT = parseEnvInteger("GEMINI_TRANSLATE_BATCH_CHAR_LIMIT", 48_000, 1000, 120_000);
const GEMINI_TRANSLATE_MAX_BATCH_SEGMENTS = parseEnvInteger("GEMINI_TRANSLATE_MAX_BATCH_SEGMENTS", 240, 1, 1000);
const GEMINI_TRANSLATE_MAX_ATTEMPTS = parseEnvInteger("GEMINI_TRANSLATE_MAX_ATTEMPTS", 3, 1, 10);
const GEMINI_KEY_MAX_CONCURRENCY = parseEnvInteger("GEMINI_KEY_MAX_CONCURRENCY", 1, 1, 20);
const GEMINI_KEY_REQUESTS_PER_MINUTE = parseEnvInteger("GEMINI_KEY_REQUESTS_PER_MINUTE", 12, 0, 1000);
const GEMINI_KEY_REQUESTS_PER_DAY = parseEnvInteger("GEMINI_KEY_REQUESTS_PER_DAY", 0, 0, 100_000);
const GEMINI_USER_REQUESTS_PER_MINUTE = parseEnvInteger("GEMINI_USER_REQUESTS_PER_MINUTE", 6, 0, 1000);
const GEMINI_USER_REQUESTS_PER_DAY = parseEnvInteger("GEMINI_USER_REQUESTS_PER_DAY", 120, 0, 100_000);
const GEMINI_KEY_QUOTA_COOLDOWN_MS = parseEnvInteger("GEMINI_KEY_QUOTA_COOLDOWN_SECONDS", 75, 5, 3600) * 1000;
const GEMINI_KEY_TRANSIENT_COOLDOWN_MS = parseEnvInteger("GEMINI_KEY_TRANSIENT_COOLDOWN_SECONDS", 12, 1, 600) * 1000;
const GEMINI_KEY_AUTH_COOLDOWN_MS = parseEnvInteger("GEMINI_KEY_AUTH_COOLDOWN_SECONDS", 1800, 60, 86_400) * 1000;
const ELEVENLABS_PRICE_CENTS_PER_HOUR = parseEnvInteger("ELEVENLABS_PRICE_CENTS_PER_HOUR", 100, 1, 100_000);
const ELEVENLABS_MIN_PURCHASE_SECONDS = parseEnvInteger("ELEVENLABS_MIN_PURCHASE_SECONDS", 3600, 60, 24 * 3600);
const BILLING_CURRENCY = String(process.env.BILLING_CURRENCY || "eur").toLowerCase();
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APP_URL = process.env.APP_URL || "";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

class PublicError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly options: { retryAfterSeconds?: number; code?: string } = {},
  ) {
    super(message);
  }

  get retryAfterSeconds() {
    return this.options.retryAfterSeconds;
  }

  get code() {
    return this.options.code || "";
  }
}

type AuthenticatedRequest = express.Request & {
  firebaseUser?: DecodedIdToken;
};

function parseEnvInteger(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function getWindowStart(now: number, windowMs: number) {
  return Math.floor(now / windowMs) * windowMs;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactText(value: any) {
  return String(value ?? "")
    .replace(/key=([^&\s]+)/gi, "key=[redacted]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "[redacted-google-key]")
    .replace(/sk_(test|live)_[0-9A-Za-z_-]+/g, "[redacted-stripe-key]");
}

function redactError(error: any) {
  return redactText(error?.message || error || "Unknown error");
}

type ControlLogLevel = "info" | "warn" | "error";

function sanitizeLogValue(value: any): any {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value).slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [key, sanitizeLogValue(item)])
    );
  }
  return redactText(value).slice(0, 1000);
}

function hashLogId(value: any) {
  const text = String(value || "");
  return text ? fingerprintSecret(text).slice(0, 12) : "";
}

function controlLog(event: string, details: Record<string, any> = {}, level: ControlLogLevel = "info") {
  const payload = sanitizeLogValue({
    service: "living-sketchbook-control-plane",
    event,
    ...details,
  });

  if (level === "error") {
    logger.error(event, payload);
  } else if (level === "warn") {
    logger.warn(event, payload);
  } else {
    logger.info(event, payload);
  }
}

function getBearerToken(header: any) {
  const value = Array.isArray(header) ? header[0] : String(header || "");
  return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

async function requireFirebaseUser(req: AuthenticatedRequest) {
  if (req.firebaseUser) return req.firebaseUser;
  const token = getBearerToken(req.headers.authorization);
  if (!token) throw new PublicError("Sign in with Google before using this service.", 401);

  try {
    const user = await getAuth().verifyIdToken(token);
    req.firebaseUser = user;
    await db.collection("users").doc(user.uid).set({
      email: user.email || "",
      name: user.name || "",
      picture: user.picture || "",
      lastSeenAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return user;
  } catch {
    throw new PublicError("Your sign-in session could not be verified.", 401);
  }
}

function parseSecretList(value: any) {
  const text = String(value || "").trim();
  if (!text) return [];

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item || "").trim()).filter(Boolean);
    } catch {}
  }

  return text
    .split(/[\s,;]+/g)
    .map((item) => {
      const token = item.trim().replace(/^["']|["']$/g, "");
      const equalsIndex = token.indexOf("=");
      return equalsIndex > 0 ? token.slice(equalsIndex + 1).trim() : token;
    })
    .filter(Boolean);
}

function fingerprintSecret(value: string) {
  const bytes = new TextEncoder().encode(value);
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function getStableHashInt(value: string) {
  const text = value || "anonymous";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getConfiguredGeminiApiKeys() {
  const keys = parseSecretList(process.env[GEMINI_SERVER_KEYS_ENV]);
  const seen = new Set<string>();

  return keys.filter((key) => {
    const fingerprint = fingerprintSecret(key);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

type GeminiKeyCooldownReason = "" | "auth" | "quota" | "transient";

type GeminiKeyState = {
  apiKey: string;
  inFlight: number;
  requestTimestamps: number[];
  dayWindowStart: number;
  dayRequestCount: number;
  disabledUntil: number;
  disabledReason: GeminiKeyCooldownReason;
};

type GeminiKeyLease = {
  apiKey: string;
  release: (error?: any) => void;
};

class GeminiServerKeyPool {
  private readonly keys: GeminiKeyState[];

  constructor(keys: string[]) {
    const now = Date.now();
    this.keys = keys.map((apiKey) => ({
      apiKey,
      inFlight: 0,
      requestTimestamps: [],
      dayWindowStart: getWindowStart(now, DAY_MS),
      dayRequestCount: 0,
      disabledUntil: 0,
      disabledReason: "",
    }));
  }

  get size() {
    return this.keys.length;
  }

  assertConfigured() {
    if (!this.keys.length) {
      throw new PublicError(`Set ${GEMINI_SERVER_KEYS_ENV} before using Gemini translation.`, 400, {
        code: "gemini_not_configured",
      });
    }
  }

  lease(userIdentity: string): GeminiKeyLease {
    this.assertConfigured();

    const now = Date.now();
    const startIndex = getStableHashInt(userIdentity) % this.keys.length;
    let bestRetryMs = Number.POSITIVE_INFINITY;

    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const key = this.keys[(startIndex + offset) % this.keys.length];
      const retryMs = this.getUnavailableRetryMs(key, now);
      if (retryMs <= 0) return this.createLease(key, now);
      bestRetryMs = Math.min(bestRetryMs, retryMs);
    }

    throw this.makeNoCapacityError(bestRetryMs, now);
  }

  private createLease(key: GeminiKeyState, now: number): GeminiKeyLease {
    key.inFlight += 1;
    key.requestTimestamps.push(now);
    key.dayRequestCount += 1;

    let released = false;
    return {
      apiKey: key.apiKey,
      release: (error?: any) => {
        if (released) return;
        released = true;
        key.inFlight = Math.max(0, key.inFlight - 1);
        this.recordResult(key, error);
      },
    };
  }

  private pruneKey(key: GeminiKeyState, now: number) {
    const minuteCutoff = now - MINUTE_MS;
    while (key.requestTimestamps.length && key.requestTimestamps[0] <= minuteCutoff) key.requestTimestamps.shift();

    const dayWindowStart = getWindowStart(now, DAY_MS);
    if (key.dayWindowStart !== dayWindowStart) {
      key.dayWindowStart = dayWindowStart;
      key.dayRequestCount = 0;
    }

    if (key.disabledUntil <= now && key.disabledReason) {
      key.disabledReason = "";
      key.disabledUntil = 0;
    }
  }

  private getUnavailableRetryMs(key: GeminiKeyState, now: number) {
    this.pruneKey(key, now);

    const waits: number[] = [];
    if (key.disabledUntil > now) waits.push(key.disabledUntil - now);
    if (key.inFlight >= GEMINI_KEY_MAX_CONCURRENCY) waits.push(1000);
    if (GEMINI_KEY_REQUESTS_PER_MINUTE > 0 && key.requestTimestamps.length >= GEMINI_KEY_REQUESTS_PER_MINUTE) {
      waits.push((key.requestTimestamps[0] + MINUTE_MS) - now);
    }
    if (GEMINI_KEY_REQUESTS_PER_DAY > 0 && key.dayRequestCount >= GEMINI_KEY_REQUESTS_PER_DAY) {
      waits.push((key.dayWindowStart + DAY_MS) - now);
    }

    return waits.length ? Math.max(1, ...waits) : 0;
  }

  private makeNoCapacityError(retryMs: number, now: number) {
    const retryAfterSeconds = Math.max(1, Math.min(3600, Math.ceil((Number.isFinite(retryMs) ? retryMs : MINUTE_MS) / 1000)));
    const allDailyLimited = GEMINI_KEY_REQUESTS_PER_DAY > 0 && this.keys.every((key) => key.dayRequestCount >= GEMINI_KEY_REQUESTS_PER_DAY);
    const allAuthDisabled = this.keys.every((key) => {
      this.pruneKey(key, now);
      return key.disabledReason === "auth" && key.disabledUntil > now;
    });
    const allQuotaDisabled = this.keys.every((key) => key.disabledReason === "quota" && key.disabledUntil > now);

    if (allAuthDisabled) {
      return new PublicError("Gemini server API keys are unavailable. Check server configuration.", 503, {
        retryAfterSeconds,
        code: "gemini_capacity_unavailable",
      });
    }

    if (allQuotaDisabled || allDailyLimited) {
      return new PublicError("Gemini translation capacity has been reached. Try again later.", 429, {
        retryAfterSeconds,
        code: "gemini_capacity_unavailable",
      });
    }

    return new PublicError("Gemini translation capacity is busy. Try again shortly.", 429, {
      retryAfterSeconds,
      code: "gemini_capacity_unavailable",
    });
  }

  private recordResult(key: GeminiKeyState, error?: any) {
    if (!error) return;

    const status = error instanceof PublicError ? error.status : 0;
    const now = Date.now();
    if (status === 401) {
      key.disabledUntil = Math.max(key.disabledUntil, now + GEMINI_KEY_AUTH_COOLDOWN_MS);
      key.disabledReason = "auth";
    } else if (status === 429) {
      key.disabledUntil = Math.max(key.disabledUntil, now + GEMINI_KEY_QUOTA_COOLDOWN_MS);
      key.disabledReason = "quota";
    } else if (status === 503) {
      key.disabledUntil = Math.max(key.disabledUntil, now + GEMINI_KEY_TRANSIENT_COOLDOWN_MS);
      key.disabledReason = "transient";
    }
  }
}

type GeminiUserCounter = {
  minuteWindowStart: number;
  minuteCount: number;
  dayWindowStart: number;
  dayCount: number;
  lastSeenAt: number;
};

class GeminiUserRequestLimiter {
  private readonly counters = new Map<string, GeminiUserCounter>();
  private lastPrunedAt = 0;

  consume(userIdentity: string, requestUnits: number) {
    if (GEMINI_USER_REQUESTS_PER_MINUTE <= 0 && GEMINI_USER_REQUESTS_PER_DAY <= 0) return null;

    const now = Date.now();
    this.prune(now);

    const units = Math.max(1, Math.floor(requestUnits));
    const minuteWindowStart = getWindowStart(now, MINUTE_MS);
    const dayWindowStart = getWindowStart(now, DAY_MS);
    const counter = this.counters.get(userIdentity) || {
      minuteWindowStart,
      minuteCount: 0,
      dayWindowStart,
      dayCount: 0,
      lastSeenAt: now,
    };

    if (counter.minuteWindowStart !== minuteWindowStart) {
      counter.minuteWindowStart = minuteWindowStart;
      counter.minuteCount = 0;
    }
    if (counter.dayWindowStart !== dayWindowStart) {
      counter.dayWindowStart = dayWindowStart;
      counter.dayCount = 0;
    }

    const minuteLimited = GEMINI_USER_REQUESTS_PER_MINUTE > 0 && counter.minuteCount + units > GEMINI_USER_REQUESTS_PER_MINUTE;
    const dayLimited = GEMINI_USER_REQUESTS_PER_DAY > 0 && counter.dayCount + units > GEMINI_USER_REQUESTS_PER_DAY;
    if (minuteLimited || dayLimited) {
      const retryMs = minuteLimited
        ? (counter.minuteWindowStart + MINUTE_MS) - now
        : (counter.dayWindowStart + DAY_MS) - now;
      return new PublicError(
        minuteLimited
          ? "Gemini translation limit reached. Try again in a minute."
          : "Gemini translation limit reached today. Try again later.",
        429,
        {
          retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
          code: "gemini_user_rate_limited",
        },
      );
    }

    counter.minuteCount += units;
    counter.dayCount += units;
    counter.lastSeenAt = now;
    this.counters.set(userIdentity, counter);
    return null;
  }

  private prune(now: number) {
    if (now - this.lastPrunedAt < MINUTE_MS) return;
    this.lastPrunedAt = now;

    const staleCutoff = now - DAY_MS * 2;
    for (const [identity, counter] of this.counters) {
      if (counter.lastSeenAt < staleCutoff) this.counters.delete(identity);
    }
  }
}

const geminiKeyPool = new GeminiServerKeyPool(getConfiguredGeminiApiKeys());
const geminiUserRequestLimiter = new GeminiUserRequestLimiter();

function normalizeLanguageCode(value: any) {
  const cleaned = String(value || "").trim();
  return cleaned && cleaned.toLowerCase() !== "auto" ? cleaned : "";
}

function getSegmentText(segment: any) {
  return String(segment?.primary || segment?.raw || segment?.text || "").trim();
}

function getLanguageLabel(code: string) {
  const normalized = normalizeLanguageCode(code).toLowerCase();
  const labels: Record<string, string> = {
    ar: "Arabic",
    de: "German",
    en: "English",
    es: "Spanish",
    fi: "Finnish",
    fr: "French",
    hi: "Hindi",
    it: "Italian",
    ja: "Japanese",
    ko: "Korean",
    pt: "Portuguese",
    ru: "Russian",
    sv: "Swedish",
    zh: "Chinese",
  };
  return labels[normalized] ? `${labels[normalized]} (${normalized})` : (normalized || "auto-detected language");
}

function buildGeminiTranslationBatches(segments: any[]) {
  const batches: Array<Array<{ index: number; text: string }>> = [];
  let current: Array<{ index: number; text: string }> = [];
  let currentChars = 0;

  segments.forEach((segment, index) => {
    if (String(segment?.translation || "").trim()) return;

    const text = getSegmentText(segment);
    if (!text) return;

    const lineChars = text.length + 32;
    if (
      current.length &&
      (currentChars + lineChars > GEMINI_TRANSLATE_BATCH_CHAR_LIMIT ||
        current.length >= GEMINI_TRANSLATE_MAX_BATCH_SEGMENTS)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push({ index, text });
    currentChars += lineChars;
  });

  if (current.length) batches.push(current);
  return batches;
}

function makeGeminiError(error: any) {
  const message = redactError(error);
  if (/quota|daily limit|rate|resource[_\s-]?exhausted|too many/i.test(message)) {
    return new PublicError("Gemini quota or rate limit reached.", 429);
  }
  if (/high demand|try again later|overloaded|unavailable|temporarily|503/i.test(message)) {
    return new PublicError(message || "Gemini is temporarily unavailable.", 503);
  }
  if (/api key|permission|forbidden|billing|unauthorized|unauthenticated/i.test(message)) {
    return new PublicError("Gemini authentication or billing error.", 401);
  }
  if (/model.*not found|not found.*model|unsupported.*model/i.test(message)) {
    return new PublicError(`${GEMINI_TRANSLATE_MODEL} is unavailable for this Gemini API key.`, 502);
  }
  return new PublicError(message || "Gemini translation failed.", 502);
}

function extractJsonObjectText(value: string) {
  const text = String(value || "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text;
}

function parseGeminiTranslations(value: string) {
  const parsed = JSON.parse(extractJsonObjectText(value));
  const rows = Array.isArray(parsed?.translations)
    ? parsed.translations
    : Array.isArray(parsed)
      ? parsed
      : [];
  const translations = new Map<number, string>();

  for (const row of rows) {
    const index = Number(row?.index);
    const text = String(row?.text || row?.translation || "").trim();
    if (Number.isInteger(index) && text) translations.set(index, text);
  }

  return translations;
}

function getMissingTranslationIndexes(translations: Map<number, string>, batch: Array<{ index: number; text: string }>) {
  return batch
    .filter(({ index }) => !String(translations.get(index) || "").trim())
    .map(({ index }) => index);
}

function buildGeminiTranslationPrompt(batch: Array<{ index: number; text: string }>, options: {
  sourceLanguage: string;
  targetLanguage: string;
  attempt: number;
  missingIndexes?: number[];
}) {
  const sourceLabel = options.sourceLanguage
    ? getLanguageLabel(options.sourceLanguage)
    : "auto-detected source language";
  const targetLabel = getLanguageLabel(options.targetLanguage);
  const retryNote = options.attempt > 1
    ? `Retry note: the previous response was incomplete. Return every requested index, especially ${options.missingIndexes?.join(", ") || "all indexes"}.`
    : "";

  return [
    `Translate these synced song transcript segments from ${sourceLabel} to ${targetLabel}.`,
    "Use the full batch as context so short lyric fragments, pronouns, idioms, slang, and repeated hooks read naturally.",
    "Return one concise translation for every input index. Keep the original order and index numbers. Do not add commentary, markdown, HTML, transliteration notes, or extra rows. Preserve names, repeated vocalizations, and punctuation when they matter for the lyric.",
    retryNote,
    JSON.stringify({ segments: batch }, null, 2),
  ].filter(Boolean).join("\n\n");
}

async function requestGeminiTranslationBatch(batch: Array<{ index: number; text: string }>, options: {
  apiKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  attempt: number;
  missingIndexes?: number[];
}) {
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_TRANSLATE_MODEL)}:generateContent`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": options.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: "You are a precise translation engine for a synced bilingual music visualizer. Output only valid JSON that matches the requested schema.",
        }],
      },
      contents: [{
        role: "user",
        parts: [{ text: buildGeminiTranslationPrompt(batch, options) }],
      }],
      generationConfig: {
        temperature: 0.1,
        topP: 0.8,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            translations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  index: { type: "integer" },
                  text: { type: "string" },
                },
                required: ["index", "text"],
              },
            },
          },
          required: ["translations"],
        },
      },
    }),
  });

  const responseText = await response.text();
  let data: any = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = null;
  }

  if (!response.ok) throw makeGeminiError(data?.error?.message || data?.error || responseText || response.statusText);
  if (!data) throw new PublicError("Gemini returned an invalid translation response.", 502);

  const candidate = data?.candidates?.[0];
  const text = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map((part: any) => part?.text || "").join("").trim()
    : "";
  if (!text) {
    throw new PublicError(`Gemini translation returned no text${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`, 502);
  }

  return parseGeminiTranslations(text);
}

async function requestGeminiTranslationBatchWithServerKey(batch: Array<{ index: number; text: string }>, options: {
  userIdentity: string;
  sourceLanguage: string;
  targetLanguage: string;
  attempt: number;
  missingIndexes?: number[];
}) {
  const lease = geminiKeyPool.lease(options.userIdentity);
  let requestError: any = null;

  try {
    return await requestGeminiTranslationBatch(batch, {
      apiKey: lease.apiKey,
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      attempt: options.attempt,
      missingIndexes: options.missingIndexes,
    });
  } catch (error) {
    requestError = error;
    throw error;
  } finally {
    lease.release(requestError);
  }
}

function isImmediateGeminiCapacityError(error: any) {
  return error instanceof PublicError && [
    "gemini_not_configured",
    "gemini_capacity_unavailable",
    "gemini_user_rate_limited",
  ].includes(error.code);
}

function getGeminiRetryDelayMs(error: any, attempt: number) {
  if (error instanceof PublicError && error.status === 401) return 0;
  if (error instanceof PublicError && error.status === 429) return 250;
  if (error instanceof PublicError && error.status === 503) return Math.min(2500, 750 * attempt);
  return Math.min(2000, 500 * attempt);
}

async function translateGeminiBatch(batch: Array<{ index: number; text: string }>, options: {
  userIdentity: string;
  sourceLanguage: string;
  targetLanguage: string;
}) {
  let missingIndexes: number[] = [];
  let lastError: any = null;
  const maxAttempts = Math.max(GEMINI_TRANSLATE_MAX_ATTEMPTS, geminiKeyPool.size || 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const translations = await requestGeminiTranslationBatchWithServerKey(batch, {
        ...options,
        attempt,
        missingIndexes,
      });
      missingIndexes = getMissingTranslationIndexes(translations, batch);
      if (!missingIndexes.length) return translations;
      lastError = new PublicError(`Gemini missed ${missingIndexes.length} transcript segments.`, 502);
    } catch (error) {
      lastError = error;
      if (isImmediateGeminiCapacityError(error)) throw error;
      if (error instanceof PublicError && error.status === 400) throw error;
      if (attempt < maxAttempts) await sleep(getGeminiRetryDelayMs(error, attempt));
    }
  }

  throw lastError instanceof PublicError ? lastError : makeGeminiError(lastError);
}

function requireStripe() {
  if (!STRIPE_SECRET_KEY) throw new PublicError("Stripe is not configured.", 500);
  return new Stripe(STRIPE_SECRET_KEY);
}

function normalizeSeconds(value: any) {
  const seconds = Math.ceil(Number(value) || 0);
  return Math.max(ELEVENLABS_MIN_PURCHASE_SECONDS, seconds);
}

function secondsToCents(seconds: number) {
  return Math.max(1, Math.ceil((seconds * ELEVENLABS_PRICE_CENTS_PER_HOUR) / 3600));
}

async function getEntitlement(uid: string) {
  const snapshot = await db.collection("entitlements").doc(uid).get();
  const data = snapshot.data() || {};
  const paidSeconds = Math.max(0, Number(data.elevenLabsPaidSeconds) || 0);
  const usedSeconds = Math.max(0, Number(data.elevenLabsUsedSeconds) || 0);
  const reservedSeconds = Math.max(0, Number(data.elevenLabsReservedSeconds) || 0);
  return {
    uid,
    elevenLabsPaidSeconds: paidSeconds,
    elevenLabsUsedSeconds: usedSeconds,
    elevenLabsReservedSeconds: reservedSeconds,
    elevenLabsRemainingSeconds: Math.max(0, paidSeconds - usedSeconds - reservedSeconds),
  };
}

async function getOrCreateStripeCustomer(user: DecodedIdToken) {
  const userRef = db.collection("users").doc(user.uid);
  const snapshot = await userRef.get();
  const existingCustomerId = String(snapshot.data()?.stripeCustomerId || "");
  const stripe = requireStripe();

  if (existingCustomerId) return existingCustomerId;

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: user.name || undefined,
    metadata: { firebaseUid: user.uid },
  });
  await userRef.set({ stripeCustomerId: customer.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  controlLog("billing.stripe_customer_created", {
    uidHash: hashLogId(user.uid),
    customerId: customer.id,
  });
  return customer.id;
}

async function grantElevenLabsSeconds(uid: string, seconds: number, idempotencyKey: string, source: Record<string, any>) {
  const eventRef = db.collection("billingEvents").doc(idempotencyKey);
  const entitlementRef = db.collection("entitlements").doc(uid);
  let granted = false;

  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(eventRef);
    if (existing.exists) return;
    granted = true;

    transaction.set(eventRef, {
      uid,
      kind: "elevenlabs_seconds_granted",
      seconds,
      source,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(entitlementRef, {
      elevenLabsPaidSeconds: FieldValue.increment(seconds),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return granted;
}

async function handleStripeWebhook(req: express.Request, res: express.Response) {
  const stripe = requireStripe();
  if (!STRIPE_WEBHOOK_SECRET) throw new PublicError("Stripe webhook signing secret is not configured.", 500);

  const signature = req.headers["stripe-signature"];
  if (!signature) throw new PublicError("Missing Stripe signature.", 400);

  const rawBody = (req as express.Request & { rawBody?: Buffer | string }).rawBody;
  const payload = Buffer.isBuffer(rawBody) || typeof rawBody === "string"
    ? rawBody
    : (Buffer.isBuffer(req.body) || typeof req.body === "string" ? req.body : null);
  if (!payload) throw new PublicError("Stripe webhook raw body is unavailable.", 400);

  const event = stripe.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET);
  controlLog("billing.webhook_received", {
    eventId: event.id,
    eventType: event.type,
  });

  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as Stripe.PaymentIntent;
    const uid = String(intent.metadata?.firebaseUid || "");
    const seconds = Math.max(0, Math.floor(Number(intent.metadata?.elevenLabsSeconds) || 0));
    if (uid && seconds > 0) {
      const granted = await grantElevenLabsSeconds(uid, seconds, `stripe:${event.id}`, {
        paymentIntentId: intent.id,
        amount: intent.amount_received,
        currency: intent.currency,
      });
      controlLog(granted ? "billing.seconds_granted" : "billing.webhook_duplicate", {
        eventId: event.id,
        paymentIntentId: intent.id,
        uidHash: hashLogId(uid),
        seconds,
        amount: intent.amount_received,
        currency: intent.currency,
      });
    } else {
      controlLog("billing.webhook_missing_metadata", {
        eventId: event.id,
        paymentIntentId: intent.id,
        hasUid: Boolean(uid),
        seconds,
      }, "warn");
    }
  } else {
    controlLog("billing.webhook_ignored", {
      eventId: event.id,
      eventType: event.type,
    });
  }

  res.json({ received: true });
}

function sendPublicError(res: express.Response, error: any, fallback: string) {
  const publicError = error instanceof PublicError ? error : new PublicError(redactError(error) || fallback, 500);
  controlLog("control.error", {
    operation: fallback,
    error: publicError.message,
    status: publicError.status,
    code: publicError.code,
  }, publicError.status >= 500 ? "error" : "warn");
  if (publicError.retryAfterSeconds) res.setHeader("Retry-After", String(publicError.retryAfterSeconds));
  res.status(publicError.status).json({ error: publicError.message || fallback });
}

const app = express();

app.post(["/api/webhooks/stripe", "/webhooks/stripe"], express.raw({ type: "application/json" }), async (req, res) => {
  try {
    await handleStripeWebhook(req, res);
  } catch (error) {
    sendPublicError(res, error, "Stripe webhook failed");
  }
});

app.use(express.json({ limit: "8mb" }));

app.get(["/api/control/health", "/api/health", "/health"], (_req, res) => {
  res.json({
    status: "ok",
    service: "living-sketchbook-control-plane",
    now: new Date().toISOString(),
  });
});

app.get(["/api/entitlements/me", "/entitlements/me"], async (req: AuthenticatedRequest, res) => {
  try {
    const user = await requireFirebaseUser(req);
    const entitlement = await getEntitlement(user.uid);
    controlLog("entitlement.loaded", {
      uidHash: hashLogId(user.uid),
      remainingSeconds: entitlement.elevenLabsRemainingSeconds,
      reservedSeconds: entitlement.elevenLabsReservedSeconds,
      usedSeconds: entitlement.elevenLabsUsedSeconds,
    });
    res.json(entitlement);
  } catch (error) {
    sendPublicError(res, error, "Could not load entitlements");
  }
});

app.post(["/api/translate/gemini", "/translate/gemini"], async (req: AuthenticatedRequest, res) => {
  try {
    const user = await requireFirebaseUser(req);
    const body = req.body || {};
    const targetLanguage = normalizeLanguageCode(body.targetLanguage) || "en";
    const sourceLanguage = normalizeLanguageCode(body.sourceLanguage);
    const incomingSegments = Array.isArray(body.segments) ? body.segments : [];
    const updatedSegments = incomingSegments.map((segment: any) => ({ ...segment }));
    const batches = buildGeminiTranslationBatches(updatedSegments);

    if (batches.length) {
      geminiKeyPool.assertConfigured();
      const userLimitError = geminiUserRequestLimiter.consume(user.uid, batches.length);
      if (userLimitError) throw userLimitError;
    }

    for (const batch of batches) {
      const translated = await translateGeminiBatch(batch, {
        userIdentity: user.uid,
        sourceLanguage,
        targetLanguage,
      });

      for (const { index } of batch) {
        const translation = translated.get(index);
        if (translation && !String(updatedSegments[index]?.translation || "").trim()) {
          updatedSegments[index].translation = translation;
        }
      }
    }

    const response = {
      segments: updatedSegments,
      translationSource: GEMINI_TRANSLATE_MODEL,
      translationModel: GEMINI_TRANSLATE_MODEL,
      translationRequestMode: batches.length <= 1 ? "single-request" : "chunked-for-gemini-context",
      translationBatchCount: batches.length,
    };
    controlLog("gemini.translation_completed", {
      uidHash: hashLogId(user.uid),
      segmentCount: incomingSegments.length,
      batchCount: batches.length,
      sourceLanguage: sourceLanguage || "auto",
      targetLanguage,
    });
    res.json(response);
  } catch (error) {
    sendPublicError(res, error, "Gemini translation failed");
  }
});

app.post(["/api/billing/elevenlabs/payment-intent", "/billing/elevenlabs/payment-intent"], async (req: AuthenticatedRequest, res) => {
  try {
    const user = await requireFirebaseUser(req);
    const seconds = normalizeSeconds(req.body?.seconds);
    const amount = secondsToCents(seconds);
    const customer = await getOrCreateStripeCustomer(user);
    const stripe = requireStripe();
    const intent = await stripe.paymentIntents.create({
      amount,
      currency: BILLING_CURRENCY,
      customer,
      automatic_payment_methods: { enabled: true },
      metadata: {
        firebaseUid: user.uid,
        elevenLabsSeconds: String(seconds),
        product: "elevenlabs_scribe_seconds",
      },
    });

    controlLog("billing.payment_intent_created", {
      uidHash: hashLogId(user.uid),
      paymentIntentId: intent.id,
      amount,
      currency: BILLING_CURRENCY,
      seconds,
    });
    res.json({
      clientSecret: intent.client_secret,
      amount,
      currency: BILLING_CURRENCY,
      seconds,
      priceCentsPerHour: ELEVENLABS_PRICE_CENTS_PER_HOUR,
    });
  } catch (error) {
    sendPublicError(res, error, "Could not start billing");
  }
});

app.post(["/api/billing/elevenlabs/checkout-session", "/billing/elevenlabs/checkout-session"], async (req: AuthenticatedRequest, res) => {
  try {
    const user = await requireFirebaseUser(req);
    if (!APP_URL) throw new PublicError("APP_URL is required for Stripe Checkout.", 500);

    const seconds = normalizeSeconds(req.body?.seconds);
    const amount = secondsToCents(seconds);
    const customer = await getOrCreateStripeCustomer(user);
    const stripe = requireStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer,
      success_url: `${APP_URL.replace(/\/+$/, "")}/?billing=success`,
      cancel_url: `${APP_URL.replace(/\/+$/, "")}/?billing=cancel`,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: BILLING_CURRENCY,
          unit_amount: amount,
          product_data: {
            name: "ElevenLabs Scribe time",
            metadata: { product: "elevenlabs_scribe_seconds" },
          },
        },
      }],
      payment_intent_data: {
        metadata: {
          firebaseUid: user.uid,
          elevenLabsSeconds: String(seconds),
          product: "elevenlabs_scribe_seconds",
        },
      },
      metadata: {
        firebaseUid: user.uid,
        elevenLabsSeconds: String(seconds),
        product: "elevenlabs_scribe_seconds",
      },
    });

    controlLog("billing.checkout_session_created", {
      uidHash: hashLogId(user.uid),
      checkoutSessionId: session.id,
      amount,
      currency: BILLING_CURRENCY,
      seconds,
    });
    res.json({ url: session.url, id: session.id, amount, currency: BILLING_CURRENCY, seconds });
  } catch (error) {
    sendPublicError(res, error, "Could not start checkout");
  }
});

export const api = onRequest({
  region: REGION,
  timeoutSeconds: 120,
  memory: "512MiB",
  maxInstances: 20,
}, app);
