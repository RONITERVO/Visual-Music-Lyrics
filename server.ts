/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import "dotenv/config";
import express from "express";
import { registerLocalSuno } from "./server/localSuno";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import youtubeDl from "youtube-dl-exec";
import { initializeApp as initializeFirebaseAdminApp, getApps as getFirebaseAdminApps } from "firebase-admin/app";
import { getAuth as getFirebaseAdminAuth, type DecodedIdToken } from "firebase-admin/auth";
import { FieldValue, getFirestore as getFirebaseAdminFirestore } from "firebase-admin/firestore";
import {
  filterYoutubeCaptionTracksForPolicy,
  getYoutubeCaptionPolicy,
  isYoutubeAutomaticCaptionTrack,
  parseYoutubeAutomaticCaptionsOptIn,
} from "./src/lib/youtubeCaptionPolicy";

const SCRIBE_SOURCE = "elevenlabs-scribe-v2";
const ELEVENLABS_SCRIBE_MODEL = "scribe_v2";
const ELEVENLABS_SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const LRCLIB_API_BASE = "https://lrclib.net/api";
const LRCLIB_USER_AGENT = "LivingSketchbookMusic/0.1.0 (https://github.com/RONITERVO/Audio-visualizer-ai-studio-edition)";
const MAX_SCRIBE_KEYTERMS = 1000;
const MAX_LRCLIB_SEARCH_CANDIDATES = 10;
const MAX_LRCLIB_SEARCH_URLS = 4;
const MAX_LRCLIB_CONCURRENT_SEARCHES = 2;
const MAX_LRCLIB_RESULTS_PER_CANDIDATE = 20;
const LRCLIB_SEARCH_TIMEOUT_MS = parseEnvInteger("LRCLIB_SEARCH_TIMEOUT_MS", 9000, 1000, 15_000);

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const GEMINI_TRANSLATE_MODEL = "gemini-flash-lite-latest";
const GEMINI_TRANSLATE_BATCH_CHAR_LIMIT = 48_000;
const GEMINI_TRANSLATE_MAX_BATCH_SEGMENTS = 240;
const GEMINI_TRANSLATE_MAX_ATTEMPTS = 3;
const GEMINI_SERVER_KEYS_ENV = "GEMINI_API_KEYS";
const GEMINI_KEY_MAX_CONCURRENCY = parseEnvInteger("GEMINI_KEY_MAX_CONCURRENCY", 1, 1, 20);
const GEMINI_KEY_REQUESTS_PER_MINUTE = parseEnvInteger("GEMINI_KEY_REQUESTS_PER_MINUTE", 12, 0, 1000);
const GEMINI_KEY_REQUESTS_PER_DAY = parseEnvInteger("GEMINI_KEY_REQUESTS_PER_DAY", 0, 0, 100_000);
const GEMINI_USER_REQUESTS_PER_MINUTE = parseEnvInteger("GEMINI_USER_REQUESTS_PER_MINUTE", 6, 0, 1000);
const GEMINI_USER_REQUESTS_PER_DAY = parseEnvInteger("GEMINI_USER_REQUESTS_PER_DAY", 120, 0, 100_000);
const GEMINI_KEY_QUOTA_COOLDOWN_MS = parseEnvInteger("GEMINI_KEY_QUOTA_COOLDOWN_SECONDS", 75, 5, 3600) * 1000;
const GEMINI_KEY_TRANSIENT_COOLDOWN_MS = parseEnvInteger("GEMINI_KEY_TRANSIENT_COOLDOWN_SECONDS", 12, 1, 600) * 1000;
const GEMINI_KEY_AUTH_COOLDOWN_MS = parseEnvInteger("GEMINI_KEY_AUTH_COOLDOWN_SECONDS", 1800, 60, 86_400) * 1000;
const TARGET_SEGMENT_WORDS = 7;
const MAX_SEGMENT_WORDS = 10;
const TARGET_SEGMENT_CHARS = 42;
const MAX_SEGMENT_CHARS = 58;
const TARGET_SEGMENT_SECONDS = 4.2;
const MAX_SEGMENT_SECONDS = 6;
const MIN_SEGMENT_WORDS = 2;
const YOUTUBE_AUDIO_FORMAT = "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best";
const YOUTUBE_INFO_TIMEOUT_MS = 60_000;
const YOUTUBE_CHANNEL_FALLBACK_TIMEOUT_MS = 120_000;
const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const YOUTUBE_CAPTION_TIMEOUT_MS = 45_000;
const YOUTUBE_CAPTION_DOWNLOAD_TIMEOUT_MS = 90_000;
const YOUTUBE_MAX_CONCURRENT_JOBS = parseEnvInteger("YOUTUBE_MAX_CONCURRENT_JOBS", 1, 1, 4);
const YOUTUBE_JOB_QUEUE_LIMIT = parseEnvInteger("YOUTUBE_JOB_QUEUE_LIMIT", 8, 0, 100);
const YOUTUBE_CAPTION_CACHE_MAX_ENTRIES = 160;
const YOUTUBE_CAPTION_CACHE_MAX_BYTES = 12 * 1024 * 1024;
const YOUTUBE_CAPTION_CACHE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const YOUTUBE_CHANNEL_PREVIEW_LIMIT = 100;
const YOUTUBE_CHANNEL_LATEST_SCAN_LIMIT = 350;
const YOUTUBE_CHANNEL_POPULAR_SCAN_LIMIT = 250;
const YOUTUBE_CHANNEL_LATEST_KEEP = 24;
const YOUTUBE_CHANNEL_POPULAR_KEEP = 56;
const YOUTUBE_RESOLVE_CACHE_MAX_ENTRIES = 96;
const YOUTUBE_RESOLVE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const YOUTUBE_VIDEO_CACHE_FRESH_MS = 12 * 60 * 60 * 1000;
const YOUTUBE_VIDEO_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const YOUTUBE_CHANNEL_CACHE_FRESH_MS = 10 * 60 * 1000;
const YOUTUBE_CHANNEL_CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const YOUTUBE_CHANNEL_SUGGESTION_CACHE_MAX_ENTRIES = 160;
const YOUTUBE_CHANNEL_SUGGESTION_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const YOUTUBE_CHANNEL_SUGGESTION_CACHE_FRESH_MS = 2 * 60 * 1000;
const YOUTUBE_COOKIES_FILE_ENV = "YOUTUBE_COOKIES_FILE";
const YOUTUBE_COOKIES_ENV = "YOUTUBE_COOKIES";
const YOUTUBE_COOKIES_BASE64_ENV = "YOUTUBE_COOKIES_BASE64";
const FIREBASE_AUTH_REQUIRED = parseEnvBoolean("FIREBASE_AUTH_REQUIRED", false);
const ELEVENLABS_MIN_RESERVATION_SECONDS = parseEnvInteger("ELEVENLABS_MIN_RESERVATION_SECONDS", 60, 1, 3600);

let youtubeCookiesFilePath = "";
let youtubeCookiesSignature = "";
let youtubeConfiguredCookiesSource = "";
let youtubeConfiguredCookiesMtimeMs = 0;
let youtubeCookieHeaderFilePath = "";
let youtubeCookieHeaderSignature = "";
let youtubeCookieHeaderValue = "";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseEnvInteger(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function parseEnvBoolean(name: string, fallback: boolean) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

type MediaLogLevel = "info" | "warn" | "error";

function redactText(value: any) {
  return String(value ?? "")
    .replace(/xi-api-key[^\s,}]*/gi, "xi-api-key=[redacted]")
    .replace(/key=([^&\s]+)/gi, "key=[redacted]")
    .replace(/AIza[0-9A-Za-z_-]+/g, "[redacted-google-key]")
    .replace(/sk_[0-9A-Za-z_-]+/g, "[redacted-key]");
}

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
  return text ? crypto.createHash("sha256").update(text).digest("hex").slice(0, 12) : "";
}

function mediaLog(event: string, details: Record<string, any> = {}, level: MediaLogLevel = "info") {
  const payload = sanitizeLogValue({
    service: "visual-music-media",
    event,
    ...details,
  });
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function scribeLog(requestId: string, message: string, details: Record<string, any> = {}) {
  const eventSuffix = message.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "event";
  mediaLog(`scribe.${eventSuffix}`, { requestId, message, ...details });
}

class PublicError extends Error {
  status: number;
  retryAfterSeconds?: number;
  code?: string;

  constructor(message: string, status = 500, options: { retryAfterSeconds?: number; code?: string } = {}) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.code = options.code;
  }
}

type TaskRelease = () => void;

class AsyncTaskLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxQueued: number,
  ) {}

  acquire(label: string): Promise<TaskRelease> {
    const queuedAt = Date.now();

    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this.createRelease(label, queuedAt));
    }

    if (this.queue.length >= this.maxQueued) {
      mediaLog("youtube.job_rejected", {
        label,
        active: this.active,
        queued: this.queue.length,
        maxActive: this.maxActive,
        maxQueued: this.maxQueued,
      }, "warn");
      return Promise.reject(new PublicError(
        "The YouTube backend is busy. Try again in a minute.",
        503,
        { retryAfterSeconds: 30, code: "youtube_backend_busy" },
      ));
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(this.createRelease(label, queuedAt));
      });
    });
  }

  async run<T>(label: string, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(label);
    const startedAt = Date.now();
    try {
      const result = await task();
      mediaLog("youtube.job_completed", {
        label,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const publicError = error instanceof PublicError ? error : null;
      mediaLog("youtube.job_failed", {
        label,
        durationMs: Date.now() - startedAt,
        status: publicError?.status || 500,
        code: publicError?.code || "",
        error: redactError(error),
      }, publicError && publicError.status < 500 ? "warn" : "error");
      throw error;
    } finally {
      release();
    }
  }

  private createRelease(label: string, queuedAt: number): TaskRelease {
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs >= 1000) {
      mediaLog("youtube.job_dequeued", { label, waitedMs });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

const youtubeDlpLimiter = new AsyncTaskLimiter(YOUTUBE_MAX_CONCURRENT_JOBS, YOUTUBE_JOB_QUEUE_LIMIT);

function runYoutubeDlpJob<T>(label: string, task: () => Promise<T>) {
  return youtubeDlpLimiter.run(label, task);
}

function redactError(error: any) {
  return redactText(error?.message || error || "Unknown error");
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function getWindowStart(now: number, windowMs: number) {
  return Math.floor(now / windowMs) * windowMs;
}

function fingerprintSecret(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function getStableHashInt(value: string) {
  return crypto.createHash("sha256").update(value || "anonymous").digest().readUInt32BE(0);
}

function parseSecretList(value: any) {
  const text = String(value || "").trim();
  if (!text) return [];

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item || "").trim()).filter(Boolean);
      }
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

function getFirstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getGeminiUserIdentity(req: express.Request) {
  const clientId = stripHttpHeaderUnsafeText(getFirstHeaderValue(req.headers["x-client-id"])).slice(0, 128);
  const forwardedFor = stripHttpHeaderUnsafeText(getFirstHeaderValue(req.headers["x-forwarded-for"])).split(",")[0].trim();
  const ip = stripHttpHeaderUnsafeText(req.ip || forwardedFor || req.socket.remoteAddress || "").slice(0, 80);
  const userAgent = stripHttpHeaderUnsafeText(req.headers["user-agent"]).slice(0, 160);
  const rawIdentity = [clientId || "no-client-id", ip || "no-ip", userAgent || "no-user-agent"].join("|");
  return crypto.createHash("sha256").update(rawIdentity).digest("hex");
}

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
      throw new PublicError(
        `Set ${GEMINI_SERVER_KEYS_ENV} on the server before using Gemini translation.`,
        400,
        { code: "gemini_not_configured" },
      );
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
      if (retryMs <= 0) {
        return this.createLease(key, now);
      }
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
    while (key.requestTimestamps.length && key.requestTimestamps[0] <= minuteCutoff) {
      key.requestTimestamps.shift();
    }

    const currentDayStart = getWindowStart(now, DAY_MS);
    if (key.dayWindowStart !== currentDayStart) {
      key.dayWindowStart = currentDayStart;
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
    const allAuthDisabled = this.keys.every((key) => {
      this.pruneKey(key, now);
      return key.disabledReason === "auth" && key.disabledUntil > now;
    });
    const allQuotaDisabled = this.keys.every((key) => key.disabledReason === "quota" && key.disabledUntil > now);
    const allTransientDisabled = this.keys.every((key) => key.disabledReason === "transient" && key.disabledUntil > now);
    const allDailyLimited = GEMINI_KEY_REQUESTS_PER_DAY > 0 && this.keys.every((key) => key.dayRequestCount >= GEMINI_KEY_REQUESTS_PER_DAY);

    if (allAuthDisabled) {
      return new PublicError(
        "Gemini server API keys are unavailable. Check the server configuration.",
        503,
        { retryAfterSeconds, code: "gemini_capacity_unavailable" },
      );
    }

    if (allQuotaDisabled) {
      return new PublicError(
        "Gemini server quota is temporarily exhausted. Try again shortly.",
        429,
        { retryAfterSeconds, code: "gemini_capacity_unavailable" },
      );
    }

    if (allTransientDisabled) {
      return new PublicError(
        "Gemini is temporarily unavailable. Try again shortly.",
        503,
        { retryAfterSeconds, code: "gemini_capacity_unavailable" },
      );
    }

    if (allDailyLimited) {
      return new PublicError(
        "Gemini daily translation capacity has been reached. Try again later.",
        429,
        { retryAfterSeconds, code: "gemini_capacity_unavailable" },
      );
    }

    return new PublicError(
      "Gemini translation capacity is busy. Try again shortly.",
      429,
      { retryAfterSeconds, code: "gemini_capacity_unavailable" },
    );
  }

  private recordResult(key: GeminiKeyState, error?: any) {
    if (!error) {
      return;
    }

    const status = error instanceof PublicError ? error.status : 0;
    const now = Date.now();

    if (status === 401) {
      key.disabledUntil = Math.max(key.disabledUntil, now + GEMINI_KEY_AUTH_COOLDOWN_MS);
      key.disabledReason = "auth";
      return;
    }

    if (status === 429) {
      key.disabledUntil = Math.max(key.disabledUntil, now + GEMINI_KEY_QUOTA_COOLDOWN_MS);
      key.disabledReason = "quota";
      return;
    }

    if (status === 503) {
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
          ? "Gemini translation limit reached for this browser. Try again in a minute."
          : "Gemini translation limit reached for this browser today. Try again later.",
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

function stripTags(value: string) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

function decodeBasicEntities(value: string) {
  return String(value || "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeXmlText(value: string) {
  return decodeBasicEntities(
    String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
  ).trim();
}

function normalizeLanguageCode(value: any) {
  const cleaned = String(value || "").trim();
  return cleaned && cleaned.toLowerCase() !== "auto" ? cleaned : "";
}

interface ParsedSongLookupCandidate {
  artistName: string;
  trackName: string;
  query: string;
  source: string;
  confidence: number;
}

interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

function getTextInput(value: any) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripAudioFileExtension(value: string) {
  return value.replace(/\.(?:mp3|m4a|mp4|wav|wave|flac|ogg|opus|webm|aac|aiff?)$/i, "").trim();
}

function stripLeadingTrackNumber(value: string) {
  return value.replace(/^\s*(?:disc\s*)?\d{1,3}\s*[.)_-]\s+/i, "").replace(/^\s*\d{1,3}\.\s+/, "").trim();
}

function stripYoutubeIdBrackets(value: string) {
  return value.replace(/\s*[\[(]\s*[A-Za-z0-9_-]{11}\s*[\])]\s*/g, " ").trim();
}

function isNoisyMediaTag(value: string) {
  const text = normalizeSearchText(value);
  if (!text) return true;
  return /^(?:official|music|video|audio|lyrics?|lyric|visualizer|hd|hq|4k|8k|explicit|clean|radio edit|full song|full audio|official audio|official video|music video|official music video|remaster(?:ed)?(?: \d{2,4})?|stereo|mono)$/.test(text) ||
    /\bofficial\b|\b(?:music )?video\b|\baudio\b|\blyrics?\b|\bvisualizer\b|\bexplicit\b|\bremaster(?:ed)?\b|\b\d+k\b/.test(text);
}

function stripKnownMediaTags(value: string) {
  let text = value;
  text = stripYoutubeIdBrackets(text);
  text = text.replace(/\(([^)]{0,100})\)/g, (match, inner) => isNoisyMediaTag(inner) ? " " : match);
  text = text.replace(/\[([^\]]{0,100})\]/g, (match, inner) => isNoisyMediaTag(inner) ? " " : match);
  text = text.replace(/\{([^}]{0,100})\}/g, (match, inner) => isNoisyMediaTag(inner) ? " " : match);
  text = text.replace(/\b(?:official\s+)?(?:music\s+)?video\b/gi, " ");
  text = text.replace(/\b(?:official\s+)?audio\b/gi, " ");
  text = text.replace(/\blyric(?:s|al)?\s+video\b/gi, " ");
  text = text.replace(/\bvisuali[sz]er\b/gi, " ");
  text = text.replace(/\b(?:hd|hq|4k|8k|explicit|clean)\b/gi, " ");
  text = text.replace(/\bremaster(?:ed)?\s*(?:19|20)?\d{2}\b/gi, " ");
  return text.replace(/\s+/g, " ").replace(/\s+([|:;,.!?])/g, "$1").trim();
}

function cleanSongLookupPart(value: string) {
  return stripKnownMediaTags(stripLeadingTrackNumber(stripAudioFileExtension(value)))
    .replace(/^[\s"'\-–—|:]+|[\s"'\-–—|:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function createSongLookupCandidate(
  artistName: string,
  trackName: string,
  source: string,
  confidence: number,
): ParsedSongLookupCandidate | null {
  const artist = cleanSongLookupPart(artistName);
  const track = cleanSongLookupPart(trackName);
  const query = [artist, track].filter(Boolean).join(" ").trim() || track || artist;
  if (!query || (!track && !artist)) return null;
  return { artistName: artist, trackName: track || query, query, source, confidence };
}

function addSongLookupCandidate(
  candidates: ParsedSongLookupCandidate[],
  seen: Set<string>,
  candidate: ParsedSongLookupCandidate | null,
) {
  if (!candidate) return;
  const key = [
    normalizeSearchText(candidate.artistName),
    normalizeSearchText(candidate.trackName),
    normalizeSearchText(candidate.query),
  ].join("|");
  if (!key.replace(/\|/g, "")) return;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

function parseSongLookupCandidatesFromInput(input: any, source: string) {
  const candidates: ParsedSongLookupCandidate[] = [];
  const seen = new Set<string>();
  const raw = getTextInput(input);
  if (!raw) return candidates;

  const cleaned = cleanSongLookupPart(raw);
  const cornerMatch = /^\s*(.+?)\s*[「『]([^」』]+)[」』]/u.exec(stripKnownMediaTags(raw));
  if (cornerMatch) {
    addSongLookupCandidate(candidates, seen, createSongLookupCandidate(cornerMatch[1], cornerMatch[2], `${source}:corner-brackets`, 102));
  }

  const delimiterPatterns = [
    { delimiter: " - ", label: "dash" },
    { delimiter: " – ", label: "en-dash" },
    { delimiter: " — ", label: "em-dash" },
    { delimiter: " | ", label: "pipe" },
    { delimiter: "|", label: "pipe" },
  ];

  for (const pattern of delimiterPatterns) {
    const index = cleaned.indexOf(pattern.delimiter);
    if (index <= 0) continue;

    const left = cleaned.slice(0, index);
    const right = cleaned.slice(index + pattern.delimiter.length);
    addSongLookupCandidate(candidates, seen, createSongLookupCandidate(left, right, `${source}:${pattern.label}`, 96));
    addSongLookupCandidate(candidates, seen, createSongLookupCandidate(right, left, `${source}:${pattern.label}:reversed`, 76));
    break;
  }

  addSongLookupCandidate(candidates, seen, createSongLookupCandidate("", cleaned, `${source}:query`, 58));
  return candidates;
}

function getScribeLookupCandidates(body: any) {
  const rawInputs: Array<[string, any]> = [
    ["youtube-title", body.youtubeTitle || body.mediaTitle || body.title],
    ["song-name", body.songName || body.name],
    ["file-name", body.fileName],
    ["song-base", body.songBase || body.base],
  ];

  const candidates: ParsedSongLookupCandidate[] = [];
  const seen = new Set<string>();
  for (const [source, value] of rawInputs) {
    for (const candidate of parseSongLookupCandidatesFromInput(value, source)) {
      addSongLookupCandidate(candidates, seen, candidate);

      const channelTitle = getTextInput(body.youtubeChannelTitle || body.channelTitle);
      if (!candidate.artistName && channelTitle && candidate.trackName) {
        addSongLookupCandidate(
          candidates,
          seen,
          createSongLookupCandidate(channelTitle, candidate.trackName, `${source}:channel-artist`, candidate.confidence - 4),
        );
      }
    }
  }

  return candidates
    .sort((left, right) => right.confidence - left.confidence || right.query.length - left.query.length)
    .slice(0, MAX_LRCLIB_SEARCH_CANDIDATES);
}

function getLrclibSearchUrls(candidate: ParsedSongLookupCandidate) {
  const urls: string[] = [];
  if (candidate.artistName && candidate.trackName) {
    const exact = new URL(`${LRCLIB_API_BASE}/search`);
    exact.searchParams.set("artist_name", candidate.artistName);
    exact.searchParams.set("track_name", candidate.trackName);
    urls.push(exact.toString());
  }

  const query = candidate.query || [candidate.artistName, candidate.trackName].filter(Boolean).join(" ");
  if (query) {
    const fuzzy = new URL(`${LRCLIB_API_BASE}/search`);
    fuzzy.searchParams.set("q", query);
    urls.push(fuzzy.toString());
  }

  return [...new Set(urls)];
}

async function fetchLrclibSearchUrl(url: string): Promise<LrclibRecord[]> {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": LRCLIB_USER_AGENT,
    },
    signal: (AbortSignal as any).timeout?.(LRCLIB_SEARCH_TIMEOUT_MS),
  } as any);

  if (response.status === 404) return [];
  if (!response.ok) {
    throw new PublicError(`LRCLIB search failed (${response.status}).`, response.status >= 500 ? 502 : response.status);
  }

  const data = await response.json().catch(() => null);
  return Array.isArray(data) ? data.slice(0, MAX_LRCLIB_RESULTS_PER_CANDIDATE) : [];
}

function scoreLrclibRecord(record: LrclibRecord, candidate: ParsedSongLookupCandidate, estimatedDurationSeconds: number) {
  const trackName = getTextInput(record.trackName);
  const artistName = getTextInput(record.artistName);
  const combined = [artistName, trackName].filter(Boolean).join(" ");
  let score = 0;

  if (candidate.trackName) score += scoreTextAgainstQuery(trackName, candidate.trackName) * 1.45;
  if (candidate.artistName) score += scoreTextAgainstQuery(artistName, candidate.artistName) * 0.9;
  score += scoreTextAgainstQuery(combined, candidate.query) * 0.45;
  if (record.plainLyrics || record.syncedLyrics) score += 24;
  if (record.instrumental) score -= 25;

  const duration = Math.max(0, Number(record.duration) || 0);
  if (duration > 0 && estimatedDurationSeconds > 0) {
    const diff = Math.abs(duration - estimatedDurationSeconds);
    if (diff <= 2) score += 34;
    else if (diff <= 5) score += 24;
    else if (diff <= 10) score += 12;
    else if (diff >= 30) score -= Math.min(35, diff * 0.6);
  }

  return score;
}

function stripLrcTimestamps(value: string) {
  return String(value || "")
    .replace(/\[[0-9:.]+\]/g, " ")
    .replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, " ")
    .replace(/\[[^\]]{0,60}\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeScribeKeyterm(value: string) {
  const cleaned = String(value || "")
    .replace(/[<>{}\[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 50) return "";
  if (cleaned.split(/\s+/).length > 5) return "";
  return cleaned;
}

function addScribeKeyterm(terms: string[], seen: Set<string>, value: string) {
  if (terms.length >= MAX_SCRIBE_KEYTERMS) return;
  const clean = sanitizeScribeKeyterm(value);
  if (!clean) return;
  const key = clean.normalize("NFKC").toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  terms.push(clean);
}

function getKeytermWordsFromLyrics(value: string) {
  return stripLrcTimestamps(value).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) || [];
}

function buildScribeKeytermsFromLrclib(record: LrclibRecord, candidate: ParsedSongLookupCandidate) {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const seed of [
    candidate.trackName,
    candidate.artistName,
    record.trackName || "",
    record.artistName || "",
  ]) {
    addScribeKeyterm(terms, seen, seed);
  }

  const lyricText = [record.plainLyrics || "", record.syncedLyrics || ""].filter(Boolean).join("\n");
  for (const word of getKeytermWordsFromLyrics(lyricText)) {
    addScribeKeyterm(terms, seen, word);
    if (terms.length >= MAX_SCRIBE_KEYTERMS) break;
  }

  return terms;
}

function buildFallbackScribeKeyterms(candidates: ParsedSongLookupCandidate[]) {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, 4)) {
    for (const value of [candidate.trackName, candidate.artistName]) {
      addScribeKeyterm(terms, seen, value);
      for (const word of getKeytermWordsFromLyrics(value)) addScribeKeyterm(terms, seen, word);
    }
  }
  return terms;
}

async function resolveLrclibKeytermsForScribe(body: any, estimatedDurationSeconds: number, requestId: string) {
  const candidates = getScribeLookupCandidates(body);
  const bestById = new Map<string, {
    record: LrclibRecord;
    candidate: ParsedSongLookupCandidate;
    score: number;
  }>();

  const searches = candidates
    .flatMap((candidate) => getLrclibSearchUrls(candidate).map((url) => ({ candidate, url })))
    .slice(0, MAX_LRCLIB_SEARCH_URLS);

  const settledSearches: Array<PromiseSettledResult<{
    candidate: ParsedSongLookupCandidate;
    url: string;
    records: LrclibRecord[];
  }>> = [];

  for (let index = 0; index < searches.length; index += MAX_LRCLIB_CONCURRENT_SEARCHES) {
    const chunk = searches.slice(index, index + MAX_LRCLIB_CONCURRENT_SEARCHES);
    settledSearches.push(...await Promise.allSettled(
      chunk.map(async (search) => ({
        ...search,
        records: await fetchLrclibSearchUrl(search.url),
      })),
    ));
  }

  for (const result of settledSearches) {
    if (result.status === "rejected") {
      mediaLog("scribe.lrclib_search_failed", {
        requestId,
        error: redactError(result.reason),
      }, "warn");
      continue;
    }

    const { candidate, records } = result.value;
    for (const record of records) {
      const id = String(record.id || `${record.artistName || ""}:${record.trackName || ""}:${record.duration || ""}`);
      const score = scoreLrclibRecord(record, candidate, estimatedDurationSeconds);
      const existing = bestById.get(id);
      if (!existing || score > existing.score) {
        bestById.set(id, { record, candidate, score });
      }
    }
  }

  const best = [...bestById.values()].sort((left, right) => right.score - left.score)[0];
  if (!best || best.score < 90) {
    const fallbackKeyterms = buildFallbackScribeKeyterms(candidates);
    return {
      keyterms: fallbackKeyterms,
      metadata: {
        status: best ? "low-confidence" : "not-found",
        candidateCount: candidates.length,
        bestScore: best ? Number(best.score.toFixed(1)) : 0,
        keytermCount: fallbackKeyterms.length,
      },
    };
  }

  const keyterms = buildScribeKeytermsFromLrclib(best.record, best.candidate);
  return {
    keyterms,
    metadata: {
      status: "matched",
      candidateCount: candidates.length,
      bestScore: Number(best.score.toFixed(1)),
      matchedBy: best.candidate.source,
      selectedTrack: getTextInput(best.record.trackName),
      selectedArtist: getTextInput(best.record.artistName),
      selectedDurationSeconds: Math.max(0, Number(best.record.duration) || 0),
      keytermCount: keyterms.length,
    },
  };
}

type ParsedYoutubeInput =
  | { kind: "video"; videoId: string; url: string }
  | { kind: "channel"; url: string; channelId?: string; handle?: string; username?: string; slug?: string; query?: string };

interface YoutubeVideoPreview {
  videoId: string;
  title: string;
  url: string;
  channelId: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number;
  publishedAt: string;
  viewCount?: number;
  latestRank?: number;
  popularRank?: number;
}

interface YoutubeChannelInfo {
  channelId: string;
  title: string;
  thumbnailUrl: string;
  uploadsPlaylistId: string;
  url: string;
}

interface YoutubeChannelSuggestionPayload {
  title: string;
  channelId: string;
  thumbnailUrl: string;
  url: string;
}

interface YoutubeResolvePayload {
  kind: "video" | "channel";
  input: string;
  channel?: YoutubeChannelInfo;
  videos: YoutubeVideoPreview[];
}

interface YoutubeCaptionPayload {
  source: "youtube-captions-json3";
  transcriptionSource: "youtube-captions-json3";
  extractorSource: YoutubeCaptionTrackSource;
  automaticCaptionsAllowed: boolean;
  videoId: string;
  requestedLanguage: string;
  requestedTargetLanguage?: string;
  languageCode: string;
  trackKind: string;
  trackName: string;
  translationSource?: string;
  translationLanguageCode?: string;
  translationTrackKind?: string;
  translationTrackName?: string;
  generatedAt: string;
  segments: any[];
}

type YoutubeResolveCacheStatus = "miss" | "hit" | "stale" | "refresh";

interface YoutubeResolveCacheMeta {
  status: YoutubeResolveCacheStatus;
  ageSeconds: number;
  maxAgeSeconds: number;
  staleSeconds: number;
  refreshedAt: string;
  warning?: string;
}

interface YoutubeResolveCacheEntry {
  payload: YoutubeResolvePayload;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
  bytes: number;
}

interface YoutubeChannelSuggestionCacheEntry {
  suggestions: YoutubeChannelSuggestionPayload[];
  storedAt: number;
  freshUntil: number;
  bytes: number;
}

interface YoutubeCaptionCacheEntry {
  payload: YoutubeCaptionPayload;
  storedAt: number;
  freshUntil: number;
  bytes: number;
}

interface YoutubeCaptionRequestOptions {
  allowAutomaticCaptions: boolean;
}

const youtubeResolveCache = new Map<string, YoutubeResolveCacheEntry>();
const youtubeResolveRefreshes = new Map<string, Promise<YoutubeResolvePayload>>();
let youtubeResolveCacheBytes = 0;
const youtubeChannelSuggestionCache = new Map<string, YoutubeChannelSuggestionCacheEntry>();
let youtubeChannelSuggestionCacheBytes = 0;
const youtubeCaptionCache = new Map<string, YoutubeCaptionCacheEntry>();
let youtubeCaptionCacheBytes = 0;

function normalizeYoutubeVideoId(value: any) {
  const cleaned = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{11}$/.test(cleaned) ? cleaned : "";
}

function normalizeYoutubeChannelId(value: any) {
  const cleaned = String(value || "").trim();
  return /^UC[a-zA-Z0-9_-]{20,}$/.test(cleaned) ? cleaned : "";
}

function normalizeYoutubeHandle(value: any) {
  const cleaned = String(value || "").trim().replace(/^@+/, "");
  return /^[a-zA-Z0-9._-]{3,30}$/.test(cleaned) ? cleaned : "";
}

function youtubeVideoUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function normalizeYoutubeUrlInput(input: string) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function looksLikeUrlInput(input: string) {
  const trimmed = String(input || "").trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^www\./i.test(trimmed) ||
    /^youtu\.be\//i.test(trimmed) ||
    /(^|\.)youtube\.com\//i.test(trimmed);
}

function normalizeYoutubeChannelSearchQuery(input: any) {
  const cleaned = String(input || "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ");
  if (cleaned.length < 3 || cleaned.length > 80) return "";
  if (/[/\\]/.test(cleaned)) return "";
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return "";
  return cleaned;
}

function normalizeYoutubeChannelSuggestionQuery(input: any) {
  const cleaned = String(input || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ");
  if (cleaned.length < 2 || cleaned.length > 80) return "";
  if (/[/\\]/.test(cleaned)) return "";
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return "";
  return cleaned;
}

function getYoutubeChannelSuggestionRequest(input: any) {
  const rawInput = String(input || "").trim();
  if (!rawInput) return { handle: "", query: "" };

  const parsed = parseYoutubeInput(rawInput);
  if (parsed?.kind === "channel") {
    return {
      handle: parsed.handle || (rawInput.startsWith("@") ? normalizeYoutubeHandle(rawInput) : ""),
      query: normalizeYoutubeChannelSuggestionQuery(parsed.query || parsed.handle || parsed.username || parsed.slug || rawInput),
    };
  }

  return {
    handle: rawInput.startsWith("@") ? normalizeYoutubeHandle(rawInput) : "",
    query: !looksLikeUrlInput(rawInput) ? normalizeYoutubeChannelSuggestionQuery(rawInput) : "",
  };
}

function clampYoutubeChannelSuggestionLimit(value: any) {
  return Math.max(1, Math.min(12, Math.round(Number(value) || 8)));
}

function getYoutubeChannelSuggestionCacheIdentity(input: any) {
  const rawInput = String(input || "").trim();
  if (!rawInput) return "";

  const { handle, query } = getYoutubeChannelSuggestionRequest(rawInput);
  if (!query) return "";
  if (rawInput.startsWith("@") && handle) return `handle-query:${handle.toLowerCase()}`;
  return `query:${normalizeSearchText(query)}`;
}

function parseYoutubeInput(input: any): ParsedYoutubeInput | null {
  const rawInput = String(input || "").trim();
  const handleOnly = normalizeYoutubeHandle(rawInput);
  if (rawInput.startsWith("@") && handleOnly) {
    return { kind: "channel", handle: handleOnly, url: `https://www.youtube.com/@${handleOnly}` };
  }

  if (!looksLikeUrlInput(rawInput)) {
    const query = normalizeYoutubeChannelSearchQuery(rawInput);
    if (query) return { kind: "channel", query, url: query };
  }

  const normalized = normalizeYoutubeUrlInput(rawInput);
  if (!normalized) return null;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const isShortHost = host === "youtu.be";
  const isYoutubeHost = host === "youtube.com" || host.endsWith(".youtube.com");
  if (!isShortHost && !isYoutubeHost) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (isShortHost) {
    const videoId = normalizeYoutubeVideoId(parts[0]);
    return videoId ? { kind: "video", videoId, url: youtubeVideoUrl(videoId) } : null;
  }

  const watchId = normalizeYoutubeVideoId(url.searchParams.get("v"));
  if (watchId) return { kind: "video", videoId: watchId, url: youtubeVideoUrl(watchId) };

  if (["shorts", "embed", "live"].includes(parts[0])) {
    const videoId = normalizeYoutubeVideoId(parts[1]);
    if (videoId) return { kind: "video", videoId, url: youtubeVideoUrl(videoId) };
  }

  if (parts[0] === "channel") {
    const channelId = normalizeYoutubeChannelId(parts[1]);
    if (channelId) return { kind: "channel", channelId, url: url.toString() };
  }

  if (parts[0]?.startsWith("@")) {
    const handle = normalizeYoutubeHandle(parts[0]);
    return handle ? { kind: "channel", handle, url: url.toString() } : null;
  }

  if (parts[0] === "user" && parts[1]) {
    return { kind: "channel", username: parts[1], url: url.toString() };
  }

  if (parts[0] === "c" && parts[1]) {
    return { kind: "channel", slug: parts[1], url: url.toString() };
  }

  return null;
}

function getYoutubeApiKey(body: any) {
  return String(
    process.env.YOUTUBE_API_KEY ||
    process.env.YOUTUBE_DATA_API_KEY ||
    ""
  ).trim();
}

function toWellFormedHeaderText(value: any) {
  const text = String(value || "");
  let output = "";

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += text[index] + text[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\uFFFD";
    } else {
      output += text[index];
    }
  }

  return output;
}

function stripHttpHeaderUnsafeText(value: any) {
  return toWellFormedHeaderText(value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function encodeHeaderValue(value: any) {
  return encodeURIComponent(stripHttpHeaderUnsafeText(value));
}

function encodeRfc5987HeaderValue(value: string) {
  return encodeURIComponent(stripHttpHeaderUnsafeText(value))
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sanitizeAsciiDownloadFileName(value: string) {
  const safeValue = stripHttpHeaderUnsafeText(value);
  const extensionMatch = /\.([a-z0-9]{2,6})$/i.exec(safeValue);
  const extension = extensionMatch ? `.${extensionMatch[1].toLowerCase()}` : "";
  const base = extension ? safeValue.slice(0, -extension.length) : safeValue;
  const asciiBase = base
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/\s+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  return `${asciiBase || "youtube-audio"}${extension}`;
}

function buildContentDispositionHeader(fileName: string) {
  const safeFileName = stripHttpHeaderUnsafeText(fileName) || "youtube-audio.webm";
  const asciiFileName = sanitizeAsciiDownloadFileName(safeFileName);
  return `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeRfc5987HeaderValue(safeFileName)}`;
}

function decodeDurationSeconds(value: any) {
  const raw = String(value || "");
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(raw);
  if (!match) return 0;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return Math.round(days * 86400 + hours * 3600 + minutes * 60 + seconds);
}

function getYoutubeResolveCachePolicy(kind: YoutubeResolvePayload["kind"]) {
  const freshMs = kind === "channel" ? YOUTUBE_CHANNEL_CACHE_FRESH_MS : YOUTUBE_VIDEO_CACHE_FRESH_MS;
  const staleMs = kind === "channel" ? YOUTUBE_CHANNEL_CACHE_STALE_MS : YOUTUBE_VIDEO_CACHE_STALE_MS;
  return { freshMs, staleMs };
}

function getYoutubeResolveApiScope(apiKey: string) {
  if (!apiKey) return "public";
  return `api:${crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}`;
}

function getYoutubeResolveIdentity(parsed: ParsedYoutubeInput) {
  if (parsed.kind === "video") return `video:${parsed.videoId}`;
  if (parsed.query) return `query:${normalizeSearchText(parsed.query)}`;
  if (parsed.channelId) return `channel-id:${parsed.channelId}`;
  if (parsed.handle) return `handle:${parsed.handle.toLowerCase()}`;
  if (parsed.username) return `username:${parsed.username.toLowerCase()}`;
  if (parsed.slug) return `slug:${parsed.slug.toLowerCase()}`;
  return `url:${parsed.url}`;
}

function getYoutubeResolveCacheKey(parsed: ParsedYoutubeInput, apiKey: string) {
  return [
    "youtube-resolve-v3",
    getYoutubeResolveApiScope(apiKey),
    encodeURIComponent(getYoutubeResolveIdentity(parsed)),
  ].join(":");
}

function getYoutubeChannelSuggestionCacheKey(input: any, apiKey: string) {
  const identity = getYoutubeChannelSuggestionCacheIdentity(input);
  if (!identity) return "";
  return [
    "youtube-channel-suggestions-v1",
    getYoutubeResolveApiScope(apiKey),
    encodeURIComponent(identity),
  ].join(":");
}

function deleteYoutubeResolveCacheEntry(key: string) {
  const existing = youtubeResolveCache.get(key);
  if (!existing) return;
  youtubeResolveCacheBytes = Math.max(0, youtubeResolveCacheBytes - existing.bytes);
  youtubeResolveCache.delete(key);
}

function deleteYoutubeChannelSuggestionCacheEntry(key: string) {
  const existing = youtubeChannelSuggestionCache.get(key);
  if (!existing) return;
  youtubeChannelSuggestionCacheBytes = Math.max(0, youtubeChannelSuggestionCacheBytes - existing.bytes);
  youtubeChannelSuggestionCache.delete(key);
}

function pruneYoutubeResolveCache() {
  const now = Date.now();
  for (const [key, entry] of youtubeResolveCache) {
    if (entry.staleUntil <= now && !youtubeResolveRefreshes.has(key)) {
      deleteYoutubeResolveCacheEntry(key);
    }
  }

  while (
    youtubeResolveCache.size > YOUTUBE_RESOLVE_CACHE_MAX_ENTRIES ||
    youtubeResolveCacheBytes > YOUTUBE_RESOLVE_CACHE_MAX_BYTES
  ) {
    const oldest = youtubeResolveCache.entries().next();
    if (oldest.done) break;
    deleteYoutubeResolveCacheEntry(oldest.value[0]);
  }
}

function pruneYoutubeChannelSuggestionCache() {
  const now = Date.now();
  for (const [key, entry] of youtubeChannelSuggestionCache) {
    if (entry.freshUntil <= now) {
      deleteYoutubeChannelSuggestionCacheEntry(key);
    }
  }

  while (
    youtubeChannelSuggestionCache.size > YOUTUBE_CHANNEL_SUGGESTION_CACHE_MAX_ENTRIES ||
    youtubeChannelSuggestionCacheBytes > YOUTUBE_CHANNEL_SUGGESTION_CACHE_MAX_BYTES
  ) {
    const oldest = youtubeChannelSuggestionCache.entries().next();
    if (oldest.done) break;
    deleteYoutubeChannelSuggestionCacheEntry(oldest.value[0]);
  }
}

function touchYoutubeResolveCacheEntry(key: string, entry: YoutubeResolveCacheEntry) {
  youtubeResolveCache.delete(key);
  youtubeResolveCache.set(key, entry);
}

function touchYoutubeChannelSuggestionCacheEntry(key: string, entry: YoutubeChannelSuggestionCacheEntry) {
  youtubeChannelSuggestionCache.delete(key);
  youtubeChannelSuggestionCache.set(key, entry);
}

function getCachedYoutubeChannelSuggestions(key: string) {
  if (!key) return null;

  pruneYoutubeChannelSuggestionCache();
  const entry = youtubeChannelSuggestionCache.get(key);
  if (!entry) return null;
  if (entry.freshUntil <= Date.now()) {
    deleteYoutubeChannelSuggestionCacheEntry(key);
    return null;
  }

  touchYoutubeChannelSuggestionCacheEntry(key, entry);
  return entry.suggestions.map((suggestion) => ({ ...suggestion }));
}

function setYoutubeChannelSuggestionCacheEntry(key: string, suggestions: YoutubeChannelSuggestionPayload[]) {
  if (!key) return;

  const snapshot = suggestions.map((suggestion) => ({ ...suggestion }));
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  deleteYoutubeChannelSuggestionCacheEntry(key);

  const now = Date.now();
  youtubeChannelSuggestionCache.set(key, {
    suggestions: snapshot,
    storedAt: now,
    freshUntil: now + YOUTUBE_CHANNEL_SUGGESTION_CACHE_FRESH_MS,
    bytes,
  });
  youtubeChannelSuggestionCacheBytes += bytes;
  pruneYoutubeChannelSuggestionCache();
}

function setYoutubeResolveCacheEntry(key: string, payload: YoutubeResolvePayload) {
  const now = Date.now();
  const policy = getYoutubeResolveCachePolicy(payload.kind);
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  deleteYoutubeResolveCacheEntry(key);

  const entry: YoutubeResolveCacheEntry = {
    payload,
    storedAt: now,
    freshUntil: now + policy.freshMs,
    staleUntil: now + policy.staleMs,
    bytes,
  };
  youtubeResolveCache.set(key, entry);
  youtubeResolveCacheBytes += bytes;
  pruneYoutubeResolveCache();
  return youtubeResolveCache.get(key) || entry;
}

function getYoutubeResolveCacheMeta(
  status: YoutubeResolveCacheStatus,
  entry: YoutubeResolveCacheEntry,
  warning = "",
): YoutubeResolveCacheMeta {
  return {
    status,
    ageSeconds: Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000)),
    maxAgeSeconds: Math.max(0, Math.floor((entry.freshUntil - entry.storedAt) / 1000)),
    staleSeconds: Math.max(0, Math.floor((entry.staleUntil - entry.storedAt) / 1000)),
    refreshedAt: new Date(entry.storedAt).toISOString(),
    ...(warning ? { warning } : {}),
  };
}

function getYoutubeResolveCacheControl(kind: YoutubeResolvePayload["kind"]) {
  const policy = getYoutubeResolveCachePolicy(kind);
  const maxAgeSeconds = Math.floor(policy.freshMs / 1000);
  const staleWhileRevalidateSeconds = Math.max(0, Math.floor((policy.staleMs - policy.freshMs) / 1000));
  return `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${staleWhileRevalidateSeconds}`;
}

function pickYoutubeThumbnail(thumbnails: any) {
  if (!thumbnails) return "";
  if (Array.isArray(thumbnails)) {
    const ranked = [...thumbnails].sort((a, b) => {
      const aScore = Number(a?.preference ?? 0) + Number(a?.width ?? 0) + Number(a?.height ?? 0);
      const bScore = Number(b?.preference ?? 0) + Number(b?.width ?? 0) + Number(b?.height ?? 0);
      return bScore - aScore;
    });
    return String(ranked.find((thumb) => thumb?.url)?.url || "");
  }

  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    if (thumbnails[key]?.url) return String(thumbnails[key].url);
  }
  return "";
}

function youtubePreviewFromApiItem(item: any): YoutubeVideoPreview | null {
  const snippet = item?.snippet || {};
  const contentDetails = item?.contentDetails || {};
  const statistics = item?.statistics || {};
  const rawVideoId = contentDetails.videoId || snippet?.resourceId?.videoId || item?.id?.videoId || item?.id;
  const videoId = normalizeYoutubeVideoId(rawVideoId);
  const title = String(snippet.title || "").trim();
  if (!videoId || !title || title === "Deleted video" || title === "Private video") return null;

  return {
    videoId,
    title,
    url: youtubeVideoUrl(videoId),
    channelId: String(snippet.videoOwnerChannelId || snippet.channelId || contentDetails.videoOwnerChannelId || ""),
    channelTitle: String(snippet.videoOwnerChannelTitle || snippet.channelTitle || ""),
    thumbnailUrl: pickYoutubeThumbnail(snippet.thumbnails),
    durationSeconds: decodeDurationSeconds(contentDetails.duration),
    publishedAt: String(contentDetails.videoPublishedAt || snippet.publishedAt || ""),
    viewCount: Math.max(0, Math.round(Number(statistics.viewCount) || 0)),
  };
}

function youtubePreviewFromYtDlpInfo(info: any, fallbackVideoId = ""): YoutubeVideoPreview {
  const videoId = normalizeYoutubeVideoId(info?.id) || fallbackVideoId;
  if (!videoId) throw new PublicError("Could not resolve that YouTube video.", 502);

  return {
    videoId,
    title: String(info?.title || info?.fulltitle || videoId),
    url: youtubeVideoUrl(videoId),
    channelId: String(info?.channel_id || info?.uploader_id || ""),
    channelTitle: String(info?.channel || info?.uploader || ""),
    thumbnailUrl: String(info?.thumbnail || pickYoutubeThumbnail(info?.thumbnails)),
    durationSeconds: Math.max(0, Math.round(Number(info?.duration) || 0)),
    publishedAt: String(info?.upload_date || info?.release_date || ""),
  };
}

function sanitizeDownloadFileBase(value: string) {
  const cleaned = decodeBasicEntities(value)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return cleaned || "youtube-audio";
}

function getYoutubeAudioExtension(info: any) {
  const candidates = [
    info?.requested_downloads?.[0]?.ext,
    info?.ext,
    info?.requested_formats?.[0]?.ext,
  ].map((value) => String(value || "").toLowerCase());
  const ext = candidates.find((value) => ["m4a", "mp4", "webm", "opus", "ogg"].includes(value));
  if (ext === "mp4") return "m4a";
  if (ext === "opus") return "webm";
  return ext || "webm";
}

function getAudioContentType(ext: string) {
  if (ext === "m4a" || ext === "mp4") return "audio/mp4";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "webm" || ext === "opus") return "audio/webm";
  return "application/octet-stream";
}

function getYoutubeDlpBinaryPath() {
  return path.join(
    process.cwd(),
    "node_modules",
    "youtube-dl-exec",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  );
}

function normalizeCookieEnvText(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.includes("\\n") && !trimmed.includes("\n")
    ? trimmed.replace(/\\r/g, "\r").replace(/\\n/g, "\n")
    : trimmed;
}

function getYoutubeCookiesText() {
  const base64Cookies = String(process.env[YOUTUBE_COOKIES_BASE64_ENV] || "").trim();
  if (base64Cookies) {
    return normalizeCookieEnvText(Buffer.from(base64Cookies.replace(/\s+/g, ""), "base64").toString("utf8"));
  }

  return normalizeCookieEnvText(String(process.env[YOUTUBE_COOKIES_ENV] || ""));
}

function hasYoutubeCookieConfiguration() {
  return Boolean(
    String(process.env[YOUTUBE_COOKIES_FILE_ENV] || "").trim() ||
    String(process.env[YOUTUBE_COOKIES_BASE64_ENV] || "").trim() ||
    String(process.env[YOUTUBE_COOKIES_ENV] || "").trim()
  );
}

function getYoutubeCookiesFilePath() {
  const configuredPath = String(process.env[YOUTUBE_COOKIES_FILE_ENV] || "").trim();
  if (configuredPath) {
    const stats = fs.statSync(configuredPath);
    const signature = crypto
      .createHash("sha256")
      .update(`${configuredPath}:${stats.size}:${stats.mtimeMs}`)
      .digest("hex");
    const filePath = path.join(os.tmpdir(), `living-sketchbook-youtube-cookies-${signature.slice(0, 12)}.txt`);
    if (
      youtubeCookiesFilePath === filePath &&
      youtubeConfiguredCookiesSource === configuredPath &&
      youtubeConfiguredCookiesMtimeMs === stats.mtimeMs &&
      fs.existsSync(filePath)
    ) {
      return filePath;
    }

    fs.copyFileSync(configuredPath, filePath);
    fs.chmodSync(filePath, 0o600);
    youtubeCookiesFilePath = filePath;
    youtubeCookiesSignature = signature;
    youtubeConfiguredCookiesSource = configuredPath;
    youtubeConfiguredCookiesMtimeMs = stats.mtimeMs;
    return filePath;
  }

  const cookieText = getYoutubeCookiesText();
  if (!cookieText) return "";

  const signature = crypto.createHash("sha256").update(cookieText).digest("hex");
  const filePath = path.join(os.tmpdir(), `living-sketchbook-youtube-cookies-${signature.slice(0, 12)}.txt`);
  if (youtubeCookiesFilePath === filePath && youtubeCookiesSignature === signature && fs.existsSync(filePath)) {
    return filePath;
  }

  fs.writeFileSync(filePath, cookieText.endsWith("\n") ? cookieText : `${cookieText}\n`, { mode: 0o600 });
  youtubeCookiesFilePath = filePath;
  youtubeCookiesSignature = signature;
  youtubeConfiguredCookiesSource = "";
  youtubeConfiguredCookiesMtimeMs = 0;
  return filePath;
}

function getYoutubeDlpAuthArgs() {
  const cookieFile = getYoutubeCookiesFilePath();
  return cookieFile ? ["--cookies", cookieFile] : [];
}

function getYoutubeDlpAuthOptions() {
  const cookieFile = getYoutubeCookiesFilePath();
  return cookieFile ? { cookies: cookieFile } : {};
}

function parseYoutubeCookieHeader(cookieText: string) {
  const cookies = new Map<string, string>();

  for (const rawLine of String(cookieText || "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_"))) continue;

    const line = trimmed.startsWith("#HttpOnly_") ? trimmed.slice("#HttpOnly_".length) : trimmed;
    const fields = line.split("\t");
    if (fields.length >= 7) {
      const domain = String(fields[0] || "").trim().toLowerCase();
      const expiresAt = Number(fields[4]);
      const name = String(fields[5] || "").trim();
      const value = fields.slice(6).join("\t").trim();
      if (!/(^|\.)youtube\.com$/i.test(domain)) continue;
      if (expiresAt && Number.isFinite(expiresAt) && expiresAt * 1000 <= Date.now()) continue;
      if (!name || /[\s;=]/.test(name) || !value) continue;
      cookies.set(name, value);
      continue;
    }

    for (const part of line.split(";")) {
      const pair = part.trim();
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name || /[\s;=]/.test(name) || !value) continue;
      cookies.set(name, value);
    }
  }

  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function getYoutubeCookieHeader() {
  if (!hasYoutubeCookieConfiguration()) return "";

  try {
    const filePath = getYoutubeCookiesFilePath();
    if (!filePath) return "";

    const stats = fs.statSync(filePath);
    const signature = `${filePath}:${stats.size}:${stats.mtimeMs}`;
    if (youtubeCookieHeaderFilePath === filePath && youtubeCookieHeaderSignature === signature) {
      return youtubeCookieHeaderValue;
    }

    youtubeCookieHeaderFilePath = filePath;
    youtubeCookieHeaderSignature = signature;
    youtubeCookieHeaderValue = parseYoutubeCookieHeader(fs.readFileSync(filePath, "utf8"));
    return youtubeCookieHeaderValue;
  } catch (error) {
    mediaLog("youtube.cookies_unavailable", { error: redactError(error) }, "warn");
    youtubeCookieHeaderFilePath = "";
    youtubeCookieHeaderSignature = "";
    youtubeCookieHeaderValue = "";
    return "";
  }
}

function isYoutubeAuthChallenge(message: string) {
  return /sign in to confirm.*not a bot|not a bot|cookies-from-browser|cookies for the authentication|blocked anonymous downloads|rejected the backend cookies/i.test(message);
}

function isYoutubeVideoUnavailable(message: string) {
  return /\bvideo unavailable\b|this video is unavailable|video is unavailable/i.test(message);
}

function makeYoutubeDlpError(error: any, fallbackMessage: string) {
  const message = redactError(error?.stderr || error?.message || error || "");
  if (isYoutubeAuthChallenge(message)) {
    return new PublicError(
      hasYoutubeCookieConfiguration()
        ? "YouTube rejected the backend cookies. Refresh YOUTUBE_COOKIES_BASE64 on Cloud Run and redeploy."
        : "YouTube blocked anonymous downloads from this backend. YOUTUBE_API_KEY can stay blank, but Cloud Run needs YOUTUBE_COOKIES_BASE64 or YOUTUBE_COOKIES_FILE for yt-dlp.",
      502
    );
  }
  if (isYoutubeVideoUnavailable(message)) {
    return new PublicError(
      hasYoutubeCookieConfiguration()
        ? "YouTube says this video is unavailable to the hosted backend. If it plays in your browser, refresh YOUTUBE_COOKIES_BASE64 on Cloud Run and redeploy."
        : "YouTube says this video is unavailable to the hosted backend. Try another video, or set YOUTUBE_COOKIES_BASE64 on Cloud Run if this video plays in your browser.",
      404
    );
  }
  return new PublicError(message || fallbackMessage, 502);
}

async function fetchYoutubeApi(resource: string, params: Record<string, any>, apiKey: string) {
  if (!apiKey) {
    throw new PublicError("Enter a YouTube Data API key, or set YOUTUBE_API_KEY on the server.", 400);
  }

  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || `YouTube request failed (${response.status}).`;
    throw new PublicError(message, response.status >= 400 && response.status < 500 ? 400 : 502);
  }
  return data;
}

async function fetchYoutubeVideoWithApi(videoId: string, apiKey: string): Promise<YoutubeVideoPreview | null> {
  if (!apiKey) return null;
  const data = await fetchYoutubeApi("videos", {
    part: "snippet,contentDetails",
    id: videoId,
    maxResults: 1,
  }, apiKey);
  return youtubePreviewFromApiItem(data?.items?.[0]);
}

async function fetchYoutubeVideoWithOEmbed(videoId: string): Promise<YoutubeVideoPreview | null> {
  const url = new URL("https://www.youtube.com/oembed");
  url.searchParams.set("url", youtubeVideoUrl(videoId));
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.8",
    },
  });
  if (!response.ok) return null;

  const data = await response.json().catch(() => null);
  const title = String(data?.title || "").trim();
  if (!title) return null;

  return {
    videoId,
    title,
    url: youtubeVideoUrl(videoId),
    channelId: "",
    channelTitle: String(data?.author_name || ""),
    thumbnailUrl: String(data?.thumbnail_url || ""),
    durationSeconds: 0,
    publishedAt: "",
  };
}

async function fetchYoutubeInfoWithYtDlp(url: string) {
  try {
    return await runYoutubeDlpJob("info", async () => (
      await youtubeDl(url, {
        ...getYoutubeDlpAuthOptions(),
        dumpSingleJson: true,
        format: YOUTUBE_AUDIO_FORMAT,
        jsRuntimes: "node",
        noPlaylist: true,
        noWarnings: true,
        quiet: true,
        skipDownload: true,
      }, { timeout: YOUTUBE_INFO_TIMEOUT_MS }) as any
    ));
  } catch (error: any) {
    if (error instanceof PublicError) throw error;
    throw makeYoutubeDlpError(error, "YouTube lookup failed.");
  }
}

async function fetchYoutubeCaptionInfoWithYtDlp(url: string, allowAutomaticCaptions: boolean) {
  try {
    return await runYoutubeDlpJob("caption-info", async () => (
      await youtubeDl(url, {
        ...getYoutubeDlpAuthOptions(),
        dumpSingleJson: true,
        format: YOUTUBE_AUDIO_FORMAT,
        jsRuntimes: "node",
        noPlaylist: true,
        noWarnings: true,
        quiet: true,
        skipDownload: true,
        ...(allowAutomaticCaptions ? { writeAutoSub: true } : {}),
        subLang: "all",
      }, { timeout: YOUTUBE_INFO_TIMEOUT_MS }) as any
    ));
  } catch (error: any) {
    if (error instanceof PublicError) throw error;
    throw makeYoutubeDlpError(error, "YouTube caption lookup failed.");
  }
}

type YoutubeCaptionTrackSource = "yt-dlp" | "innertube";

interface YoutubeCaptionTrack {
  baseUrl: string;
  languageCode: string;
  vssId: string;
  kind: string;
  name: string;
  source: YoutubeCaptionTrackSource;
  ext?: string;
  videoId?: string;
  downloadLanguageCode?: string;
}

interface YoutubeCaptionJson3Segment {
  utf8?: string;
  tOffsetMs?: number;
}

interface YoutubeCaptionJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: YoutubeCaptionJson3Segment[];
  aAppend?: number;
}

interface YoutubeCaptionJson3Transcript {
  events?: YoutubeCaptionJson3Event[];
}

interface YoutubeInnertubeCaptionTrack {
  baseUrl?: string;
  vssId?: string;
  languageCode?: string;
  kind?: string;
  name?: {
    simpleText?: string;
    runs?: Array<{ text?: string }>;
  };
}

interface YoutubeInnertubePlayerResponse {
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
  videoDetails?: {
    title?: string;
    shortDescription?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YoutubeInnertubeCaptionTrack[];
    };
  };
}

interface YoutubeInnertubeClientProfile {
  name: string;
  clientName: string;
  clientVersion: string;
  clientNameHeader: string;
  userAgent: string;
  context: Record<string, unknown>;
}

const YOUTUBE_CAPTION_INNERTUBE_ENDPOINT =
  "https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false";

const YOUTUBE_CAPTION_CLIENTS: YoutubeInnertubeClientProfile[] = [
  {
    name: "ios",
    clientName: "IOS",
    clientVersion: "20.10.4",
    clientNameHeader: "5",
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    context: {
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      platform: "MOBILE",
      osName: "iOS",
      osVersion: "18.3.2.22D82",
    },
  },
  {
    name: "android_vr",
    clientName: "ANDROID_VR",
    clientVersion: "1.62.20",
    clientNameHeader: "28",
    userAgent: "com.google.android.apps.youtube.vr.oculus/1.62.20 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    context: {
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      platform: "MOBILE",
      osName: "Android",
      osVersion: "12L",
      androidSdkVersion: 32,
    },
  },
  {
    name: "mweb",
    clientName: "MWEB",
    clientVersion: "2.20251209.01.00",
    clientNameHeader: "2",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    context: {
      platform: "MOBILE",
      osName: "iOS",
      osVersion: "17.5.1",
    },
  },
];

function normalizeYoutubeCaptionLanguage(value: any) {
  const cleaned = String(value || "")
    .trim()
    .replace(/_/g, "-")
    .toLowerCase();
  if (!cleaned || cleaned === "auto") return "";
  return cleaned.split(/[,;\s]/)[0] || "";
}

function getYoutubeCaptionCacheKey(
  videoId: string,
  language: string,
  targetLanguage = "",
  allowAutomaticCaptions = false,
) {
  return [
    "youtube-captions-json3-v3",
    videoId,
    getYoutubeCaptionPolicy(allowAutomaticCaptions),
    normalizeYoutubeCaptionLanguage(language) || "auto",
    normalizeYoutubeCaptionLanguage(targetLanguage) || "source",
  ].join(":");
}

function deleteYoutubeCaptionCacheEntry(key: string) {
  const existing = youtubeCaptionCache.get(key);
  if (!existing) return;
  youtubeCaptionCacheBytes = Math.max(0, youtubeCaptionCacheBytes - existing.bytes);
  youtubeCaptionCache.delete(key);
}

function pruneYoutubeCaptionCache() {
  const now = Date.now();
  for (const [key, entry] of youtubeCaptionCache) {
    if (entry.freshUntil <= now) deleteYoutubeCaptionCacheEntry(key);
  }

  while (
    youtubeCaptionCache.size > YOUTUBE_CAPTION_CACHE_MAX_ENTRIES ||
    youtubeCaptionCacheBytes > YOUTUBE_CAPTION_CACHE_MAX_BYTES
  ) {
    const oldest = youtubeCaptionCache.entries().next();
    if (oldest.done) break;
    deleteYoutubeCaptionCacheEntry(oldest.value[0]);
  }
}

function getCachedYoutubeCaptionPayload(key: string) {
  pruneYoutubeCaptionCache();
  const entry = youtubeCaptionCache.get(key);
  if (!entry) return null;
  if (entry.freshUntil <= Date.now()) {
    deleteYoutubeCaptionCacheEntry(key);
    return null;
  }

  youtubeCaptionCache.delete(key);
  youtubeCaptionCache.set(key, entry);
  return {
    ...entry.payload,
    segments: entry.payload.segments.map((segment) => ({ ...segment })),
  };
}

function setYoutubeCaptionCacheEntry(key: string, payload: YoutubeCaptionPayload) {
  const snapshot: YoutubeCaptionPayload = {
    ...payload,
    segments: payload.segments.map((segment) => ({ ...segment })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  deleteYoutubeCaptionCacheEntry(key);
  const now = Date.now();
  youtubeCaptionCache.set(key, {
    payload: snapshot,
    storedAt: now,
    freshUntil: now + YOUTUBE_CAPTION_CACHE_FRESH_MS,
    bytes,
  });
  youtubeCaptionCacheBytes += bytes;
  pruneYoutubeCaptionCache();
}

function decodeCaptionText(value: any) {
  return decodeBasicEntities(
    String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
      .replace(/&nbsp;/gi, " ")
  );
}

function normalizeCaptionPieceText(value: any) {
  return decodeCaptionText(stripTags(String(value || "")))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ");
}

function shouldInsertCaptionPieceSpace(leftValue: string, rightValue: string) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");
  if (!left || !right) return false;
  if (/\s$/u.test(left) || /^\s/u.test(right)) return false;
  if (/^[,.;:!?%…)\]}]/u.test(right)) return false;
  if (/^['’]/u.test(right) || /['’([{¿¡]$/u.test(left)) return false;
  return /[\p{L}\p{N}\])}.!?]$/u.test(left) && /^[\p{L}\p{N}\[]/u.test(right);
}

function addCaptionPieceSpacing(pieces: Array<{ text: string; offsetMs: number }>) {
  const spaced: Array<{ text: string; offsetMs: number }> = [];
  for (const piece of pieces) {
    const previous = spaced[spaced.length - 1];
    if (previous && shouldInsertCaptionPieceSpace(previous.text, piece.text)) {
      spaced.push({ text: " ", offsetMs: NaN });
    }
    spaced.push(piece);
  }
  return spaced;
}

function stripCaptionNonLyricCues(value: string) {
  return String(value || "")
    .replace(/[♪♫♬♩]+/g, " ")
    .replace(/(?:^|\s)(?:>{1,2}\s*)+/g, " ")
    .replace(/\[\s*(?:music|singing|applause|laughter|laughing|cheering|crowd|audience|instrumental|intro|outro|silence|noise|inaudible|humming|whistling|vocalizing|vocalising)\s*\]/gi, " ")
    .replace(/\(\s*(?:music|singing|applause|laughter|laughing|cheering|crowd|audience|instrumental|intro|outro|silence|noise|inaudible|humming|whistling|vocalizing|vocalising)\s*\)/gi, " ")
    .replace(/\s+([,.;:!?%…])/g, "$1")
    .replace(/([¿¡])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function hasNonMonotonicCaptionTimeline(characters: any[]) {
  let previousStart = Number.NEGATIVE_INFINITY;
  for (const character of characters) {
    const start = Number(character?.start);
    if (!Number.isFinite(start)) continue;
    if (start + 0.001 < previousStart) return true;
    previousStart = start;
  }
  return false;
}

function roundCaptionTime(value: number) {
  return Number(Number(value).toFixed(3));
}

function getCaptionCharWeight(char: string) {
  if (!char || /\s/u.test(char)) return 0.35;
  if (/[\p{P}\p{S}]/u.test(char)) return 0.55;
  return 1;
}

function getCaptionTextWeight(text: string) {
  return Array.from(text).reduce((total, char) => total + getCaptionCharWeight(char), 0);
}

function estimateCaptionDurationSeconds(text: string) {
  const weightedLength = getCaptionTextWeight(text);
  return Math.min(7, Math.max(0.75, weightedLength * 0.09));
}

function normalizeCaptionCharacterTimeline(items: any[]) {
  const normalized: any[] = [];
  for (const item of items) {
    const text = /\s/u.test(item.text || "") ? " " : String(item.text || "");
    if (!text) continue;
    if (text === " " && (!normalized.length || normalized[normalized.length - 1].text === " ")) continue;
    normalized.push({ ...item, text });
  }

  while (normalized[0]?.text === " ") normalized.shift();
  while (normalized[normalized.length - 1]?.text === " ") normalized.pop();

  return normalized.map((item, order) => ({
    text: item.text,
    start: roundCaptionTime(Number(item.start)),
    end: roundCaptionTime(Math.max(Number(item.end), Number(item.start) + 0.01)),
    order,
  }));
}

function distributeCaptionTextToCharacters(text: string, start: number, end: number) {
  const chars = Array.from(text);
  if (!chars.length) return [];

  const safeStart = Number.isFinite(start) ? start : 0;
  const safeEnd = Number.isFinite(end) && end > safeStart ? end : safeStart + estimateCaptionDurationSeconds(text);
  const duration = Math.max(0.05, safeEnd - safeStart);
  const totalWeight = Math.max(0.001, chars.reduce((total, char) => total + getCaptionCharWeight(char), 0));
  let cursorWeight = 0;

  return chars.map((char, order) => {
    const weight = getCaptionCharWeight(char);
    const charStart = safeStart + (duration * cursorWeight) / totalWeight;
    cursorWeight += weight;
    const charEnd = safeStart + (duration * cursorWeight) / totalWeight;
    return {
      text: char,
      start: charStart,
      end: charEnd,
      order,
    };
  });
}

function captionCharactersFromJson3Event(event: YoutubeCaptionJson3Event) {
  const rawPieces = Array.isArray(event.segs) ? event.segs : [];
  const eventStart = Math.max(0, Number(event.tStartMs || 0) / 1000);
  const normalizedPieces = rawPieces
    .map((piece) => ({
      text: normalizeCaptionPieceText(piece.utf8 || ""),
      offsetMs: Number(piece.tOffsetMs),
    }))
    .filter((piece) => piece.text);
  const pieces = addCaptionPieceSpacing(normalizedPieces);
  const rawText = pieces.map((piece) => piece.text).join("");
  const fallbackText = normalizeCaptionPieceText(rawText);
  const eventEnd = Number.isFinite(Number(event.dDurationMs)) && Number(event.dDurationMs) > 0
    ? eventStart + Number(event.dDurationMs) / 1000
    : eventStart + estimateCaptionDurationSeconds(fallbackText);

  if (!pieces.length && fallbackText) {
    return normalizeCaptionCharacterTimeline(distributeCaptionTextToCharacters(fallbackText, eventStart, eventEnd));
  }

  const totalWeight = Math.max(0.001, pieces.reduce((total, piece) => total + getCaptionTextWeight(piece.text), 0));
  let distributedWeight = 0;
  const characters: any[] = [];

  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index];
    const pieceWeight = getCaptionTextWeight(piece.text);
    const distributedStart = eventStart + ((eventEnd - eventStart) * distributedWeight) / totalWeight;
    distributedWeight += pieceWeight;
    const distributedEnd = eventStart + ((eventEnd - eventStart) * distributedWeight) / totalWeight;

    const offsetStart = Number.isFinite(piece.offsetMs)
      ? eventStart + Math.max(0, piece.offsetMs) / 1000
      : NaN;
    const nextOffsetPiece = pieces.slice(index + 1).find((candidate) => Number.isFinite(candidate.offsetMs));
    const offsetEnd = Number.isFinite(offsetStart) && nextOffsetPiece
      ? eventStart + Math.max(0, Number(nextOffsetPiece.offsetMs)) / 1000
      : NaN;

    const pieceStart = Number.isFinite(offsetStart) ? offsetStart : distributedStart;
    const pieceEnd = Number.isFinite(offsetEnd) && offsetEnd > pieceStart ? offsetEnd : distributedEnd;
    characters.push(...distributeCaptionTextToCharacters(piece.text, pieceStart, Math.max(pieceEnd, pieceStart + 0.01)));
  }

  return normalizeCaptionCharacterTimeline(characters);
}

function wordsFromCaptionCharacters(characters: any[]) {
  const words: any[] = [];
  let current: any[] = [];

  const flush = () => {
    if (!current.length) return;
    const text = current.map((item) => item.text).join("");
    const start = Number(current[0].start);
    const end = Number(current[current.length - 1].end);
    const letters = current.map((item, order) => ({
      text: item.text,
      start: item.start,
      end: item.end,
      order,
    }));
    words.push({
      word: text,
      text,
      type: "word",
      start,
      end,
      characters: letters.map((letter) => letter.text),
      letters,
    });
    current = [];
  };

  for (const character of characters) {
    if (/\s/u.test(character.text || "")) {
      flush();
      continue;
    }
    current.push(character);
  }
  flush();
  return words;
}

function captionSegmentFromCharacters(
  characters: any[],
  fallbackStart: number,
  fallbackEnd: number,
  order: number,
  track: YoutubeCaptionTrack,
) {
  const timedCharacters = characters.filter((character) => Number.isFinite(Number(character.start)) && Number.isFinite(Number(character.end)));
  const timelineStart = timedCharacters.length ? Number(timedCharacters[0].start) : fallbackStart;
  const timelineEnd = timedCharacters.length ? Number(timedCharacters[timedCharacters.length - 1].end) : fallbackEnd;
  const rawText = characters.map((character) => character.text).join("").trim();
  const cleanText = stripCaptionNonLyricCues(rawText);
  if (!hasReadableText(cleanText)) return null;

  const needsRebuiltTimeline = cleanText !== rawText || hasNonMonotonicCaptionTimeline(characters);
  const displayCharacters = needsRebuiltTimeline
    ? normalizeCaptionCharacterTimeline(distributeCaptionTextToCharacters(cleanText, timelineStart, timelineEnd))
    : characters;
  const text = displayCharacters.map((character) => character.text).join("").trim();
  if (!hasReadableText(text)) return null;

  const words = wordsFromCaptionCharacters(displayCharacters);
  const start = Number.isFinite(timelineStart) ? timelineStart : fallbackStart;
  const end = Number.isFinite(timelineEnd) ? timelineEnd : fallbackEnd;

  return {
    id: `seg-${crypto.randomUUID()}`,
    start: roundCaptionTime(start),
    end: roundCaptionTime(Math.max(end, start + 0.05)),
    primary: text,
    translation: "",
    secondary: "",
    raw: text,
    speaker: "",
    section: "",
    role: "lyric",
    kind: "lyric",
    words,
    characterTimeline: displayCharacters,
    order,
    source: "youtube-captions-json3",
    language_code: track.languageCode,
  };
}

function parseYoutubeCaptionJson3(data: YoutubeCaptionJson3Transcript, track: YoutubeCaptionTrack) {
  const events = Array.isArray(data.events) ? data.events : [];
  const segments: any[] = [];

  for (const event of events) {
    if (!Array.isArray(event.segs) || event.aAppend === 1) continue;
    const fallbackStart = Math.max(0, Number(event.tStartMs || 0) / 1000);
    const eventDuration = Math.max(0, Number(event.dDurationMs || 0) / 1000);
    const rawText = event.segs.map((piece) => piece.utf8 || "").join("");
    const fallbackEnd = eventDuration > 0
      ? fallbackStart + eventDuration
      : fallbackStart + estimateCaptionDurationSeconds(normalizeCaptionPieceText(rawText));
    const characters = captionCharactersFromJson3Event(event);
    const segment = captionSegmentFromCharacters(characters, fallbackStart, fallbackEnd, segments.length, track);
    if (segment) segments.push(segment);
  }

  return segments.map((segment, order) => ({ ...segment, order }));
}

function parseYoutubeCaptionTimestamp(value: string) {
  const match = String(value || "").trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?/);
  if (!match) return NaN;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const millis = Number(`0.${match[4] || "0"}`);
  return hours * 3600 + minutes * 60 + seconds + millis;
}

function parseYoutubeCaptionVtt(text: string, track: YoutubeCaptionTrack) {
  const clean = String(text || "").replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n/i, "").trim();
  const blocks = clean.split(/\n{2,}/);
  const segments: any[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeLineIndex < 0) continue;
    const [rawStart, rawEnd] = lines[timeLineIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const start = parseYoutubeCaptionTimestamp(rawStart);
    const end = parseYoutubeCaptionTimestamp(rawEnd);
    const body = normalizeCaptionPieceText(lines.slice(timeLineIndex + 1).join(" "));
    if (!body || !Number.isFinite(start)) continue;
    const safeEnd = Number.isFinite(end) && end > start ? end : start + estimateCaptionDurationSeconds(body);
    const characters = normalizeCaptionCharacterTimeline(distributeCaptionTextToCharacters(body, start, safeEnd));
    const segment = captionSegmentFromCharacters(characters, start, safeEnd, segments.length, track);
    if (segment) segments.push(segment);
  }

  return segments.map((segment, order) => ({ ...segment, order }));
}

function parseYoutubeCaptionXml(text: string, track: YoutubeCaptionTrack) {
  const segments: any[] = [];
  const pattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(String(text || "")))) {
    const attrs = match[1] || "";
    const body = normalizeCaptionPieceText(match[2] || "");
    if (!body) continue;
    const start = Number((attrs.match(/\bstart="([^"]+)"/i) || [])[1]);
    const duration = Number((attrs.match(/\bdur="([^"]+)"/i) || [])[1]);
    if (!Number.isFinite(start)) continue;
    const end = Number.isFinite(duration) && duration > 0 ? start + duration : start + estimateCaptionDurationSeconds(body);
    const characters = normalizeCaptionCharacterTimeline(distributeCaptionTextToCharacters(body, start, end));
    const segment = captionSegmentFromCharacters(characters, start, end, segments.length, track);
    if (segment) segments.push(segment);
  }

  return segments.map((segment, order) => ({ ...segment, order }));
}

function forceYoutubeCaptionJson3Url(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    return url.toString();
  } catch {
    return baseUrl.includes("fmt=")
      ? baseUrl.replace(/([?&])fmt=[^&]+/i, "$1fmt=json3")
      : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}fmt=json3`;
  }
}

function buildYoutubeCaptionTranslationUrl(baseUrl: string, targetLanguage: string) {
  const target = normalizeYoutubeCaptionLanguage(targetLanguage);
  if (!target) return "";

  try {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    url.searchParams.set("tlang", target);
    return url.toString();
  } catch {
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}fmt=json3&tlang=${encodeURIComponent(target)}`;
  }
}

function getYoutubeCaptionSegmentText(segment: any) {
  return String(segment?.primary || segment?.raw || segment?.text || "").trim();
}

function normalizeCaptionComparisonText(value: any) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function getYoutubeCaptionSegmentBounds(segment: any) {
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  return {
    start: Number.isFinite(start) ? start : NaN,
    end: Number.isFinite(end) ? end : NaN,
  };
}

function pickYoutubeCaptionTranslationSegment(sourceSegment: any, translatedSegments: any[], fallbackIndex: number) {
  const source = getYoutubeCaptionSegmentBounds(sourceSegment);
  if (Number.isFinite(source.start) && Number.isFinite(source.end) && source.end > source.start) {
    const sourceMid = (source.start + source.end) / 2;
    let bestSegment: any = null;
    let bestScore = 0;

    for (const candidate of translatedSegments) {
      const translatedText = getYoutubeCaptionSegmentText(candidate);
      if (!translatedText) continue;
      const target = getYoutubeCaptionSegmentBounds(candidate);
      if (!Number.isFinite(target.start) || !Number.isFinite(target.end) || target.end <= target.start) continue;

      const targetMid = (target.start + target.end) / 2;
      const overlap = Math.min(source.end, target.end) - Math.max(source.start, target.start);
      const distance = Math.abs(sourceMid - targetMid);
      const score = overlap > 0
        ? 1000 + overlap - (distance * 0.01)
        : Math.max(0, 6 - distance);
      if (score > bestScore) {
        bestScore = score;
        bestSegment = candidate;
      }
    }

    if (bestSegment) return bestSegment;
  }

  return translatedSegments[fallbackIndex];
}

function applyYoutubeCaptionTranslations(sourceSegments: any[], translatedSegments: any[]) {
  const merged = sourceSegments.map((segment) => ({ ...segment }));
  let usefulTranslations = 0;
  let translatedCount = 0;

  for (let index = 0; index < merged.length; index += 1) {
    const sourceText = getYoutubeCaptionSegmentText(merged[index]);
    const translatedSegment = pickYoutubeCaptionTranslationSegment(merged[index], translatedSegments, index);
    const translatedText = getYoutubeCaptionSegmentText(translatedSegment);
    if (!translatedText) continue;

    translatedCount += 1;
    merged[index].translation = translatedText;
    merged[index].secondary = translatedText;

    if (
      sourceText &&
      normalizeCaptionComparisonText(sourceText) !== normalizeCaptionComparisonText(translatedText)
    ) {
      usefulTranslations += 1;
    }
  }

  return {
    segments: merged,
    usefulTranslations,
    translatedCount,
  };
}

function isUsefulYoutubeCaptionTranslation(result: { usefulTranslations: number; translatedCount: number }, sourceSegmentCount: number) {
  const requiredCoverage = Math.max(1, Math.ceil(sourceSegmentCount * 0.6));
  return result.usefulTranslations > 0 && result.translatedCount >= requiredCoverage;
}

function areYoutubeCaptionLanguagesEquivalent(leftLanguage: string, rightLanguage: string) {
  const left = normalizeYoutubeCaptionLanguage(leftLanguage);
  const right = normalizeYoutubeCaptionLanguage(rightLanguage);
  if (!left || !right) return false;
  return left === right || left.split("-")[0] === right.split("-")[0];
}

function copyYoutubeCaptionSourceAsTranslation(segments: any[]) {
  return segments.map((segment) => {
    const text = getYoutubeCaptionSegmentText(segment);
    return text
      ? { ...segment, translation: text, secondary: text }
      : { ...segment };
  });
}

function getYoutubeCaptionTranslationTrackKind(track: YoutubeCaptionTrack) {
  return `${isAutomaticYoutubeCaptionTrack(track) ? "automatic" : "manual"}-translation`;
}

async function fetchYoutubeCaptionTrackTranslation(track: YoutubeCaptionTrack, targetLanguage: string) {
  const target = normalizeYoutubeCaptionLanguage(targetLanguage);
  const url = buildYoutubeCaptionTranslationUrl(track.baseUrl, target);
  if (!target || !url) return [];
  const sourceBaseLanguage = normalizeYoutubeCaptionLanguage(track.languageCode).split("-")[0];

  return await fetchYoutubeCaptionTrack({
    ...track,
    baseUrl: url,
    languageCode: target,
    downloadLanguageCode: sourceBaseLanguage && sourceBaseLanguage !== target ? `${target}-${sourceBaseLanguage}` : target,
    vssId: `${track.vssId || track.languageCode}.tlang.${target}`,
    kind: getYoutubeCaptionTranslationTrackKind(track),
    name: `${target} from ${track.name || track.languageCode || "captions"}`,
  });
}

function parseYoutubeCaptionTrackText(text: string, track: YoutubeCaptionTrack) {
  if (!text.trim()) return [];

  try {
    return parseYoutubeCaptionJson3(JSON.parse(text), track);
  } catch {}

  if (/WEBVTT/i.test(text)) {
    const vttSegments = parseYoutubeCaptionVtt(text, track);
    if (vttSegments.length) return vttSegments;
  }

  const xmlSegments = parseYoutubeCaptionXml(text, track);
  if (xmlSegments.length) return xmlSegments;
  throw new PublicError("YouTube captions were not in a readable format.", 502);
}

async function fetchYoutubeCaptionTrackDirect(track: YoutubeCaptionTrack) {
  const url = forceYoutubeCaptionJson3Url(track.baseUrl);
  const headers: Record<string, string> = {
    "User-Agent": YOUTUBE_CAPTION_CLIENTS[0].userAgent,
    "Accept-Language": "en-US,en;q=0.8",
  };
  const cookieHeader = getYoutubeCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(YOUTUBE_CAPTION_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new PublicError(`YouTube caption fetch failed (${response.status}).`, response.status >= 400 && response.status < 500 ? 404 : 502);
  }

  const text = await response.text();
  return parseYoutubeCaptionTrackText(text, track);
}

function getYoutubeCaptionTrackDownloadLanguage(track: YoutubeCaptionTrack) {
  return normalizeYoutubeCaptionLanguage(track.downloadLanguageCode || track.languageCode);
}

function shouldDownloadYoutubeCaptionAsAutomatic(track: YoutubeCaptionTrack) {
  return isAutomaticYoutubeCaptionTrack(track) || /translation/i.test(track.kind || "");
}

function getYoutubeCaptionDownloadFileScore(filePath: string) {
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName.endsWith(".json3")) return 50;
  if (fileName.endsWith(".srv3")) return 40;
  if (fileName.endsWith(".srv2")) return 35;
  if (fileName.endsWith(".srv1")) return 30;
  if (fileName.endsWith(".vtt")) return 20;
  if (fileName.endsWith(".ttml") || fileName.endsWith(".xml")) return 10;
  return 0;
}

async function fetchYoutubeCaptionTrackWithYtDlp(track: YoutubeCaptionTrack) {
  const videoId = normalizeYoutubeVideoId(track.videoId);
  const language = getYoutubeCaptionTrackDownloadLanguage(track);
  if (!videoId || !language) {
    throw new PublicError("YouTube caption file fallback needs a video id and language.", 502);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "living-sketchbook-youtube-caption-"));
  const outputTemplate = path.join(tempDir, "caption.%(ext)s");
  const args = [
    ...getYoutubeDlpAuthArgs(),
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--js-runtimes",
    "node",
    shouldDownloadYoutubeCaptionAsAutomatic(track) ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    language,
    "--sub-format",
    "json3/vtt/srv3/srv2/srv1/ttml/best",
    "--output",
    outputTemplate,
    "--",
    youtubeVideoUrl(videoId),
  ];

  try {
    await runYoutubeDlpJob("caption-file", () => new Promise<void>((resolve, reject) => {
      const child = spawn(getYoutubeDlpBinaryPath(), args, {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: YOUTUBE_CAPTION_DOWNLOAD_TIMEOUT_MS,
        windowsHide: true,
      });
      const stderrChunks: Buffer[] = [];

      child.stderr?.on("data", (chunk) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.on("error", (error) => {
        reject(makeYoutubeDlpError(error, "YouTube caption file download failed."));
      });
      child.on("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }

        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(makeYoutubeDlpError(stderr || `YouTube caption file download stopped (${signal || code}).`, "YouTube caption file download failed."));
      });
    }));

    const files = fs.readdirSync(tempDir)
      .map((fileName) => path.join(tempDir, fileName))
      .filter((filePath) => fs.statSync(filePath).isFile())
      .sort((left, right) => getYoutubeCaptionDownloadFileScore(right) - getYoutubeCaptionDownloadFileScore(left));
    const filePath = files.find((candidate) => getYoutubeCaptionDownloadFileScore(candidate) > 0);
    if (!filePath) throw new PublicError("YouTube caption file fallback did not produce a readable subtitle file.", 502);

    const text = fs.readFileSync(filePath, "utf8");
    return parseYoutubeCaptionTrackText(text, {
      ...track,
      languageCode: normalizeYoutubeCaptionLanguage(track.languageCode) || language,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function fetchYoutubeCaptionTrack(track: YoutubeCaptionTrack) {
  try {
    return await fetchYoutubeCaptionTrackDirect(track);
  } catch (error) {
    try {
      return await fetchYoutubeCaptionTrackWithYtDlp(track);
    } catch (fallbackError) {
      if (fallbackError instanceof PublicError && fallbackError.code === "youtube_backend_busy") {
        throw fallbackError;
      }
      mediaLog("youtube.caption_file_fallback_unavailable", { error: redactError(fallbackError) }, "warn");
      throw error;
    }
  }
}

function getInnertubeCaptionTrackName(track: YoutubeInnertubeCaptionTrack) {
  return String(
    track.name?.simpleText ||
    track.name?.runs?.map((run) => run.text || "").join("") ||
    track.languageCode ||
    ""
  ).trim();
}

function collectInnertubeCaptionTracks(playerData: YoutubeInnertubePlayerResponse, videoId = ""): YoutubeCaptionTrack[] {
  const rawTracks = playerData.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  return rawTracks
    .map((track): YoutubeCaptionTrack | null => {
      const baseUrl = String(track.baseUrl || "").trim();
      if (!baseUrl) return null;
      const languageCode = normalizeYoutubeCaptionLanguage(track.languageCode || track.vssId?.replace(/^a?\./, "") || "");
      return {
        baseUrl,
        languageCode,
        vssId: String(track.vssId || ""),
        kind: String(track.kind || ""),
        name: getInnertubeCaptionTrackName(track),
        source: "innertube",
        videoId,
      };
    })
    .filter((track): track is YoutubeCaptionTrack => Boolean(track));
}

function collectYtDlpCaptionTracks(info: any): YoutubeCaptionTrack[] {
  const tracks: YoutubeCaptionTrack[] = [];
  const videoId = normalizeYoutubeVideoId(info?.id);
  const groups = [
    { data: info?.subtitles, isAuto: false },
    { data: info?.automatic_captions, isAuto: true },
  ];

  for (const group of groups) {
    const data = group.data && typeof group.data === "object" ? group.data : {};
    for (const [languageCode, entries] of Object.entries(data)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const baseUrl = String((entry as any)?.url || "").trim();
        if (!baseUrl) continue;
        const ext = String((entry as any)?.ext || "").toLowerCase();
        tracks.push({
          baseUrl,
          languageCode: normalizeYoutubeCaptionLanguage(languageCode),
          vssId: `${group.isAuto ? "a." : "."}${normalizeYoutubeCaptionLanguage(languageCode)}`,
          kind: group.isAuto ? "asr" : "",
          name: String((entry as any)?.name || languageCode || "").trim(),
          source: "yt-dlp",
          ext,
          videoId,
        });
      }
    }
  }

  return tracks;
}

function isAutomaticYoutubeCaptionTrack(track: YoutubeCaptionTrack) {
  return isYoutubeAutomaticCaptionTrack(track);
}

function getYoutubeCaptionTrackFormatScore(track: YoutubeCaptionTrack) {
  const ext = String(track.ext || "").toLowerCase();
  if (ext === "json3") return 22;
  if (ext === "srv3" || ext === "srv2" || ext === "srv1") return 12;
  if (ext === "vtt") return 8;
  return 0;
}

function getYoutubeCaptionTrackLanguageScore(track: YoutubeCaptionTrack, requestedLanguage: string) {
  const requested = normalizeYoutubeCaptionLanguage(requestedLanguage);
  const language = normalizeYoutubeCaptionLanguage(track.languageCode);
  const requestedBase = requested.split("-")[0];
  const languageBase = language.split("-")[0];
  const vssId = track.vssId.toLowerCase();
  const isAutomatic = isAutomaticYoutubeCaptionTrack(track);

  if (!requested) return isAutomatic ? 80 : 130;
  if (language === requested || vssId === `.${requested}`) return isAutomatic ? 460 : 520;
  if (vssId === `a.${requested}`) return 450;
  if (languageBase && languageBase === requestedBase) return isAutomatic ? 380 : 430;
  if (requestedBase && vssId.includes(`.${requestedBase}`)) return isAutomatic ? 300 : 340;
  return 0;
}

function pickBestScoredYoutubeCaptionTrack(tracks: YoutubeCaptionTrack[], requestedLanguage: string, requireLanguageMatch: boolean) {
  return [...tracks]
    .map((track) => ({
      track,
      languageScore: getYoutubeCaptionTrackLanguageScore(track, requestedLanguage),
      formatScore: getYoutubeCaptionTrackFormatScore(track),
    }))
    .filter((candidate) => !requireLanguageMatch || candidate.languageScore > 0)
    .sort((left, right) => {
      const leftScore = left.languageScore + left.formatScore;
      const rightScore = right.languageScore + right.formatScore;
      return rightScore - leftScore;
    })[0]?.track || null;
}

function pickYoutubeCaptionTrack(
  tracks: YoutubeCaptionTrack[],
  requestedLanguage: string,
  allowAutomaticCaptions: boolean,
) {
  const candidates = filterYoutubeCaptionTracksForPolicy(
    tracks.filter((track) => track.baseUrl),
    allowAutomaticCaptions,
  );
  const requested = normalizeYoutubeCaptionLanguage(requestedLanguage);

  if (requested) {
    const requestedTrack = pickBestScoredYoutubeCaptionTrack(candidates, requested, true);
    if (requestedTrack) return requestedTrack;

    if (requested !== "en") {
      const englishTrack = pickBestScoredYoutubeCaptionTrack(candidates, "en", true);
      if (englishTrack) return englishTrack;
    }
  }

  return pickBestScoredYoutubeCaptionTrack(candidates, "", false);
}

function isYoutubeCaptionTranslationTrack(track: YoutubeCaptionTrack, targetLanguage: string) {
  return getYoutubeCaptionTrackLanguageScore(track, targetLanguage) > 0;
}

function pickYoutubeCaptionTranslationTrack(
  tracks: YoutubeCaptionTrack[],
  targetLanguage: string,
  sourceTrack: YoutubeCaptionTrack | null,
  allowAutomaticCaptions: boolean,
) {
  const target = normalizeYoutubeCaptionLanguage(targetLanguage);
  if (!target) return null;

  const sourceUrl = String(sourceTrack?.baseUrl || "");
  const candidates = filterYoutubeCaptionTracksForPolicy(
    tracks.filter((track) => (
      track.baseUrl &&
      track.baseUrl !== sourceUrl &&
      isYoutubeCaptionTranslationTrack(track, target)
    )),
    allowAutomaticCaptions,
  );

  return pickBestScoredYoutubeCaptionTrack(candidates, target, true);
}

function describeYoutubeCaptionTrackMiss(source: string, tracks: YoutubeCaptionTrack[], allowAutomaticCaptions: boolean) {
  const readableTracks = tracks.filter((track) => track.baseUrl);
  if (!readableTracks.length) return `${source}: no caption tracks`;
  if (allowAutomaticCaptions) return `${source}: no matching caption tracks`;

  const automaticCount = readableTracks.filter(isAutomaticYoutubeCaptionTrack).length;
  if (!automaticCount) return `${source}: no matching manual caption tracks`;

  const manualCount = readableTracks.length - automaticCount;
  return manualCount > 0
    ? `${source}: no matching manual caption tracks (automatic captions require opt-in)`
    : `${source}: no manual caption tracks (automatic captions require opt-in)`;
}

function assertYoutubeCaptionTrackAllowed(track: YoutubeCaptionTrack | null, allowAutomaticCaptions: boolean) {
  if (allowAutomaticCaptions || !track || !isAutomaticYoutubeCaptionTrack(track)) return;
  throw new PublicError("YouTube automatic captions require opt-in.", 404);
}

async function fetchYoutubeInnertubePlayerWithClient(videoId: string, client: YoutubeInnertubeClientProfile) {
  const body = {
    context: {
      client: {
        clientName: client.clientName,
        clientVersion: client.clientVersion,
        hl: "en",
        gl: "US",
        ...client.context,
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent": client.userAgent,
    "X-YouTube-Client-Name": client.clientNameHeader,
    "X-YouTube-Client-Version": client.clientVersion,
    Origin: "https://www.youtube.com",
  };
  const cookieHeader = getYoutubeCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;

  const response = await fetch(YOUTUBE_CAPTION_INNERTUBE_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(YOUTUBE_CAPTION_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`${client.name}: ${response.status} ${response.statusText}`);
  }

  return await response.json() as YoutubeInnertubePlayerResponse;
}

async function fetchYoutubeInnertubeCaptionTracks(videoId: string) {
  let firstPlayable: YoutubeInnertubePlayerResponse | null = null;
  const failures: string[] = [];

  for (const client of YOUTUBE_CAPTION_CLIENTS) {
    try {
      const data = await fetchYoutubeInnertubePlayerWithClient(videoId, client);
      const status = data.playabilityStatus?.status;
      if (status && status !== "OK") {
        failures.push(`${client.name}: ${status}${data.playabilityStatus?.reason ? ` - ${data.playabilityStatus.reason}` : ""}`);
        continue;
      }

      if (!firstPlayable) firstPlayable = data;
      const tracks = collectInnertubeCaptionTracks(data, videoId);
      if (tracks.length) return tracks;
      failures.push(`${client.name}: OK but no caption tracks`);
    } catch (error) {
      failures.push(`${client.name}: ${redactError(error)}`);
    }
  }

  if (firstPlayable) return [];
  throw new PublicError(`YouTube caption lookup failed. ${failures.join(" | ")}`, 502);
}

async function buildYoutubeCaptionPayloadFromTrack(
  videoId: string,
  requestedLanguage: string,
  targetLanguage: string,
  track: YoutubeCaptionTrack,
  youtubeTranslationTrack: YoutubeCaptionTrack | null,
  options: YoutubeCaptionRequestOptions,
): Promise<YoutubeCaptionPayload> {
  assertYoutubeCaptionTrackAllowed(track, options.allowAutomaticCaptions);
  assertYoutubeCaptionTrackAllowed(youtubeTranslationTrack, options.allowAutomaticCaptions);

  const segments = await fetchYoutubeCaptionTrack(track);
  if (!segments.length) {
    throw new PublicError("No readable YouTube captions are available for this video.", 404);
  }

  const requestedTargetLanguage = normalizeYoutubeCaptionLanguage(targetLanguage);
  let outputSegments = segments;
  let translationSource = "";
  let translationLanguageCode = "";
  let translationTrackKind = "";
  let translationTrackName = "";

  if (requestedTargetLanguage) {
    if (areYoutubeCaptionLanguagesEquivalent(track.languageCode, requestedTargetLanguage)) {
      outputSegments = copyYoutubeCaptionSourceAsTranslation(segments);
      translationSource = "youtube-captions-source-language-match";
      translationLanguageCode = requestedTargetLanguage;
      translationTrackKind = `${isAutomaticYoutubeCaptionTrack(track) ? "automatic" : "manual"}-source-language-match`;
      translationTrackName = track.name || `${requestedTargetLanguage} captions`;
    }

    if (!translationSource && youtubeTranslationTrack) {
      try {
        const translatedSegments = await fetchYoutubeCaptionTrack(youtubeTranslationTrack);
        const translated = applyYoutubeCaptionTranslations(segments, translatedSegments);
        if (isUsefulYoutubeCaptionTranslation(translated, segments.length)) {
          outputSegments = translated.segments;
          translationSource = "youtube-captions-timedtext";
          translationLanguageCode = requestedTargetLanguage;
          translationTrackKind = getYoutubeCaptionTranslationTrackKind(youtubeTranslationTrack);
          translationTrackName = youtubeTranslationTrack.name || `${requestedTargetLanguage} translated captions`;
        }
      } catch (error) {
        mediaLog("youtube.translated_caption_track_unavailable", { error: redactError(error) }, "warn");
      }
    }

    if (!translationSource) {
      try {
        const translatedSegments = await fetchYoutubeCaptionTrackTranslation(track, requestedTargetLanguage);
        const translated = applyYoutubeCaptionTranslations(segments, translatedSegments);
        if (isUsefulYoutubeCaptionTranslation(translated, segments.length)) {
          outputSegments = translated.segments;
          translationSource = "youtube-captions-timedtext";
          translationLanguageCode = requestedTargetLanguage;
          translationTrackKind = getYoutubeCaptionTranslationTrackKind(track);
          translationTrackName = `${requestedTargetLanguage} from ${track.name || track.languageCode || "captions"}`;
        }
      } catch (error) {
        mediaLog("youtube.caption_translation_unavailable", { error: redactError(error) }, "warn");
      }
    }
  }

  return {
    source: "youtube-captions-json3",
    transcriptionSource: "youtube-captions-json3",
    extractorSource: track.source,
    automaticCaptionsAllowed: options.allowAutomaticCaptions,
    videoId,
    requestedLanguage,
    requestedTargetLanguage,
    languageCode: track.languageCode,
    trackKind: isAutomaticYoutubeCaptionTrack(track) ? "automatic" : "manual",
    trackName: track.name,
    translationSource,
    translationLanguageCode,
    translationTrackKind,
    translationTrackName,
    generatedAt: new Date().toISOString(),
    segments: outputSegments,
  };
}

async function fetchYoutubeCaptionPayload(
  videoId: string,
  requestedLanguage: string,
  targetLanguage = "",
  options: YoutubeCaptionRequestOptions = { allowAutomaticCaptions: false },
): Promise<YoutubeCaptionPayload> {
  const language = normalizeYoutubeCaptionLanguage(requestedLanguage);
  const target = normalizeYoutubeCaptionLanguage(targetLanguage);
  const allowAutomaticCaptions = options.allowAutomaticCaptions === true;
  const cacheKey = getYoutubeCaptionCacheKey(videoId, language, target, allowAutomaticCaptions);
  const cached = getCachedYoutubeCaptionPayload(cacheKey);
  if (cached) {
    if (allowAutomaticCaptions || cached.trackKind !== "automatic") return cached;
    deleteYoutubeCaptionCacheEntry(cacheKey);
  }

  const errors: string[] = [];

  try {
    const info = await fetchYoutubeCaptionInfoWithYtDlp(youtubeVideoUrl(videoId), allowAutomaticCaptions);
    const tracks = collectYtDlpCaptionTracks(info);
    const track = pickYoutubeCaptionTrack(tracks, language, allowAutomaticCaptions);
    if (track) {
      const translationTrack = pickYoutubeCaptionTranslationTrack(tracks, target, track, allowAutomaticCaptions);
      const payload = await buildYoutubeCaptionPayloadFromTrack(
        videoId,
        language,
        target,
        track,
        translationTrack,
        { allowAutomaticCaptions },
      );
      setYoutubeCaptionCacheEntry(cacheKey, payload);
      return payload;
    }
    errors.push(describeYoutubeCaptionTrackMiss("yt-dlp", tracks, allowAutomaticCaptions));
  } catch (error) {
    errors.push(`yt-dlp: ${redactError(error)}`);
  }

  try {
    const tracks = await fetchYoutubeInnertubeCaptionTracks(videoId);
    const track = pickYoutubeCaptionTrack(tracks, language, allowAutomaticCaptions);
    if (track) {
      const translationTrack = pickYoutubeCaptionTranslationTrack(tracks, target, track, allowAutomaticCaptions);
      const payload = await buildYoutubeCaptionPayloadFromTrack(
        videoId,
        language,
        target,
        track,
        translationTrack,
        { allowAutomaticCaptions },
      );
      setYoutubeCaptionCacheEntry(cacheKey, payload);
      return payload;
    }
    errors.push(describeYoutubeCaptionTrackMiss("innertube", tracks, allowAutomaticCaptions));
  } catch (error) {
    errors.push(`innertube: ${redactError(error)}`);
  }

  if (errors.some((message) => isYoutubeAuthChallenge(message))) {
    throw new PublicError(
      hasYoutubeCookieConfiguration()
        ? "YouTube rejected the backend cookies while reading captions. Refresh YOUTUBE_COOKIES_BASE64 on Cloud Run and redeploy."
        : "YouTube blocked caption extraction from this backend. Local runs usually work; hosted backends may need YOUTUBE_COOKIES_BASE64 or a trusted outbound proxy.",
      502
    );
  }

  throw new PublicError(`No readable YouTube captions are available for this video. ${errors.join(" | ")}`, 404);
}

async function fetchYoutubeVideoPreview(videoId: string, apiKey: string): Promise<YoutubeVideoPreview> {
  if (apiKey) {
    try {
      const apiPreview = await fetchYoutubeVideoWithApi(videoId, apiKey);
      if (apiPreview) return apiPreview;
    } catch (error) {
      mediaLog("youtube.video_api_fallback_to_ytdlp", { error: redactError(error) }, "warn");
    }
  }

  if (!apiKey) {
    const fallbackPreview = await fetchYoutubeVideoWithOEmbed(videoId).catch(() => null);
    if (fallbackPreview) return fallbackPreview;
  }

  try {
    const info = await fetchYoutubeInfoWithYtDlp(youtubeVideoUrl(videoId));
    return youtubePreviewFromYtDlpInfo(info, videoId);
  } catch (error: any) {
    if (isYoutubeAuthChallenge(error?.message || error)) {
      const fallbackPreview = await fetchYoutubeVideoWithOEmbed(videoId);
      if (fallbackPreview) return fallbackPreview;
    }
    throw error;
  }
}

function normalizeSearchText(value: any) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function getSearchTokens(value: any) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreTextAgainstQuery(value: any, query: string) {
  const text = normalizeSearchText(value);
  const normalizedQuery = normalizeSearchText(query);
  if (!text || !normalizedQuery) return 0;
  if (text === normalizedQuery) return 120;
  if (text.includes(normalizedQuery)) return 84;

  const tokens = getSearchTokens(query);
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => text.includes(token)).length;
  return matched ? (matched / tokens.length) * 70 + matched * 8 : 0;
}

function parseCompactCount(value: any) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = String(value || "").trim().toLowerCase();
  if (!text) return 0;

  const match = /([\d,.]+)\s*([km])?/.exec(text);
  if (!match) return 0;

  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return 0;
  const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
  return Math.max(0, Math.round(amount * multiplier));
}

function getYoutubePublishedTime(value: any) {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d{8}$/.test(text)) {
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(4, 6)) - 1;
    const day = Number(text.slice(6, 8));
    return Date.UTC(year, month, day);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getYoutubeMusicTitleScore(title: string) {
  const normalized = title.toLowerCase();
  let score = 0;

  const positivePatterns: Array<[RegExp, number]> = [
    [/\btiny desk\b|\bthe first take\b|\ba colors show\b|\bboiler room\b|\bkexp\b|\bcercle\b|\blike a version\b|\bsofar\b|\btake away show\b/i, 32],
    [/\bofficial (music )?video\b|\bvideo oficial\b/, 28],
    [/\bofficial audio\b|\baudio oficial\b|\bvisualizer\b|\bfull audio\b/, 24],
    [/\bfull video\b|\bfull song\b|\bmusic video\b|\bsong\b/, 20],
    [/\blyric(s|al)? video\b|\blyrical\b|\bletra\b|\blyrics?\b/, 18],
    [/\blive\b|\ben vivo\b|\bdirecto\b|\bdj set\b|\bperformance\b|라이브|킬링보이스/, 16],
    [/\bacoustic\b|\bacustic[oa]\b|\bsession\b/, 9],
    [/\bremix\b|\bversion\b|\bversi[oó]n\b/, 6],
  ];
  const negativePatterns: Array<[RegExp, number]> = [
    [/\bshorts?\b|#shorts?\b/, 70],
    [/\bteaser\b|\btrailer\b|\bpreview\b|\bpromo\b|\bspot\b/, 42],
    [/\bbehind\b|\bmaking of\b|\binterview\b|\bentrevista\b|\bpodcast\b/, 44],
    [/\bvlog\b|\bchallenge\b|\breaction\b|\btutorial\b|\bannouncement\b/, 38],
    [/\brecap\b|\bcompilation\b/, 44],
    [/\bclip\b/, 12],
  ];

  for (const [pattern, weight] of positivePatterns) {
    if (pattern.test(normalized)) score += weight;
  }
  for (const [pattern, weight] of negativePatterns) {
    if (pattern.test(normalized)) score -= weight;
  }

  if (/[("-]/.test(title)) score += 3;
  return score;
}

function hasHardNonMusicTitleSignal(title: string) {
  return /\bbehind\b|\bmaking of\b|\binterview\b|\bentrevista\b|\bpodcast\b|\btrailer\b|\bteaser\b|\bpromo\b|\brecap\b|\bannouncement\b|\bvlog\b|\bchallenge\b|\btutorial\b|\breaction\b/i.test(title);
}

function scoreYoutubeChannelVideo(video: YoutubeVideoPreview, index: number) {
  const duration = Math.max(0, Math.round(Number(video.durationSeconds) || 0));
  const viewCount = Math.max(0, Math.round(Number(video.viewCount) || 0));
  const latestRank = Number.isFinite(video.latestRank) ? Number(video.latestRank) : Number.POSITIVE_INFINITY;
  const popularRank = Number.isFinite(video.popularRank) ? Number(video.popularRank) : Number.POSITIVE_INFINITY;
  const publishedAt = getYoutubePublishedTime(video.publishedAt);
  const ageDays = publishedAt ? Math.max(0, (Date.now() - publishedAt) / 86_400_000) : 0;

  const titleScore = getYoutubeMusicTitleScore(video.title);
  let score = titleScore;
  if (duration) {
    if (duration >= 90 && duration <= 540) score += 34;
    else if (duration >= 45 && duration <= 900) score += 14;
    else if (duration < 45) score -= 45;
    else if (duration > 1800) score += titleScore >= 16 ? 5 : -22;
    else if (duration > 900) score -= 18;
  }

  if (viewCount > 0) score += Math.log10(viewCount + 1) * 12;
  if (Number.isFinite(popularRank)) score += Math.max(0, 82 - popularRank * 0.55);
  if (Number.isFinite(latestRank)) score += Math.max(0, 36 - latestRank * 0.45);
  if (publishedAt) score += Math.max(0, 20 - ageDays / 14);
  if (hasHardNonMusicTitleSignal(video.title)) score -= 120;
  if (titleScore <= -18) score -= 80;
  score -= index * 0.001;
  return score;
}

function stripYoutubeChannelRanking(video: YoutubeVideoPreview): YoutubeVideoPreview {
  const { latestRank: _latestRank, popularRank: _popularRank, ...publicVideo } = video;
  return publicVideo;
}

function isUsefulPinnedYoutubeChannelVideo(video: YoutubeVideoPreview) {
  const duration = Math.max(0, Math.round(Number(video.durationSeconds) || 0));
  if (duration > 0 && duration < 40) return false;
  if (hasHardNonMusicTitleSignal(video.title)) return false;
  return getYoutubeMusicTitleScore(video.title) > 0;
}

function orderYoutubeChannelVideosForMusic(videos: YoutubeVideoPreview[]) {
  const scored = videos.map((video, index) => ({
    video,
    index,
    score: scoreYoutubeChannelVideo(video, index),
  }));
  const usefulScored = scored.filter((item) => isUsefulPinnedYoutubeChannelVideo(item.video));
  const result: YoutubeVideoPreview[] = [];
  const used = new Set<string>();

  const add = (video: YoutubeVideoPreview) => {
    if (used.has(video.videoId)) return;
    used.add(video.videoId);
    result.push(video);
  };

  const latest = [...usefulScored]
    .filter((item) => Number.isFinite(item.video.latestRank) && isUsefulPinnedYoutubeChannelVideo(item.video))
    .sort((a, b) => Number(a.video.latestRank) - Number(b.video.latestRank));
  for (const item of latest.slice(0, YOUTUBE_CHANNEL_LATEST_KEEP)) add(item.video);

  const popular = [...usefulScored]
    .filter((item) => Number.isFinite(item.video.popularRank) && isUsefulPinnedYoutubeChannelVideo(item.video))
    .sort((a, b) => Number(a.video.popularRank) - Number(b.video.popularRank));
  for (const item of popular.slice(0, YOUTUBE_CHANNEL_POPULAR_KEEP)) add(item.video);

  const ranked = [...usefulScored].sort((a, b) => b.score - a.score || a.index - b.index);
  for (const item of ranked) add(item.video);
  if (!result.length) {
    const fallbackRanked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
    for (const item of fallbackRanked) add(item.video);
  }

  return result.slice(0, YOUTUBE_CHANNEL_PREVIEW_LIMIT).map(stripYoutubeChannelRanking);
}

function youtubePreviewFromYtDlpPlaylistEntry(entry: any, playlistInfo: any): YoutubeVideoPreview | null {
  const parsed = parseYoutubeInput(entry?.webpage_url || entry?.url || entry?.id);
  const videoId = normalizeYoutubeVideoId(entry?.id) ||
    normalizeYoutubeVideoId(entry?.url) ||
    (parsed?.kind === "video" ? parsed.videoId : "");
  const title = String(entry?.title || "").trim();
  if (!videoId || !title || title === "[Deleted video]" || title === "[Private video]") return null;

  return {
    videoId,
    title,
    url: youtubeVideoUrl(videoId),
    channelId: String(entry?.channel_id || entry?.uploader_id || playlistInfo?.channel_id || playlistInfo?.uploader_id || ""),
    channelTitle: String(entry?.channel || entry?.uploader || playlistInfo?.channel || playlistInfo?.uploader || playlistInfo?.title || ""),
    thumbnailUrl: String(entry?.thumbnail || pickYoutubeThumbnail(entry?.thumbnails)),
    durationSeconds: Math.max(0, Math.round(Number(entry?.duration) || 0)),
    publishedAt: String(entry?.upload_date || entry?.release_date || ""),
    viewCount: parseCompactCount(entry?.view_count || entry?.viewCount || entry?.view_count_text || entry?.view_count_short),
  };
}

function buildYoutubeChannelVideosTabUrl(channelUrl: string, sort: "dd" | "p") {
  try {
    const url = new URL(channelUrl);
    url.hash = "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[parts.length - 1] !== "videos") {
      url.pathname = `/${[...parts, "videos"].join("/")}`;
    }
    url.search = "";
    url.searchParams.set("view", "0");
    url.searchParams.set("sort", sort);
    url.searchParams.set("flow", "grid");
    return url.toString();
  } catch {
    return channelUrl;
  }
}

async function fetchYoutubeChannelEntryPoolsWithYtDlp(channelUrl: string) {
  const latestUrl = buildYoutubeChannelVideosTabUrl(channelUrl, "dd");
  const popularUrl = buildYoutubeChannelVideosTabUrl(channelUrl, "p");
  const [latestResult, popularResult] = await Promise.allSettled([
    fetchYoutubeChannelEntriesWithYtDlp(latestUrl, YOUTUBE_CHANNEL_LATEST_SCAN_LIMIT),
    fetchYoutubeChannelEntriesWithYtDlp(popularUrl, YOUTUBE_CHANNEL_POPULAR_SCAN_LIMIT),
  ]);

  const latestEntries = latestResult.status === "fulfilled" ? latestResult.value : [];
  const popularEntries = popularResult.status === "fulfilled" ? popularResult.value : [];

  if (!latestEntries.length && !popularEntries.length) {
    const latestError = latestResult.status === "rejected" ? latestResult.reason : null;
    const popularError = popularResult.status === "rejected" ? popularResult.reason : null;
    throw latestError || popularError || new PublicError("No public videos found for that YouTube channel.", 404);
  }

  if (latestResult.status === "rejected") {
    mediaLog("youtube.channel_latest_scan_failed", { error: redactError(latestResult.reason) }, "warn");
  }
  if (popularResult.status === "rejected") {
    mediaLog("youtube.channel_popular_scan_failed", { error: redactError(popularResult.reason) }, "warn");
  }

  return { latestEntries, popularEntries };
}

function mergeYoutubeChannelEntry(
  videos: Map<string, YoutubeVideoPreview>,
  entry: any,
  rankKind: "latestRank" | "popularRank",
  rank: number,
) {
  const preview = youtubePreviewFromYtDlpPlaylistEntry(entry, entry);
  if (!preview) return;

  const existing = videos.get(preview.videoId);
  if (!existing) {
    videos.set(preview.videoId, { ...preview, [rankKind]: rank });
    return;
  }

  videos.set(preview.videoId, {
    ...existing,
    ...Object.fromEntries(Object.entries(preview).filter(([, value]) => value !== "" && value !== 0)),
    viewCount: Math.max(Number(existing.viewCount) || 0, Number(preview.viewCount) || 0),
    latestRank: Math.min(
      Number.isFinite(existing.latestRank) ? Number(existing.latestRank) : Number.POSITIVE_INFINITY,
      rankKind === "latestRank" ? rank : Number.POSITIVE_INFINITY,
    ),
    popularRank: Math.min(
      Number.isFinite(existing.popularRank) ? Number(existing.popularRank) : Number.POSITIVE_INFINITY,
      rankKind === "popularRank" ? rank : Number.POSITIVE_INFINITY,
    ),
  });
}

async function fetchYoutubeChannelWithYtDlp(channelUrl: string) {
  const { latestEntries, popularEntries } = await fetchYoutubeChannelEntryPoolsWithYtDlp(channelUrl);
  const entries = latestEntries.length ? latestEntries : popularEntries;
  const uniqueVideos = new Map<string, YoutubeVideoPreview>();

  latestEntries.forEach((entry, index) => mergeYoutubeChannelEntry(uniqueVideos, entry, "latestRank", index));
  popularEntries.forEach((entry, index) => mergeYoutubeChannelEntry(uniqueVideos, entry, "popularRank", index));

  const firstEntry = entries[0] || {};
  const firstVideo = [...uniqueVideos.values()][0];
  const channelId = normalizeYoutubeChannelId(firstEntry.playlist_channel_id || firstEntry.channel_id || firstEntry.uploader_id) ||
    normalizeYoutubeChannelId(firstVideo?.channelId) ||
    "";
  const channel: YoutubeChannelInfo = {
    channelId,
    title: String(firstEntry.playlist_channel || firstEntry.channel || firstEntry.uploader || firstEntry.playlist_uploader || "YouTube channel"),
    thumbnailUrl: String(firstEntry.channel_thumbnail || pickYoutubeThumbnail(firstEntry.thumbnails)),
    uploadsPlaylistId: "",
    url: String(firstEntry.playlist_webpage_url || channelUrl),
  };

  return { channel, videos: orderYoutubeChannelVideosForMusic([...uniqueVideos.values()]) };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getXmlText(xml: string, tagName: string) {
  const tag = escapeRegex(tagName);
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match ? decodeXmlText(match[1]) : "";
}

function getFirstXmlText(xml: string, tagNames: string[]) {
  for (const tagName of tagNames) {
    const value = getXmlText(xml, tagName);
    if (value) return value;
  }
  return "";
}

function getXmlAttribute(xml: string, tagName: string, attributeName: string) {
  const tag = escapeRegex(tagName);
  const attr = escapeRegex(attributeName);
  const tagMatch = new RegExp(`<${tag}\\b[^>]*>`, "i").exec(xml);
  if (!tagMatch) return "";
  const attrMatch = new RegExp(`${attr}=["']([^"']+)["']`, "i").exec(tagMatch[0]);
  return attrMatch ? decodeXmlText(attrMatch[1]) : "";
}

function parseYoutubeRssFeed(xml: string, channelUrl: string, fallbackChannelId = "") {
  const entryBlocks = [...String(xml || "").matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const uniqueVideos = new Map<string, YoutubeVideoPreview>();

  for (const entry of entryBlocks) {
    const videoId = normalizeYoutubeVideoId(getXmlText(entry, "yt:videoId"));
    const title = getFirstXmlText(entry, ["media:title", "title"]);
    if (!videoId || !title) continue;

    const channelId = normalizeYoutubeChannelId(getXmlText(entry, "yt:channelId")) || fallbackChannelId;
    const preview: YoutubeVideoPreview = {
      videoId,
      title,
      url: youtubeVideoUrl(videoId),
      channelId,
      channelTitle: getXmlText(entry, "name"),
      thumbnailUrl: getXmlAttribute(entry, "media:thumbnail", "url"),
      durationSeconds: 0,
      publishedAt: getXmlText(entry, "published"),
    };
    uniqueVideos.set(videoId, preview);
  }

  const firstVideo = [...uniqueVideos.values()][0];
  const rawFeedTitle = getXmlText(xml, "title");
  const channelTitle = rawFeedTitle.replace(/^YouTube videos from\s+/i, "").trim() ||
    firstVideo?.channelTitle ||
    "YouTube channel";
  const channelId = normalizeYoutubeChannelId(fallbackChannelId) || normalizeYoutubeChannelId(firstVideo?.channelId) || "";
  const channel: YoutubeChannelInfo = {
    channelId,
    title: channelTitle,
    thumbnailUrl: firstVideo?.thumbnailUrl || "",
    uploadsPlaylistId: "",
    url: channelId ? `https://www.youtube.com/channel/${channelId}` : channelUrl,
  };

  return { channel, videos: [...uniqueVideos.values()] };
}

async function fetchYoutubeChannelWithRss(parsed: Extract<ParsedYoutubeInput, { kind: "channel" }>) {
  const channelId = parsed.channelId || await scrapeYoutubeChannelId(parsed.url);
  if (!channelId) {
    throw new PublicError("Could not resolve that YouTube channel.", 404);
  }

  const feedUrl = new URL("https://www.youtube.com/feeds/videos.xml");
  feedUrl.searchParams.set("channel_id", channelId);
  const response = await fetch(feedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "en-US,en;q=0.8",
    },
  });
  if (!response.ok) {
    throw new PublicError(`YouTube channel feed failed (${response.status}).`, response.status >= 400 && response.status < 500 ? 404 : 502);
  }

  const fallback = parseYoutubeRssFeed(await response.text(), parsed.url, channelId);
  if (!fallback.videos.length) {
    throw new PublicError("No public videos found for that YouTube channel.", 404);
  }
  fallback.videos = orderYoutubeChannelVideosForMusic(
    fallback.videos.map((video, index) => ({ ...video, latestRank: index })),
  );
  return fallback;
}

function getYoutubeChannelUrlFromSearchEntry(entry: any) {
  const channelId = normalizeYoutubeChannelId(entry?.channel_id || entry?.uploader_id);
  const rawUrl = String(entry?.channel_url || entry?.uploader_url || "");
  if (rawUrl && /^https?:\/\/(?:www\.)?youtube\.com\//i.test(rawUrl)) return rawUrl;
  return channelId ? `https://www.youtube.com/channel/${channelId}` : "";
}

function getYoutubeSearchEntryChannelTitle(entry: any) {
  return String(entry?.channel || entry?.uploader || entry?.creator || "").trim();
}

function scoreYoutubeChannelSearchEntry(entry: any, query: string) {
  const channelTitle = getYoutubeSearchEntryChannelTitle(entry);
  const videoTitle = String(entry?.title || "").trim();
  const channelUrl = getYoutubeChannelUrlFromSearchEntry(entry);
  if (!channelTitle || !channelUrl) return 0;

  let score = scoreTextAgainstQuery(channelTitle, query);
  score += scoreTextAgainstQuery(videoTitle, query) * 0.25;
  score += getYoutubeMusicTitleScore(videoTitle) * 0.35;
  score += parseCompactCount(entry?.view_count || entry?.viewCount || entry?.view_count_text) > 0 ? 8 : 0;
  const duration = Math.max(0, Math.round(Number(entry?.duration) || 0));
  if (duration >= 60 && duration <= 7200) score += 10;
  if (/music|뮤직|desk|take|colors|boiler|kexp|cercle|sofar|blogotheque|blogothèque/i.test(channelTitle)) score += 14;
  if (/official|live|session|concert|performance|tiny desk|colors show|first take|boiler room|like a version|kexp|cercle|sofar|take away show/i.test(videoTitle)) score += 12;
  return score;
}

async function fetchYoutubeSearchEntriesWithYtDlp(query: string, limit = 20): Promise<any[]> {
  const searchUrl = `ytsearch${limit}:${query} youtube music channel`;
  const args = [
    ...getYoutubeDlpAuthArgs(),
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--quiet",
    "--skip-download",
    "--playlist-end",
    String(limit),
    "--",
    searchUrl,
  ];

  return runYoutubeDlpJob("channel-search", () => new Promise((resolve, reject) => {
    const child = spawn(getYoutubeDlpBinaryPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: YOUTUBE_INFO_TIMEOUT_MS,
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", (error) => {
      reject(makeYoutubeDlpError(error, "YouTube channel search failed."));
    });
    child.on("close", (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(makeYoutubeDlpError(stderr || `YouTube channel search stopped (${signal || code}).`, "YouTube channel search failed."));
        return;
      }

      const entries = Buffer.concat(stdoutChunks)
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      resolve(entries);
    });
  }));
}

async function resolveYoutubeChannelQueryWithoutApi(query: string): Promise<Extract<ParsedYoutubeInput, { kind: "channel" }>> {
  const entries = await fetchYoutubeSearchEntriesWithYtDlp(query);
  const candidates = new Map<string, { url: string; channelId: string; score: number; title: string }>();

  for (const entry of entries) {
    const url = getYoutubeChannelUrlFromSearchEntry(entry);
    const title = getYoutubeSearchEntryChannelTitle(entry);
    if (!url || !title) continue;
    const channelId = normalizeYoutubeChannelId(entry?.channel_id || entry?.uploader_id);
    const key = channelId || url;
    const score = scoreYoutubeChannelSearchEntry(entry, query);
    const existing = candidates.get(key);
    if (!existing || score > existing.score) {
      candidates.set(key, { url, channelId, score, title });
    }
  }

  const best = [...candidates.values()].sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < 35) {
    throw new PublicError("Could not resolve that YouTube channel.", 404);
  }

  return {
    kind: "channel",
    url: best.url,
    ...(best.channelId ? { channelId: best.channelId } : {}),
  };
}

async function fetchYoutubeChannelWithoutApi(parsed: Extract<ParsedYoutubeInput, { kind: "channel" }>) {
  const resolvedParsed = parsed.query ? await resolveYoutubeChannelQueryWithoutApi(parsed.query) : parsed;
  try {
    return await fetchYoutubeChannelWithYtDlp(resolvedParsed.url);
  } catch (error) {
    mediaLog("youtube.channel_ytdlp_fallback_to_rss", { error: redactError(error) }, "warn");
    return fetchYoutubeChannelWithRss(resolvedParsed);
  }
}

async function fetchYoutubeChannelEntriesWithYtDlp(channelUrl: string, limit = YOUTUBE_CHANNEL_PREVIEW_LIMIT): Promise<any[]> {
  const args = [
    ...getYoutubeDlpAuthArgs(),
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    "--quiet",
    "--skip-download",
    "--playlist-end",
    String(limit),
    "--",
    channelUrl,
  ];

  return runYoutubeDlpJob("channel-entries", () => new Promise((resolve, reject) => {
    const child = spawn(getYoutubeDlpBinaryPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: YOUTUBE_CHANNEL_FALLBACK_TIMEOUT_MS,
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", (error) => {
      reject(makeYoutubeDlpError(error, "YouTube channel lookup failed."));
    });
    child.on("close", (code, signal) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(makeYoutubeDlpError(stderr || `YouTube channel lookup stopped (${signal || code}).`, "YouTube channel lookup failed."));
        return;
      }

      const entries = Buffer.concat(stdoutChunks)
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      resolve(entries);
    });
  }));
}

async function scrapeYoutubeChannelId(channelUrl: string) {
  try {
    const response = await fetch(channelUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "en-US,en;q=0.8",
      },
    });
    if (!response.ok) return "";
    const html = await response.text();
    const match =
      /"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/.exec(html) ||
      /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[a-zA-Z0-9_-]+)["']/i.exec(html) ||
      /"externalId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/.exec(html);
    return normalizeYoutubeChannelId(match?.[1]);
  } catch {
    return "";
  }
}

function normalizeYoutubeChannelInfo(item: any): YoutubeChannelInfo | null {
  const channelId = normalizeYoutubeChannelId(item?.id);
  const uploadsPlaylistId = String(item?.contentDetails?.relatedPlaylists?.uploads || "");
  if (!channelId || !uploadsPlaylistId) return null;

  return {
    channelId,
    title: String(item?.snippet?.title || channelId),
    thumbnailUrl: pickYoutubeThumbnail(item?.snippet?.thumbnails),
    uploadsPlaylistId,
    url: `https://www.youtube.com/channel/${channelId}`,
  };
}

async function fetchYoutubeChannelByParams(params: Record<string, any>, apiKey: string) {
  const data = await fetchYoutubeApi("channels", {
    part: "snippet,contentDetails",
    maxResults: 1,
    ...params,
  }, apiKey);
  return normalizeYoutubeChannelInfo(data?.items?.[0]);
}

async function searchYoutubeChannels(input: any, apiKey: string, limit = 8): Promise<YoutubeChannelSuggestionPayload[]> {
  const { handle, query } = getYoutubeChannelSuggestionRequest(input);
  if (!query) return [];

  const safeLimit = clampYoutubeChannelSuggestionLimit(limit);
  const snapshotLimit = 12;
  const cacheKey = getYoutubeChannelSuggestionCacheKey(input, apiKey);
  const cached = getCachedYoutubeChannelSuggestions(cacheKey);
  if (cached) return cached.slice(0, safeLimit);

  const candidates = new Map<string, { suggestion: YoutubeChannelSuggestionPayload; score: number }>();
  const addCandidate = (suggestion: YoutubeChannelSuggestionPayload | null, score: number) => {
    if (!suggestion || !suggestion.title || !suggestion.url || score <= 0) return;
    const key = suggestion.channelId || suggestion.url || normalizeSearchText(suggestion.title);
    const existing = candidates.get(key);
    if (!existing || score > existing.score) {
      candidates.set(key, { suggestion, score });
    }
  };

  if (handle && apiKey) {
    for (const handleVariant of [`@${handle}`, handle]) {
      const exactChannel = await fetchYoutubeChannelByParams({ forHandle: handleVariant }, apiKey).catch(() => null);
      if (!exactChannel) continue;

      addCandidate({
        title: exactChannel.title,
        channelId: exactChannel.channelId,
        thumbnailUrl: exactChannel.thumbnailUrl,
        url: exactChannel.url,
      }, 190);
      break;
    }
  }

  if (apiKey) {
    try {
      const data = await fetchYoutubeApi("search", {
        part: "snippet",
        type: "channel",
        maxResults: Math.max(snapshotLimit * 2, 8),
        q: query,
      }, apiKey);

      for (const [index, item] of [...(data?.items || [])].entries()) {
        const channelId = normalizeYoutubeChannelId(item?.id?.channelId || item?.snippet?.channelId);
        const title = String(item?.snippet?.title || item?.snippet?.channelTitle || "").trim();
        if (!channelId || !title) continue;

        addCandidate({
          title,
          channelId,
          thumbnailUrl: pickYoutubeThumbnail(item?.snippet?.thumbnails),
          url: `https://www.youtube.com/channel/${channelId}`,
        }, scoreTextAgainstQuery(title, query) + Math.max(0, 20 - index * 2));
      }
    } catch (error) {
      mediaLog("youtube.channel_suggestion_api_fallback_to_ytdlp", { error: redactError(error) }, "warn");
    }
  }

  if (!apiKey || candidates.size < snapshotLimit) {
    try {
      const entries = await fetchYoutubeSearchEntriesWithYtDlp(query, Math.max(snapshotLimit * 3, 12));
      for (const [index, entry] of entries.entries()) {
        const url = getYoutubeChannelUrlFromSearchEntry(entry);
        const title = getYoutubeSearchEntryChannelTitle(entry);
        if (!url || !title) continue;

        addCandidate({
          title,
          channelId: normalizeYoutubeChannelId(entry?.channel_id || entry?.uploader_id),
          thumbnailUrl: pickYoutubeThumbnail(entry?.thumbnails) || String(entry?.thumbnail || ""),
          url,
        }, scoreYoutubeChannelSearchEntry(entry, query) + Math.max(0, 16 - index));
      }
    } catch (error) {
      if (!candidates.size) throw error;
      mediaLog("youtube.channel_suggestions_ytdlp_failed", { error: redactError(error) }, "warn");
    }
  }

  const suggestions = [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.suggestion.title.localeCompare(b.suggestion.title))
    .slice(0, snapshotLimit)
    .map((candidate) => candidate.suggestion);

  setYoutubeChannelSuggestionCacheEntry(cacheKey, suggestions);
  return suggestions.slice(0, safeLimit);
}

async function resolveYoutubeChannel(parsed: Extract<ParsedYoutubeInput, { kind: "channel" }>, apiKey: string) {
  if (parsed.query) {
    const data = await fetchYoutubeApi("search", {
      part: "snippet",
      type: "channel",
      maxResults: 8,
      q: parsed.query,
    }, apiKey);
    const best = [...(data?.items || [])]
      .map((item: any) => ({
        channelId: normalizeYoutubeChannelId(item?.id?.channelId),
        score: scoreTextAgainstQuery(item?.snippet?.channelTitle || item?.snippet?.title, parsed.query || ""),
      }))
      .filter((item) => item.channelId)
      .sort((a, b) => b.score - a.score)[0];
    if (best?.channelId) {
      const channel = await fetchYoutubeChannelByParams({ id: best.channelId }, apiKey);
      if (channel) return channel;
    }
  }

  if (parsed.channelId) {
    const channel = await fetchYoutubeChannelByParams({ id: parsed.channelId }, apiKey);
    if (channel) return channel;
  }

  const scrapedChannelId = await scrapeYoutubeChannelId(parsed.url);
  if (scrapedChannelId) {
    const channel = await fetchYoutubeChannelByParams({ id: scrapedChannelId }, apiKey);
    if (channel) return channel;
  }

  if (parsed.handle) {
    for (const handle of [`@${parsed.handle}`, parsed.handle]) {
      const channel = await fetchYoutubeChannelByParams({ forHandle: handle }, apiKey).catch(() => null);
      if (channel) return channel;
    }
  }

  if (parsed.username) {
    const channel = await fetchYoutubeChannelByParams({ forUsername: parsed.username }, apiKey);
    if (channel) return channel;
  }

  throw new PublicError("Could not resolve that YouTube channel.", 404);
}

async function enrichYoutubeVideosWithDurations(videos: YoutubeVideoPreview[], apiKey: string) {
  const byId = new Map<string, YoutubeVideoPreview>();

  for (let offset = 0; offset < videos.length; offset += 50) {
    const chunk = videos.slice(offset, offset + 50);
    const data = await fetchYoutubeApi("videos", {
      part: "snippet,contentDetails,statistics",
      id: chunk.map((video) => video.videoId).join(","),
      maxResults: 50,
    }, apiKey);

    for (const item of data?.items || []) {
      const preview = youtubePreviewFromApiItem(item);
      if (preview) byId.set(preview.videoId, preview);
    }
  }

  return videos.map((video) => ({ ...video, ...(byId.get(video.videoId) || {}) }));
}

async function fetchYoutubeChannelVideos(channel: YoutubeChannelInfo, apiKey: string) {
  const videos: YoutubeVideoPreview[] = [];
  let pageToken = "";

  do {
    const remaining = YOUTUBE_CHANNEL_LATEST_SCAN_LIMIT - videos.length;
    if (remaining <= 0) break;
    const data = await fetchYoutubeApi("playlistItems", {
      part: "snippet,contentDetails",
      playlistId: channel.uploadsPlaylistId,
      maxResults: Math.min(50, remaining),
      pageToken,
    }, apiKey);

    for (const item of data?.items || []) {
      const preview = youtubePreviewFromApiItem(item);
      if (preview) videos.push({ ...preview, latestRank: videos.length });
    }

    pageToken = String(data?.nextPageToken || "");
  } while (pageToken && videos.length < YOUTUBE_CHANNEL_LATEST_SCAN_LIMIT);

  return orderYoutubeChannelVideosForMusic(await enrichYoutubeVideosWithDurations(videos, apiKey));
}

async function loadYoutubeResolvePayload(parsed: ParsedYoutubeInput, apiKey: string): Promise<YoutubeResolvePayload> {
  if (parsed.kind === "video") {
    const video = await fetchYoutubeVideoPreview(parsed.videoId, apiKey);
    return {
      kind: "video",
      input: parsed.url,
      videos: [video],
    };
  }

  if (!apiKey) {
    const fallback = await fetchYoutubeChannelWithoutApi(parsed);
    return {
      kind: "channel",
      input: parsed.url,
      channel: fallback.channel,
      videos: fallback.videos.slice(0, YOUTUBE_CHANNEL_PREVIEW_LIMIT),
    };
  }

  try {
    const channel = await resolveYoutubeChannel(parsed, apiKey);
    const videos = await fetchYoutubeChannelVideos(channel, apiKey);
    return {
      kind: "channel",
      input: parsed.url,
      channel,
      videos: videos.slice(0, YOUTUBE_CHANNEL_PREVIEW_LIMIT),
    };
  } catch (error) {
    mediaLog("youtube.channel_api_fallback_to_no_key", { error: redactError(error) }, "warn");
    const fallback = await fetchYoutubeChannelWithoutApi(parsed);
    return {
      kind: "channel",
      input: parsed.url,
      channel: fallback.channel,
      videos: fallback.videos.slice(0, YOUTUBE_CHANNEL_PREVIEW_LIMIT),
    };
  }
}

function refreshYoutubeResolveCache(key: string, parsed: ParsedYoutubeInput, apiKey: string) {
  const pending = youtubeResolveRefreshes.get(key);
  if (pending) return pending;

  let refresh: Promise<YoutubeResolvePayload>;
  refresh = loadYoutubeResolvePayload(parsed, apiKey)
    .then((payload) => {
      setYoutubeResolveCacheEntry(key, payload);
      return payload;
    })
    .finally(() => {
      if (youtubeResolveRefreshes.get(key) === refresh) {
        youtubeResolveRefreshes.delete(key);
      }
    });

  youtubeResolveRefreshes.set(key, refresh);
  return refresh;
}

async function resolveYoutubeWithCache(
  parsed: ParsedYoutubeInput,
  apiKey: string,
  options: { forceRefresh?: boolean } = {},
) {
  const key = getYoutubeResolveCacheKey(parsed, apiKey);
  pruneYoutubeResolveCache();

  const now = Date.now();
  const existing = youtubeResolveCache.get(key);
  if (!options.forceRefresh && existing) {
    touchYoutubeResolveCacheEntry(key, existing);

    if (existing.freshUntil > now) {
      return {
        payload: existing.payload,
        cache: getYoutubeResolveCacheMeta("hit", existing),
      };
    }

    if (existing.staleUntil > now) {
      refreshYoutubeResolveCache(key, parsed, apiKey).catch((error) => {
        mediaLog("youtube.resolve_cache_refresh_failed", { error: redactError(error) }, "warn");
      });
      return {
        payload: existing.payload,
        cache: getYoutubeResolveCacheMeta("stale", existing),
      };
    }
  }

  try {
    const payload = await refreshYoutubeResolveCache(key, parsed, apiKey);
    const updated = youtubeResolveCache.get(key) || setYoutubeResolveCacheEntry(key, payload);
    return {
      payload,
      cache: getYoutubeResolveCacheMeta(existing ? "refresh" : "miss", updated),
    };
  } catch (error) {
    if (existing && existing.staleUntil > Date.now()) {
      return {
        payload: existing.payload,
        cache: getYoutubeResolveCacheMeta(
          "stale",
          existing,
          "Could not refresh YouTube; showing the last saved result.",
        ),
      };
    }
    throw error;
  }
}

async function createYoutubeDownloadProcess(url: string) {
  const release = await youtubeDlpLimiter.acquire("download");
  const child = spawn(getYoutubeDlpBinaryPath(), [
    ...getYoutubeDlpAuthArgs(),
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--quiet",
    "--js-runtimes",
    "node",
    "--format",
    YOUTUBE_AUDIO_FORMAT,
    "--output",
    "-",
    "--",
    url,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: YOUTUBE_DOWNLOAD_TIMEOUT_MS,
    windowsHide: true,
  });

  const releaseOnce = () => release();
  child.once("error", releaseOnce);
  child.once("close", releaseOnce);
  return child;
}

function normalizeOrigin(value: any) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

function getBearerToken(value: any) {
  const header = Array.isArray(value) ? value[0] : String(value || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function getFirebaseAdminAuthClient() {
  if (!getFirebaseAdminApps().length) {
    initializeFirebaseAdminApp();
  }
  return getFirebaseAdminAuth();
}

function getFirebaseAdminDb() {
  if (!getFirebaseAdminApps().length) {
    initializeFirebaseAdminApp();
  }
  return getFirebaseAdminFirestore();
}

async function verifyFirebaseIdToken(token: any): Promise<DecodedIdToken | null> {
  const cleaned = String(token || "").trim();
  if (!cleaned) {
    if (FIREBASE_AUTH_REQUIRED) {
      throw new PublicError("Sign in with Google before using this media service.", 401);
    }
    return null;
  }

  try {
    return await getFirebaseAdminAuthClient().verifyIdToken(cleaned);
  } catch {
    throw new PublicError("Your sign-in session could not be verified.", 401);
  }
}

async function getFirebaseUserFromHttp(req: express.Request) {
  return verifyFirebaseIdToken(getBearerToken(req.headers.authorization));
}

async function reserveElevenLabsSeconds(uid: string, rawSeconds: number, sessionId: string) {
  if (!uid) return 0;

  const reservationSeconds = Math.max(
    ELEVENLABS_MIN_RESERVATION_SECONDS,
    Math.ceil(Number(rawSeconds) || 0),
  );
  const db = getFirebaseAdminDb();
  const entitlementRef = db.collection("entitlements").doc(uid);
  const usageRef = db.collection("usage").doc(uid).collection("scribeSessions").doc(sessionId);

  await db.runTransaction(async (transaction) => {
    const entitlementSnapshot = await transaction.get(entitlementRef);
    const entitlement = entitlementSnapshot.data() || {};
    const paidSeconds = Math.max(0, Number(entitlement.elevenLabsPaidSeconds) || 0);
    const usedSeconds = Math.max(0, Number(entitlement.elevenLabsUsedSeconds) || 0);
    const reservedSeconds = Math.max(0, Number(entitlement.elevenLabsReservedSeconds) || 0);
    const remainingSeconds = paidSeconds - usedSeconds - reservedSeconds;

    if (remainingSeconds < reservationSeconds) {
      mediaLog("scribe.entitlement_insufficient", {
        uidHash: hashLogId(uid),
        sessionId,
        requestedSeconds: reservationSeconds,
        remainingSeconds,
      }, "warn");
      throw new PublicError("Buy ElevenLabs Scribe time before transcribing this audio.", 402, {
        code: "elevenlabs_entitlement_required",
      });
    }

    transaction.set(entitlementRef, {
      elevenLabsReservedSeconds: FieldValue.increment(reservationSeconds),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(usageRef, {
      status: "reserved",
      reservedSeconds: reservationSeconds,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  mediaLog("scribe.seconds_reserved", {
    uidHash: hashLogId(uid),
    sessionId,
    requestedSeconds: Math.ceil(Number(rawSeconds) || 0),
    reservedSeconds: reservationSeconds,
  });
  return reservationSeconds;
}

async function settleElevenLabsSeconds(uid: string, sessionId: string, reservedSeconds: number, rawUsedSeconds: number) {
  if (!uid || reservedSeconds <= 0) return 0;

  const usedSeconds = Math.max(1, Math.ceil(Number(rawUsedSeconds) || 0));
  const db = getFirebaseAdminDb();
  const entitlementRef = db.collection("entitlements").doc(uid);
  const usageRef = db.collection("usage").doc(uid).collection("scribeSessions").doc(sessionId);

  await db.runTransaction(async (transaction) => {
    const entitlementSnapshot = await transaction.get(entitlementRef);
    const entitlement = entitlementSnapshot.data() || {};
    const paidSeconds = Math.max(0, Number(entitlement.elevenLabsPaidSeconds) || 0);
    const currentUsedSeconds = Math.max(0, Number(entitlement.elevenLabsUsedSeconds) || 0);
    const currentReservedSeconds = Math.max(0, Number(entitlement.elevenLabsReservedSeconds) || 0);
    const unreservedRemainingSeconds = paidSeconds - currentUsedSeconds - currentReservedSeconds;
    const extraSeconds = Math.max(0, usedSeconds - reservedSeconds);

    if (extraSeconds > unreservedRemainingSeconds) {
      throw new PublicError("Buy more ElevenLabs Scribe time before saving this transcription.", 402, {
        code: "elevenlabs_entitlement_required",
      });
    }

    transaction.set(entitlementRef, {
      elevenLabsReservedSeconds: FieldValue.increment(-reservedSeconds),
      elevenLabsUsedSeconds: FieldValue.increment(usedSeconds),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(usageRef, {
      status: "settled",
      reservedSeconds,
      usedSeconds,
      settledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  mediaLog("scribe.seconds_settled", {
    uidHash: hashLogId(uid),
    sessionId,
    reservedSeconds,
    usedSeconds,
  });
  return usedSeconds;
}

async function releaseElevenLabsReservation(uid: string, sessionId: string, reservedSeconds: number, status = "released") {
  if (!uid || reservedSeconds <= 0) return;

  const db = getFirebaseAdminDb();
  const entitlementRef = db.collection("entitlements").doc(uid);
  const usageRef = db.collection("usage").doc(uid).collection("scribeSessions").doc(sessionId);

  await db.runTransaction(async (transaction) => {
    transaction.set(entitlementRef, {
      elevenLabsReservedSeconds: FieldValue.increment(-reservedSeconds),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(usageRef, {
      status,
      releasedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  mediaLog("scribe.seconds_released", {
    uidHash: hashLogId(uid),
    sessionId,
    reservedSeconds,
    status,
  });
}

function getMediaRequestId(req: express.Request) {
  const existing = String((req as any).mediaRequestId || "");
  if (existing) return existing;
  const requestId = crypto.randomUUID().slice(0, 12);
  (req as any).mediaRequestId = requestId;
  return requestId;
}

function getMediaRequestContext(req: express.Request) {
  return {
    requestId: getMediaRequestId(req),
    method: req.method,
    route: req.path,
    uidHash: hashLogId((req as any).firebaseUser?.uid),
  };
}

function bindMediaRequestLog(req: express.Request, res: express.Response, next: express.NextFunction) {
  const requestId = getMediaRequestId(req);
  const startedAt = Date.now();

  res.on("finish", () => {
    const status = res.statusCode;
    const level: MediaLogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
    mediaLog("media.http_request", {
      requestId,
      method: req.method,
      route: req.path,
      status,
      durationMs: Date.now() - startedAt,
      uidHash: hashLogId((req as any).firebaseUser?.uid),
    }, level);
  });

  next();
}

function sendMediaPublicError(
  req: express.Request,
  res: express.Response,
  error: any,
  fallback: string,
  event: string,
  details: Record<string, any> = {},
) {
  const publicError = error instanceof PublicError ? error : new PublicError(redactError(error), 502);
  mediaLog(event, {
    ...getMediaRequestContext(req),
    ...details,
    status: publicError.status,
    code: publicError.code || "",
    error: publicError.message || fallback,
  }, publicError.status >= 500 ? "error" : "warn");
  if (publicError.retryAfterSeconds) res.setHeader("Retry-After", String(publicError.retryAfterSeconds));
  res.status(publicError.status).json({ error: publicError.message || fallback });
}

function applyApiCors(req: express.Request, res: express.Response) {
  const allowedOrigin = normalizeOrigin(process.env.APP_URL);
  const requestOrigin = normalizeOrigin(req.headers.origin);

  res.setHeader(
    "Access-Control-Expose-Headers",
    [
      "Content-Disposition",
      "X-YouTube-Video-Id",
      "X-YouTube-Title",
      "X-YouTube-Channel-Id",
      "X-YouTube-Channel-Title",
      "X-YouTube-Thumbnail-Url",
      "X-YouTube-Original-Url",
      "X-YouTube-Resolve-Cache",
      "X-YouTube-Captions-Source",
    ].join(", ")
  );

  if (!allowedOrigin || !requestOrigin || requestOrigin !== allowedOrigin) {
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Client-Id, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function extractScribeText(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(extractScribeText).join("");
  if (typeof value === "object") {
    return extractScribeText(
      value.text ??
      value.word ??
      value.character ??
      value.char ??
      value.value ??
      value.grapheme ??
      value.symbol ??
      ""
    );
  }
  return "";
}

function normalizeScribeCharacter(character: any, index: number, total: number, wordStart: number, wordEnd: number) {
  const text = extractScribeText(character);
  const rawStart = Number(character?.start);
  const rawEnd = Number(character?.end);
  const hasWordTiming = Number.isFinite(wordStart) && Number.isFinite(wordEnd) && wordEnd > wordStart;
  const interpolatedStart = hasWordTiming ? wordStart + ((wordEnd - wordStart) * index) / Math.max(1, total) : NaN;
  const interpolatedEnd = hasWordTiming ? wordStart + ((wordEnd - wordStart) * (index + 1)) / Math.max(1, total) : NaN;

  return {
    text,
    start: Number.isFinite(rawStart) ? rawStart : interpolatedStart,
    end: Number.isFinite(rawEnd) ? rawEnd : interpolatedEnd,
    order: index,
  };
}

function lettersFromWord(text: string, characters: any, start: number, end: number) {
  const rawCharacters = Array.isArray(characters) && characters.length
    ? characters
    : Array.from(text);
  const letters = rawCharacters
    .map((character, index) => normalizeScribeCharacter(character, index, rawCharacters.length, start, end))
    .filter((character) => character.text);
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;

  if (letters.length) return letters;

  return Array.from(text).map((char, index, pieces) => {
    const letterStart = duration ? start + (duration * index) / pieces.length : NaN;
    const letterEnd = duration ? start + (duration * (index + 1)) / pieces.length : NaN;
    return {
      text: char,
      start: Number.isFinite(letterStart) ? letterStart : NaN,
      end: Number.isFinite(letterEnd) ? letterEnd : NaN,
      order: index,
    };
  });
}

function normalizeScribeWord(word: any) {
  const rawCharacters = Array.isArray(word?.characters) ? word.characters : [];
  const characterText = rawCharacters.map(extractScribeText).join("");
  const text = extractScribeText(word?.text ?? word?.word) || characterText;
  const start = Number(word?.start);
  const end = Number(word?.end);
  const safeStart = Number.isFinite(start) ? start : NaN;
  const safeEnd = Number.isFinite(end) ? end : NaN;
  const letters = lettersFromWord(text, rawCharacters, safeStart, safeEnd);
  const characters = letters.map((letter) => letter.text);

  return {
    word: text,
    text,
    type: word?.type || "word",
    start: safeStart,
    end: safeEnd,
    logprob: word?.logprob,
    characters,
    letters,
  };
}

function hasReadableText(value: string) {
  return /[\p{L}\p{N}]/u.test(value || "");
}

function joinScribeWords(words: any[]) {
  return words
    .map((word) => word.text || word.word || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.;:!?%…])/g, "$1")
    .replace(/([¿¡])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTimedWordsForLyrics(words: any[]) {
  const chunks: any[][] = [];

  let startIndex = 0;
  while (startIndex < words.length) {
    let bestEnd = startIndex;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let endIndex = startIndex; endIndex < words.length; endIndex += 1) {
      const chunk = words.slice(startIndex, endIndex + 1);
      const text = joinScribeWords(chunk);
      const wordCount = chunk.length;
      const duration = Number(chunk[chunk.length - 1].end) - Number(chunk[0].start);
      const next = words[endIndex + 1];
      const gapAfter = next ? Math.max(0, Number(next.start) - Number(chunk[chunk.length - 1].end)) : 0;
      const lastText = String(chunk[chunk.length - 1].text || chunk[chunk.length - 1].word || "");
      const sentenceBoundary = /[.!?]$/.test(lastText);
      const phraseBoundary = /[,;:]$/.test(lastText);

      const hardLimit =
        wordCount > MAX_SEGMENT_WORDS ||
        text.length > MAX_SEGMENT_CHARS ||
        (Number.isFinite(duration) && duration > MAX_SEGMENT_SECONDS);
      if (hardLimit && endIndex > startIndex) break;

      let score = 0;
      score += Math.min(gapAfter, 2) * 9;
      if (sentenceBoundary) score += 18;
      if (phraseBoundary) score += 8;
      if (wordCount >= MIN_SEGMENT_WORDS && wordCount <= TARGET_SEGMENT_WORDS) score += 5;
      if (text.length <= TARGET_SEGMENT_CHARS) score += 4;
      if (Number.isFinite(duration) && duration <= TARGET_SEGMENT_SECONDS) score += 3;
      if (wordCount < MIN_SEGMENT_WORDS && !sentenceBoundary && !phraseBoundary) score -= 8;
      if (wordCount > TARGET_SEGMENT_WORDS) score -= (wordCount - TARGET_SEGMENT_WORDS) * 3;
      if (text.length > TARGET_SEGMENT_CHARS) score -= (text.length - TARGET_SEGMENT_CHARS) * 0.45;
      if (Number.isFinite(duration) && duration > TARGET_SEGMENT_SECONDS) {
        score -= (duration - TARGET_SEGMENT_SECONDS) * 2;
      }
      if (!next) score += 4;

      if (score > bestScore) {
        bestScore = score;
        bestEnd = endIndex;
      }

      if (sentenceBoundary && wordCount >= MIN_SEGMENT_WORDS) break;
    }

    chunks.push(words.slice(startIndex, bestEnd + 1));
    startIndex = bestEnd + 1;
  }

  return chunks;
}

function segmentFromWords(words: any[], event: any, order: number, fallbackText = "") {
  const text = joinScribeWords(words) || fallbackText.trim();
  if (!hasReadableText(text)) return null;

  const timedItems = words.filter((word: any) => Number.isFinite(word.start) && Number.isFinite(word.end));
  const start = timedItems.length ? timedItems[0].start : 0;
  const end = timedItems.length ? timedItems[timedItems.length - 1].end : start + 0.5;

  return {
    id: `seg-${crypto.randomUUID()}`,
    start,
    end: Math.max(end, start + 0.05),
    primary: text,
    translation: "",
    secondary: "",
    raw: text,
    speaker: "",
    section: "",
    role: "lyric",
    words,
    characterTimeline: words.flatMap((word: any) => Array.isArray(word.letters) ? word.letters : []),
    order,
    source: SCRIBE_SOURCE,
    language_code: event?.language_code || "",
  };
}

function segmentsFromScribeEvent(event: any, order: number) {
  const words = Array.isArray(event?.words)
    ? event.words.map(normalizeScribeWord)
    : [];

  const timedWords = words.filter(
    (word: any) => word.type === "word" && Number.isFinite(word.start) && Number.isFinite(word.end)
  );

  const text = extractScribeText(event?.text).trim();
  if (!text && !timedWords.length) return [];

  if (!timedWords.length) {
    const segment = segmentFromWords(words, event, order, text);
    return segment ? [segment] : [];
  }

  return splitTimedWordsForLyrics(timedWords)
    .map((chunk, index) => segmentFromWords(chunk, event, order + index))
    .filter(Boolean);
}

function segmentFromScribeAudioEvent(word: any, order: number, languageCode: string) {
  const text = String(word?.text || word?.word || "").trim();
  if (!text) return null;

  const start = Number.isFinite(Number(word?.start)) ? Number(word.start) : 0;
  const end = Number.isFinite(Number(word?.end)) && Number(word.end) > start
    ? Number(word.end)
    : start + 0.35;

  return {
    id: `seg-${crypto.randomUUID()}`,
    start,
    end,
    primary: text,
    translation: "",
    secondary: "",
    raw: text,
    speaker: "",
    section: "",
    role: "audio-event",
    kind: "audio-event",
    words: [word],
    characterTimeline: Array.isArray(word?.letters) ? word.letters : [],
    order,
    source: SCRIBE_SOURCE,
    language_code: languageCode || "",
  };
}

function segmentsFromScribeResponse(response: any) {
  const languageCode = String(response?.language_code || response?.languageCode || "");
  const lyricSegments = segmentsFromScribeEvent(response, 0);
  const words = Array.isArray(response?.words)
    ? response.words.map(normalizeScribeWord)
    : [];
  const audioEventSegments = words
    .filter((word: any) => word.type && word.type !== "word" && Number.isFinite(word.start))
    .map((word: any, index: number) => segmentFromScribeAudioEvent(word, lyricSegments.length + index, languageCode))
    .filter(Boolean);

  return [...lyricSegments, ...audioEventSegments]
    .sort((left: any, right: any) => Number(left.start) - Number(right.start) || Number(left.order || 0) - Number(right.order || 0))
    .map((segment: any, order: number) => ({ ...segment, order }));
}

function getFriendlyScribeHttpError(data: any, responseText: string, status: number) {
  const detail = redactError(data?.detail || data?.message || data?.error || responseText || "");
  const normalized = detail.toLowerCase();

  if (status === 401 || status === 403 || /api key|auth|permission|forbidden|unauthorized/.test(normalized)) {
    return "ElevenLabs authentication or quota error.";
  }
  if (status === 429 || /quota|rate|resource_exhausted|too many/.test(normalized)) {
    return "ElevenLabs is busy or rate limited. Try again in a moment.";
  }
  if (/unaccepted_terms/.test(normalized)) return "ElevenLabs Scribe terms must be accepted in the ElevenLabs dashboard.";
  if (/decode|audio|file|format|multipart|input/.test(normalized) && status < 500) {
    return "Could not decode this audio file. Try MP3, WAV, M4A, FLAC, OGG, or WEBM.";
  }

  return detail || "Scribe transcription failed.";
}

async function transcribeWithScribeV2(audioBuffer: Buffer, options: {
  apiKey: string;
  fileName: string;
  mimeType: string;
  sourceLanguage: string;
  keyterms: string[];
  requestId: string;
}) {
  const form = new FormData();
  const safeFileName = path.basename(options.fileName || "audio").replace(/[^\p{L}\p{N} ._()\[\]-]+/gu, "_") || "audio";
  const mimeType = options.mimeType || getAudioContentType(path.extname(safeFileName).slice(1));

  form.append("model_id", ELEVENLABS_SCRIBE_MODEL);
  form.append("file", new Blob([audioBuffer as any], { type: mimeType }), safeFileName);
  form.append("tag_audio_events", "true");
  form.append("timestamps_granularity", "character");
  form.append("diarize", "false");
  form.append("no_verbatim", "false");
  if (options.sourceLanguage) form.append("language_code", options.sourceLanguage);
  for (const keyterm of options.keyterms.slice(0, MAX_SCRIBE_KEYTERMS)) {
    form.append("keyterms", keyterm);
  }

  scribeLog(options.requestId, "batch request started", {
    model: ELEVENLABS_SCRIBE_MODEL,
    sourceLanguage: options.sourceLanguage || "auto",
    keyterms: Math.min(options.keyterms.length, MAX_SCRIBE_KEYTERMS),
    tagAudioEvents: true,
    timestampsGranularity: "character",
  });

  const response = await fetch(ELEVENLABS_SCRIBE_ENDPOINT, {
    method: "POST",
    headers: { "xi-api-key": options.apiKey },
    body: form as any,
  });

  const responseText = await response.text();
  let data: any = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new PublicError(
      getFriendlyScribeHttpError(data, responseText, response.status),
      response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : response.status >= 400 && response.status < 500 ? 400 : 502,
    );
  }
  if (!data) throw new PublicError("ElevenLabs returned an invalid Scribe response.", 502);

  scribeLog(options.requestId, "batch request finished", {
    languageCode: data.language_code || "",
    words: Array.isArray(data.words) ? data.words.length : 0,
    textChars: String(data.text || "").length,
  });

  return data;
}

function isRetryableScribeBatchError(error: any) {
  if (!(error instanceof PublicError)) return true;
  return error.status === 429 || error.status >= 500;
}

async function transcribeWithScribeV2WithRetry(audioBuffer: Buffer, options: {
  apiKey: string;
  fileName: string;
  mimeType: string;
  sourceLanguage: string;
  keyterms: string[];
  requestId: string;
}) {
  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await transcribeWithScribeV2(audioBuffer, options);
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !isRetryableScribeBatchError(error)) throw error;
      scribeLog(options.requestId, "batch retry scheduled", {
        attempt,
        status: error instanceof PublicError ? error.status : 0,
        error: redactError(error),
      });
      await sleep(600 * attempt);
    }
  }
  throw lastError;
}

function cleanBase64Audio(value: any) {
  return String(value || "").replace(/^data:[^,]+,/, "").trim();
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
    ? `\nRetry note: the previous response was incomplete. Return every requested index, especially ${options.missingIndexes?.join(", ") || "all indexes"}.`
    : "";

  return [
    `Translate these synced song transcript segments from ${sourceLabel} to ${targetLabel}.`,
    "Use the full batch as context so short lyric fragments, pronouns, idioms, slang, and repeated hooks read naturally.",
    "Return one concise translation for every input index. Keep the original order and index numbers. Do not add commentary, markdown, HTML, transliteration notes, or extra rows. Preserve names, repeated vocalizations, and punctuation when they matter for the lyric.",
    retryNote.trim(),
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
  if (!response.ok) {
    throw makeGeminiError(data?.error?.message || data?.error || responseText || response.statusText);
  }
  if (!data) {
    throw new PublicError("Gemini returned an invalid translation response.", 502);
  }

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
  ].includes(error.code || "");
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
      if (attempt < maxAttempts) {
        await sleep(getGeminiRetryDelayMs(error, attempt));
      }
    }
  }

  throw lastError instanceof PublicError ? lastError : makeGeminiError(lastError);
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  app.set("trust proxy", 1);
  registerLocalSuno(app);

  app.use("/api", (req, res, next) => {
    applyApiCors(req, res);
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use("/api", bindMediaRequestLog);

  app.use("/api", async (req, res, next) => {
    if (!FIREBASE_AUTH_REQUIRED || req.path === "/health") {
      next();
      return;
    }

    try {
      (req as any).firebaseUser = await getFirebaseUserFromHttp(req);
      next();
    } catch (error: any) {
      const publicError = error instanceof PublicError ? error : new PublicError("Your sign-in session could not be verified.", 401);
      mediaLog("media.auth_failed", {
        ...getMediaRequestContext(req),
        status: publicError.status,
        error: publicError.message,
      }, "warn");
      res.status(publicError.status).json({ error: publicError.message });
    }
  });

  app.use(express.json({ limit: "150mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "living-sketchbook-backend",
      now: new Date().toISOString(),
    });
  });

  app.post("/api/youtube/channel-suggestions", async (req, res) => {
    try {
      const body = req.body || {};
      const suggestions = await searchYoutubeChannels(body.input, getYoutubeApiKey(body), body.limit);
      res.setHeader("Cache-Control", `private, max-age=${Math.floor(YOUTUBE_CHANNEL_SUGGESTION_CACHE_FRESH_MS / 1000)}`);
      res.json({ suggestions });
    } catch (error: any) {
      sendMediaPublicError(req, res, error, "YouTube channel suggestions failed", "youtube.channel_suggestions_error");
    }
  });

  app.post("/api/youtube/resolve", async (req, res) => {
    try {
      const body = req.body || {};
      const parsed = parseYoutubeInput(body.input);
      if (!parsed) {
        throw new PublicError("Paste a YouTube video or channel URL.", 400);
      }

      const apiKey = getYoutubeApiKey(body);
      const forceRefresh = body.forceRefresh === true || body.cache === "reload";
      const resolved = await resolveYoutubeWithCache(parsed, apiKey, { forceRefresh });
      res.setHeader("Cache-Control", getYoutubeResolveCacheControl(resolved.payload.kind));
      res.setHeader("X-YouTube-Resolve-Cache", resolved.cache.status);
      res.json({
        ...resolved.payload,
        cache: resolved.cache,
      });
    } catch (error: any) {
      sendMediaPublicError(req, res, error, "YouTube lookup failed", "youtube.resolve_error");
    }
  });

  app.post("/api/youtube/captions", async (req, res) => {
    try {
      const body = req.body || {};
      const parsed = parseYoutubeInput(body.url || body.input || body.videoId);
      const videoId = parsed?.kind === "video" ? parsed.videoId : normalizeYoutubeVideoId(body.videoId);
      if (!videoId) {
        throw new PublicError("Paste a YouTube video URL.", 400);
      }

      const language = normalizeYoutubeCaptionLanguage(body.lang || body.language || body.sourceLanguage);
      const targetLanguage = normalizeYoutubeCaptionLanguage(body.targetLanguage);
      const allowAutomaticCaptions = parseYoutubeAutomaticCaptionsOptIn(body.allowAutomaticCaptions);
      const payload = await fetchYoutubeCaptionPayload(videoId, language, targetLanguage, { allowAutomaticCaptions });
      res.setHeader("Cache-Control", `private, max-age=${Math.floor(YOUTUBE_CAPTION_CACHE_FRESH_MS / 1000)}`);
      res.setHeader("X-YouTube-Captions-Source", payload.extractorSource);
      res.setHeader("X-YouTube-Captions-Track-Kind", payload.trackKind);
      res.setHeader("X-YouTube-Captions-Automatic-Opt-In", payload.automaticCaptionsAllowed ? "true" : "false");
      res.json(payload);
    } catch (error: any) {
      sendMediaPublicError(req, res, error, "YouTube captions failed", "youtube.captions_error");
    }
  });

  app.post("/api/youtube/download", async (req, res) => {
    let child: ReturnType<typeof spawn> | null = null;

    try {
      const parsed = parseYoutubeInput(req.body?.url || req.body?.input || req.body?.videoId);
      const videoId = parsed?.kind === "video" ? parsed.videoId : normalizeYoutubeVideoId(req.body?.videoId);
      if (!videoId) {
        throw new PublicError("Paste a YouTube video URL.", 400);
      }

      const videoUrl = youtubeVideoUrl(videoId);
      const info = await fetchYoutubeInfoWithYtDlp(videoUrl);
      const preview = youtubePreviewFromYtDlpInfo(info, videoId);
      const ext = getYoutubeAudioExtension(info);
      const fileName = `${sanitizeDownloadFileBase(preview.title)}.${ext}`;
      const contentType = getAudioContentType(ext);
      let stderr = "";
      let hasStartedBody = false;
      let responseFinished = false;

      child = await createYoutubeDownloadProcess(videoUrl);
      const stopDownloadProcess = () => {
        if (child && child.exitCode == null && !child.killed) {
          child.kill();
        }
      };
      const fail = (message: string, status = 502) => {
        const safeMessage = message || "YouTube audio download failed.";
        mediaLog("youtube.download_stream_error", {
          ...getMediaRequestContext(req),
          videoId,
          status,
          error: safeMessage,
        }, status >= 500 ? "error" : "warn");
        if (res.headersSent) {
          res.destroy(new Error(safeMessage));
          return;
        }
        res.status(status).json({ error: safeMessage });
      };

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-8000);
      });

      child.stdout?.once("data", (chunk) => {
        hasStartedBody = true;
        res.status(200);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", buildContentDispositionHeader(fileName));
        res.setHeader("X-YouTube-Video-Id", encodeHeaderValue(preview.videoId));
        res.setHeader("X-YouTube-Title", encodeHeaderValue(preview.title));
        res.setHeader("X-YouTube-Channel-Id", encodeHeaderValue(preview.channelId));
        res.setHeader("X-YouTube-Channel-Title", encodeHeaderValue(preview.channelTitle));
        res.setHeader("X-YouTube-Thumbnail-Url", encodeHeaderValue(preview.thumbnailUrl));
        res.setHeader("X-YouTube-Original-Url", encodeHeaderValue(preview.url));
        res.write(chunk);
        child?.stdout?.pipe(res);
      });

      child.on("error", (error) => {
        const publicError = makeYoutubeDlpError(error, "YouTube download failed.");
        fail(publicError.message, publicError.status);
      });

      child.on("close", (code, signal) => {
        if (code === 0) {
          if (!hasStartedBody && !res.headersSent) {
            fail("YouTube did not return an audio stream.");
          }
          return;
        }

        const publicError = makeYoutubeDlpError(stderr || `YouTube download stopped (${signal || code}).`, "YouTube download failed.");
        fail(publicError.message, publicError.status);
      });

      res.on("finish", () => {
        responseFinished = true;
      });

      res.on("close", () => {
        if (!responseFinished) stopDownloadProcess();
      });

      req.on("aborted", () => {
        stopDownloadProcess();
      });
    } catch (error: any) {
      if (child && child.exitCode == null && !child.killed) child.kill();
      sendMediaPublicError(req, res, error, "YouTube download failed", "youtube.download_error");
    }
  });

  app.post("/api/elevenlabs/scribe", async (req, res) => {
    const requestId = getMediaRequestId(req);
    const firebaseUid = String((req as any).firebaseUser?.uid || "");
    let reservedElevenLabsSeconds = 0;
    let settledElevenLabsSeconds = 0;

    try {
      const apiKey = String(process.env.ELEVENLABS_API_KEY || "").trim();
      if (!apiKey) {
        throw new PublicError("Set ELEVENLABS_API_KEY on the media service before using Scribe.", 400);
      }

      const body = req.body || {};
      const audioBase64 = cleanBase64Audio(body.audioBase64);
      if (!audioBase64) throw new PublicError("No audio file was received.", 400);

      const audioBytes = Buffer.byteLength(audioBase64, "base64");
      if (audioBytes > MAX_AUDIO_BYTES) {
        throw new PublicError("Audio file is too large for this transcription route.", 413);
      }

      const estimatedDurationSeconds = Math.max(0, Number(body.estimatedDurationSeconds || body.durationSeconds) || 0);
      reservedElevenLabsSeconds = await reserveElevenLabsSeconds(firebaseUid, estimatedDurationSeconds, requestId);

      const lrclib = await resolveLrclibKeytermsForScribe(body, estimatedDurationSeconds, requestId);
      scribeLog(requestId, "keyterms prepared", {
        lrclibStatus: lrclib.metadata.status,
        keytermCount: lrclib.keyterms.length,
        selectedTrack: lrclib.metadata.selectedTrack || "",
        selectedArtist: lrclib.metadata.selectedArtist || "",
      });

      const scribeResponse = await transcribeWithScribeV2WithRetry(Buffer.from(audioBase64, "base64"), {
        apiKey,
        fileName: body.fileName || body.songName || "audio",
        mimeType: String(body.mimeType || ""),
        sourceLanguage: normalizeLanguageCode(body.sourceLanguage),
        keyterms: lrclib.keyterms,
        requestId,
      });

      const segments = segmentsFromScribeResponse(scribeResponse);
      if (!segments.length) {
        throw new PublicError("Scribe did not return lyric segments for this audio.", 502);
      }

      const segmentEndSeconds = segments.reduce((max, segment) => Math.max(max, Number(segment?.end) || 0), 0);
      const billableSeconds = Math.max(1, Math.ceil(Math.max(estimatedDurationSeconds, segmentEndSeconds)));
      settledElevenLabsSeconds = await settleElevenLabsSeconds(
        firebaseUid,
        requestId,
        reservedElevenLabsSeconds,
        billableSeconds,
      );

      res.json({
        source: SCRIBE_SOURCE,
        transcriptionSource: SCRIBE_SOURCE,
        model: ELEVENLABS_SCRIBE_MODEL,
        transcriptionRequestMode: "batch",
        languageCode: String(scribeResponse.language_code || ""),
        languageProbability: Number.isFinite(Number(scribeResponse.language_probability))
          ? Number(scribeResponse.language_probability)
          : undefined,
        streamStartSeconds: 0,
        streamEndSeconds: billableSeconds,
        keytermCount: lrclib.keyterms.length,
        lrclib: lrclib.metadata,
        billing: settledElevenLabsSeconds > 0
          ? {
            provider: "elevenlabs",
            usedSeconds: settledElevenLabsSeconds,
            reservedSeconds: reservedElevenLabsSeconds,
          }
          : undefined,
        segments,
      });
    } catch (error: any) {
      sendMediaPublicError(req, res, error, "Scribe transcription failed", "scribe.batch_error", {
        requestId,
        uidHash: hashLogId(firebaseUid),
      });
    } finally {
      if (reservedElevenLabsSeconds > 0 && settledElevenLabsSeconds <= 0) {
        await releaseElevenLabsReservation(
          firebaseUid,
          requestId,
          reservedElevenLabsSeconds,
          res.writableEnded ? "failed" : "canceled",
        ).catch((error) => {
          mediaLog("scribe.reservation_release_failed", {
            requestId,
            uidHash: hashLogId(firebaseUid),
            reservedSeconds: reservedElevenLabsSeconds,
            error: redactError(error),
          }, "error");
        });
      }
    }
  });

  app.post("/api/translate/gemini", async (req, res) => {
    try {
      const body = req.body || {};
      const targetLanguage = normalizeLanguageCode(body.targetLanguage) || "en";
      const sourceLanguage = normalizeLanguageCode(body.sourceLanguage);
      const incomingSegments = Array.isArray(body.segments) ? body.segments : [];
      const updatedSegments = incomingSegments.map((segment: any) => ({ ...segment }));
      const batches = buildGeminiTranslationBatches(updatedSegments);
      const userIdentity = getGeminiUserIdentity(req);

      if (batches.length) {
        geminiKeyPool.assertConfigured();
        const userLimitError = geminiUserRequestLimiter.consume(userIdentity, batches.length);
        if (userLimitError) throw userLimitError;
      }

      for (const batch of batches) {
        const translated = await translateGeminiBatch(batch, {
          userIdentity,
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

      res.json({
        segments: updatedSegments,
        translationSource: GEMINI_TRANSLATE_MODEL,
        translationModel: GEMINI_TRANSLATE_MODEL,
        translationRequestMode: batches.length <= 1 ? "single-request" : "chunked-for-gemini-context",
        translationBatchCount: batches.length,
      });
    } catch (error: any) {
      const publicError = error instanceof PublicError ? error : makeGeminiError(error);
      sendMediaPublicError(req, res, publicError, "Gemini translation failed", "gemini.translation_error");
    }
  });

  if (process.env.BACKEND_ONLY === "true") {
    app.get("/", (_req, res) => {
      res.type("text/plain").send("living-sketchbook-backend ok");
    });
  } else if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const httpServer = app.listen(PORT, process.env.HOST || "0.0.0.0", () => {
    mediaLog("media.server_started", {
      port: PORT,
      backendOnly: process.env.BACKEND_ONLY === "true",
      firebaseAuthRequired: FIREBASE_AUTH_REQUIRED,
    });
  });
}

startServer();
