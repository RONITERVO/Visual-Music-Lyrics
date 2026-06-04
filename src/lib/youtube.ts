/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { buildApiUrl } from "./api";
import { sanitizeFileBase } from "./utils";

export type YoutubeInputKind = "video" | "channel";

export interface YoutubeVideoPreview {
  videoId: string;
  title: string;
  url: string;
  channelId: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number;
  publishedAt: string;
}

export interface YoutubeResolveResult {
  kind: YoutubeInputKind;
  input: string;
  channel?: {
    channelId: string;
    title: string;
    thumbnailUrl: string;
    uploadsPlaylistId: string;
    url: string;
  };
  videos: YoutubeVideoPreview[];
  cache?: YoutubeResolveCacheInfo;
}

export interface YoutubeDownloadResult {
  file: File;
  video: YoutubeVideoPreview;
}

export interface YoutubeCaptionTimingResult {
  source: "youtube-captions-json3";
  transcriptionSource: "youtube-captions-json3";
  extractorSource: string;
  automaticCaptionsAllowed: boolean;
  videoId: string;
  requestedLanguage: string;
  requestedTargetLanguage: string;
  languageCode: string;
  trackKind: string;
  trackName: string;
  translationSource: string;
  translationLanguageCode: string;
  translationTrackKind: string;
  translationTrackName: string;
  generatedAt: string;
  segments: any[];
}

export interface YoutubeResolveCacheInfo {
  status: "miss" | "hit" | "stale" | "refresh";
  ageSeconds: number;
  maxAgeSeconds: number;
  staleSeconds: number;
  refreshedAt: string;
  warning?: string;
}

export interface CachedYoutubeResolve {
  result: YoutubeResolveResult;
  isFresh: boolean;
  isStale: boolean;
  ageSeconds: number;
}

export interface CachedYoutubeChannelSuggestion {
  key: string;
  title: string;
  lookupInput: string;
  url: string;
  channelId: string;
  thumbnailUrl: string;
  videoCount: number;
  matchScore: number;
  source: "cache";
  result: YoutubeResolveResult;
}

export interface YoutubeChannelSearchSuggestion {
  title: string;
  url: string;
  channelId: string;
  thumbnailUrl: string;
}

interface YoutubeResolveCacheEntry {
  result: YoutubeResolveResult;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
  bytes: number;
}

interface YoutubeChannelSuggestionCacheEntry {
  suggestions: YoutubeChannelSearchSuggestion[];
  storedAt: number;
  freshUntil: number;
  bytes: number;
}

export interface YoutubeResolveOptions {
  forceRefresh?: boolean;
  allowCache?: boolean;
}

export interface YoutubeCaptionTimingOptions {
  lang?: string;
  targetLanguage?: string;
  allowAutomaticCaptions?: boolean;
  signal?: AbortSignal;
}

const YOUTUBE_CLIENT_CACHE_MAX_ENTRIES = 48;
const YOUTUBE_CLIENT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const YOUTUBE_CLIENT_CHANNEL_SUGGESTION_CACHE_MAX_ENTRIES = 96;
const YOUTUBE_CLIENT_CHANNEL_SUGGESTION_CACHE_MAX_BYTES = 1024 * 1024;
const YOUTUBE_CLIENT_CHANNEL_SUGGESTION_CACHE_FRESH_MS = 60 * 1000;
const YOUTUBE_VIDEO_CACHE_FRESH_MS = 12 * 60 * 60 * 1000;
const YOUTUBE_VIDEO_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const YOUTUBE_CHANNEL_CACHE_FRESH_MS = 10 * 60 * 1000;
const YOUTUBE_CHANNEL_CACHE_STALE_MS = 24 * 60 * 60 * 1000;

const youtubeResolveCache = new Map<string, YoutubeResolveCacheEntry>();
let youtubeResolveCacheBytes = 0;
const youtubeChannelSuggestionCache = new Map<string, YoutubeChannelSuggestionCacheEntry>();
let youtubeChannelSuggestionCacheBytes = 0;

function normalizeYoutubeInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function isYoutubeUrlInput(value: string) {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^www\./i.test(trimmed) ||
    /^youtu\.be\//i.test(trimmed) ||
    /(^|\.)youtube\.com\//i.test(trimmed) ||
    /^@[\w.-]{3,30}$/i.test(trimmed);
}

function isYoutubeHost(host: string) {
  const normalized = host.toLowerCase();
  return normalized === "youtu.be" || normalized === "youtube.com" || normalized.endsWith(".youtube.com");
}

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

function compactSearchText(value: any) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function fingerprintText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function clampYoutubeChannelSuggestionLimit(limit: number) {
  return Math.max(1, Math.min(12, Math.round(Number(limit) || 8)));
}

function getYoutubeChannelSuggestionCacheScope(apiKey: string) {
  if (!apiKey) return "public";
  return `keyed:${fingerprintText(apiKey)}`;
}

function getYoutubeChannelSuggestionCacheIdentity(input: string) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  if (raw.startsWith("@")) {
    const handle = normalizeYoutubeHandle(raw);
    if (handle) return `handle:${handle.toLowerCase()}`;
  }

  if (!isYoutubeUrlInput(raw) && isLikelyYoutubeChannelSearch(raw)) {
    return `query:${normalizeSearchText(raw)}`;
  }

  return "";
}

function getYoutubeChannelSuggestionCacheKey(input: string, apiKey: string, limit: number) {
  const identity = getYoutubeChannelSuggestionCacheIdentity(input);
  if (!identity) return "";
  return [
    "youtube-channel-suggestions-v1",
    getYoutubeChannelSuggestionCacheScope(apiKey),
    `limit:${clampYoutubeChannelSuggestionLimit(limit)}`,
    encodeURIComponent(identity),
  ].join(":");
}

export function getYoutubeChannelSuggestionScore(query: string, values: any[]) {
  const needle = normalizeSearchText(query);
  if (needle.length < 2) return 0;

  const needleCompact = compactSearchText(query);
  const needleWords = getSearchTokens(query);
  let score = 0;

  for (const value of values) {
    const haystack = normalizeSearchText(value);
    if (!haystack) continue;

    const haystackCompact = haystack.replace(/\s+/g, "");
    if (haystack === needle) score = Math.max(score, 140);
    if (needleCompact && haystackCompact === needleCompact) score = Math.max(score, 136);
    if (haystack.startsWith(needle)) score = Math.max(score, 116);
    if (needleCompact.length >= 3 && haystackCompact.startsWith(needleCompact)) score = Math.max(score, 110);
    if (haystack.includes(needle)) score = Math.max(score, 96);
    if (needleCompact.length >= 3 && haystackCompact.includes(needleCompact)) score = Math.max(score, 90);

    if (needleWords.length) {
      const matchedWords = needleWords.filter((word) => haystack.includes(word)).length;
      if (matchedWords) {
        score = Math.max(score, 54 + (matchedWords / needleWords.length) * 34 + matchedWords * 3);
        if (matchedWords === needleWords.length && needleWords.length > 1) {
          score = Math.max(score, 84);
        }
      }
    }
  }

  return Math.round(score);
}

export function isLikelyYoutubeChannelSearch(value: string) {
  const cleaned = value.trim().replace(/^["']+|["']+$/g, "").replace(/\s+/g, " ");
  if (isYoutubeUrlInput(cleaned)) return true;
  if (cleaned.length < 3 || cleaned.length > 80) return false;
  if (/[/\\]/.test(cleaned)) return false;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.length <= 5;
}

export function getYoutubeInputKind(value: string): YoutubeInputKind | null {
  const raw = value.trim();
  if (raw.startsWith("@") && normalizeYoutubeHandle(raw)) return "channel";
  if (!isYoutubeUrlInput(raw) && isLikelyYoutubeChannelSearch(raw)) return "channel";

  const normalized = normalizeYoutubeInput(value);
  if (!normalized) return null;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  if (!isYoutubeHost(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.hostname.toLowerCase() === "youtu.be") return normalizeYoutubeVideoId(parts[0]) ? "video" : null;
  if (url.searchParams.get("v")) return normalizeYoutubeVideoId(url.searchParams.get("v")) ? "video" : null;
  if (["shorts", "embed", "live"].includes(parts[0]) && parts[1]) {
    return normalizeYoutubeVideoId(parts[1]) ? "video" : null;
  }
  if (parts[0] === "channel" && parts[1]) return normalizeYoutubeChannelId(parts[1]) ? "channel" : null;
  if (parts[0]?.startsWith("@")) return normalizeYoutubeHandle(parts[0]) ? "channel" : null;
  if ((parts[0] === "user" || parts[0] === "c") && parts[1]) return "channel";
  return null;
}

function getYoutubeResolveCachePolicy(kind: YoutubeInputKind) {
  const freshMs = kind === "channel" ? YOUTUBE_CHANNEL_CACHE_FRESH_MS : YOUTUBE_VIDEO_CACHE_FRESH_MS;
  const staleMs = kind === "channel" ? YOUTUBE_CHANNEL_CACHE_STALE_MS : YOUTUBE_VIDEO_CACHE_STALE_MS;
  return { freshMs, staleMs };
}

function getYoutubeCacheIdentity(value: string) {
  const raw = value.trim();
  if (raw.startsWith("@")) {
    const handle = normalizeYoutubeHandle(raw);
    if (handle) return `handle:${handle.toLowerCase()}`;
  }
  if (!isYoutubeUrlInput(raw) && isLikelyYoutubeChannelSearch(raw)) {
    return `query:${normalizeSearchText(raw)}`;
  }

  const normalized = normalizeYoutubeInput(value);
  if (!normalized) return "";

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return "";
  }

  if (!isYoutubeHost(url.hostname)) return "";
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "youtu.be") {
    const videoId = normalizeYoutubeVideoId(parts[0]);
    return videoId ? `video:${videoId}` : "";
  }

  const watchId = normalizeYoutubeVideoId(url.searchParams.get("v"));
  if (watchId) return `video:${watchId}`;

  if (["shorts", "embed", "live"].includes(parts[0])) {
    const videoId = normalizeYoutubeVideoId(parts[1]);
    if (videoId) return `video:${videoId}`;
  }

  if (parts[0] === "channel") {
    const channelId = normalizeYoutubeChannelId(parts[1]);
    return channelId ? `channel-id:${channelId}` : "";
  }

  if (parts[0]?.startsWith("@")) {
    const handle = normalizeYoutubeHandle(parts[0]);
    return handle ? `handle:${handle.toLowerCase()}` : "";
  }

  if ((parts[0] === "user" || parts[0] === "c") && parts[1]) {
    return `${parts[0]}:${parts[1].toLowerCase()}`;
  }

  return "";
}

function getYoutubeResolveCacheKey(input: string, apiKey: string) {
  const identity = getYoutubeCacheIdentity(input);
  if (!identity) return "";
  return ["youtube-resolve-v3", apiKey ? "keyed" : "public", encodeURIComponent(identity)].join(":");
}

function getYoutubeResolveCacheKeyForIdentity(identity: string, seedKey: string) {
  const match = seedKey.match(/^(youtube-resolve-v3:(?:keyed|public):)/);
  return match ? `${match[1]}${encodeURIComponent(identity)}` : "";
}

function makeCacheInfo(status: YoutubeResolveCacheInfo["status"], entry: YoutubeResolveCacheEntry): YoutubeResolveCacheInfo {
  return {
    status,
    ageSeconds: Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000)),
    maxAgeSeconds: Math.max(0, Math.floor((entry.freshUntil - entry.storedAt) / 1000)),
    staleSeconds: Math.max(0, Math.floor((entry.staleUntil - entry.storedAt) / 1000)),
    refreshedAt: new Date(entry.storedAt).toISOString(),
  };
}

function deleteYoutubeResolveCacheEntry(key: string) {
  const existing = youtubeResolveCache.get(key);
  if (!existing) return;
  youtubeResolveCacheBytes = Math.max(0, youtubeResolveCacheBytes - existing.bytes);
  youtubeResolveCache.delete(key);
}

function pruneYoutubeResolveCache() {
  const now = Date.now();
  for (const [key, entry] of youtubeResolveCache) {
    if (entry.staleUntil <= now) deleteYoutubeResolveCacheEntry(key);
  }

  while (
    youtubeResolveCache.size > YOUTUBE_CLIENT_CACHE_MAX_ENTRIES ||
    youtubeResolveCacheBytes > YOUTUBE_CLIENT_CACHE_MAX_BYTES
  ) {
    const oldest = youtubeResolveCache.entries().next();
    if (oldest.done) break;
    deleteYoutubeResolveCacheEntry(oldest.value[0]);
  }
}

function deleteYoutubeChannelSuggestionCacheEntry(key: string) {
  const existing = youtubeChannelSuggestionCache.get(key);
  if (!existing) return;
  youtubeChannelSuggestionCacheBytes = Math.max(0, youtubeChannelSuggestionCacheBytes - existing.bytes);
  youtubeChannelSuggestionCache.delete(key);
}

function pruneYoutubeChannelSuggestionCache() {
  const now = Date.now();
  for (const [key, entry] of youtubeChannelSuggestionCache) {
    if (entry.freshUntil <= now) deleteYoutubeChannelSuggestionCacheEntry(key);
  }

  while (
    youtubeChannelSuggestionCache.size > YOUTUBE_CLIENT_CHANNEL_SUGGESTION_CACHE_MAX_ENTRIES ||
    youtubeChannelSuggestionCacheBytes > YOUTUBE_CLIENT_CHANNEL_SUGGESTION_CACHE_MAX_BYTES
  ) {
    const oldest = youtubeChannelSuggestionCache.entries().next();
    if (oldest.done) break;
    deleteYoutubeChannelSuggestionCacheEntry(oldest.value[0]);
  }
}

function setCachedYoutubeChannelSuggestions(key: string, suggestions: YoutubeChannelSearchSuggestion[]) {
  if (!key) return;

  const snapshot = suggestions.map((suggestion) => ({ ...suggestion }));
  const bytes = JSON.stringify(snapshot).length * 2;
  deleteYoutubeChannelSuggestionCacheEntry(key);

  const now = Date.now();
  youtubeChannelSuggestionCache.set(key, {
    suggestions: snapshot,
    storedAt: now,
    freshUntil: now + YOUTUBE_CLIENT_CHANNEL_SUGGESTION_CACHE_FRESH_MS,
    bytes,
  });
  youtubeChannelSuggestionCacheBytes += bytes;
  pruneYoutubeChannelSuggestionCache();
}

function cacheableYoutubeResolve(result: YoutubeResolveResult): YoutubeResolveResult {
  return {
    kind: result.kind,
    input: result.input,
    ...(result.channel ? { channel: { ...result.channel } } : {}),
    videos: result.videos.map((video) => ({ ...video })),
  };
}

function setCachedYoutubeResolveEntry(key: string, result: YoutubeResolveResult) {
  if (!key) return;
  const cacheable = cacheableYoutubeResolve(result);
  const policy = getYoutubeResolveCachePolicy(cacheable.kind);
  const serverStoredAt = Date.parse(result.cache?.refreshedAt || "");
  const now = Date.now();
  const storedAt = Number.isFinite(serverStoredAt) && serverStoredAt > 0 ? Math.min(serverStoredAt, now) : now;
  const freshMs = result.cache?.maxAgeSeconds ? result.cache.maxAgeSeconds * 1000 : policy.freshMs;
  const staleMs = result.cache?.staleSeconds ? result.cache.staleSeconds * 1000 : policy.staleMs;
  const bytes = JSON.stringify(cacheable).length * 2;

  deleteYoutubeResolveCacheEntry(key);
  const entry: YoutubeResolveCacheEntry = {
    result: cacheable,
    storedAt,
    freshUntil: storedAt + freshMs,
    staleUntil: storedAt + staleMs,
    bytes,
  };
  youtubeResolveCache.set(key, entry);
  youtubeResolveCacheBytes += bytes;
  pruneYoutubeResolveCache();
}

function setCachedYoutubeResolve(key: string, result: YoutubeResolveResult) {
  setCachedYoutubeResolveEntry(key, result);

  const channelId = normalizeYoutubeChannelId(result.channel?.channelId);
  if (!channelId) return;

  const channelKey = getYoutubeResolveCacheKeyForIdentity(`channel-id:${channelId}`, key);
  if (channelKey && channelKey !== key) {
    setCachedYoutubeResolveEntry(channelKey, result);
  }
}

export function getCachedYoutubeResolve(
  input: string,
  apiKey = "",
  options: { allowStale?: boolean } = {},
): CachedYoutubeResolve | null {
  const key = getYoutubeResolveCacheKey(input, apiKey);
  if (!key) return null;

  pruneYoutubeResolveCache();
  const entry = youtubeResolveCache.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (entry.staleUntil <= now) {
    deleteYoutubeResolveCacheEntry(key);
    return null;
  }

  const isFresh = entry.freshUntil > now;
  if (!isFresh && !options.allowStale) return null;

  youtubeResolveCache.delete(key);
  youtubeResolveCache.set(key, entry);
  const result = {
    ...entry.result,
    cache: makeCacheInfo(isFresh ? "hit" : "stale", entry),
  };
  return {
    result,
    isFresh,
    isStale: !isFresh,
    ageSeconds: result.cache.ageSeconds,
  };
}

export function getCachedYoutubeChannelMatches(
  query: string,
  apiKey = "",
  limit = 6,
): CachedYoutubeChannelSuggestion[] {
  const needle = normalizeSearchText(query);
  if (needle.length < 2) return [];

  pruneYoutubeResolveCache();

  const now = Date.now();
  const scope = `youtube-resolve-v3:${apiKey ? "keyed" : "public"}:`;
  const matches = new Map<string, { score: number; suggestion: CachedYoutubeChannelSuggestion }>();

  for (const [key, entry] of youtubeResolveCache) {
    if (!key.startsWith(scope) || entry.result.kind !== "channel" || !entry.result.channel) continue;

    const channel = entry.result.channel;
    const title = String(channel.title || entry.result.videos[0]?.channelTitle || "YouTube channel").trim();
    const channelId = String(channel.channelId || entry.result.videos[0]?.channelId || "").trim();
    const url = String(channel.url || (channelId ? `https://www.youtube.com/channel/${channelId}` : entry.result.input) || "").trim();
    const haystacks = [
      title,
      channelId,
      url,
      entry.result.input,
      ...entry.result.videos.slice(0, 8).flatMap((video) => [video.channelTitle, video.title]),
    ];
    const score = getYoutubeChannelSuggestionScore(query, haystacks);
    if (!score) continue;

    const matchKey = channelId ? `channel:${channelId}` : `title:${normalizeSearchText(title)}`;
    const result = {
      ...entry.result,
      cache: makeCacheInfo(entry.freshUntil > now ? "hit" : "stale", entry),
    };
    const suggestion: CachedYoutubeChannelSuggestion = {
      key: matchKey,
      title,
      lookupInput: url || entry.result.input || title,
      url,
      channelId,
      thumbnailUrl: String(channel.thumbnailUrl || entry.result.videos[0]?.thumbnailUrl || ""),
      videoCount: entry.result.videos.length,
      matchScore: score,
      source: "cache",
      result,
    };
    const existing = matches.get(matchKey);
    if (!existing || score > existing.score || suggestion.videoCount > existing.suggestion.videoCount) {
      matches.set(matchKey, { score, suggestion });
    }
  }

  return Array.from(matches.values())
    .sort((a, b) => b.score - a.score || b.suggestion.videoCount - a.suggestion.videoCount || a.suggestion.title.localeCompare(b.suggestion.title))
    .slice(0, limit)
    .map((match) => match.suggestion);
}

export function getCachedYoutubeChannelSuggestions(
  input: string,
  apiKey = "",
  limit = 8,
): YoutubeChannelSearchSuggestion[] | null {
  const key = getYoutubeChannelSuggestionCacheKey(input, apiKey, limit);
  if (!key) return null;

  pruneYoutubeChannelSuggestionCache();
  const entry = youtubeChannelSuggestionCache.get(key);
  if (!entry) return null;
  if (entry.freshUntil <= Date.now()) {
    deleteYoutubeChannelSuggestionCacheEntry(key);
    return null;
  }

  youtubeChannelSuggestionCache.delete(key);
  youtubeChannelSuggestionCache.set(key, entry);
  return entry.suggestions.slice(0, clampYoutubeChannelSuggestionLimit(limit)).map((suggestion) => ({ ...suggestion }));
}

function getErrorMessage(data: any, fallback: string) {
  return String(data?.error || data?.message || fallback);
}

function getNetworkErrorMessage(error: any, fallback: string) {
  const message = String(error?.message || error || "").trim();
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    const origin = typeof window !== "undefined" ? window.location.origin : "this site";
    return `${fallback}. The hosted backend could not be reached from ${origin}. Check that Render is awake and APP_URL is set to the GitHub Pages origin.`;
  }
  return message || fallback;
}

function normalizeVideo(video: any): YoutubeVideoPreview {
  return {
    videoId: String(video?.videoId || ""),
    title: String(video?.title || "YouTube audio"),
    url: String(video?.url || ""),
    channelId: String(video?.channelId || ""),
    channelTitle: String(video?.channelTitle || ""),
    thumbnailUrl: String(video?.thumbnailUrl || ""),
    durationSeconds: Math.max(0, Math.round(Number(video?.durationSeconds) || 0)),
    publishedAt: String(video?.publishedAt || ""),
  };
}

function normalizeCacheInfo(cache: any): YoutubeResolveCacheInfo | undefined {
  const status = ["miss", "hit", "stale", "refresh"].includes(cache?.status) ? cache.status : "";
  if (!status) return undefined;
  return {
    status,
    ageSeconds: Math.max(0, Math.round(Number(cache?.ageSeconds) || 0)),
    maxAgeSeconds: Math.max(0, Math.round(Number(cache?.maxAgeSeconds) || 0)),
    staleSeconds: Math.max(0, Math.round(Number(cache?.staleSeconds) || 0)),
    refreshedAt: String(cache?.refreshedAt || ""),
    warning: cache?.warning ? String(cache.warning) : undefined,
  };
}

function normalizeResolveResult(data: any, input: string): YoutubeResolveResult {
  return {
    kind: data?.kind === "channel" ? "channel" : "video",
    input: String(data?.input || input),
    channel: data?.channel,
    videos: Array.isArray(data?.videos) ? data.videos.map(normalizeVideo).filter((video) => video.videoId) : [],
    cache: normalizeCacheInfo(data?.cache),
  };
}

function normalizeChannelSuggestion(data: any): YoutubeChannelSearchSuggestion | null {
  const channelId = normalizeYoutubeChannelId(data?.channelId);
  const title = String(data?.title || "").trim();
  const url = String(data?.url || (channelId ? `https://www.youtube.com/channel/${channelId}` : "")).trim();
  if (!title || !url) return null;

  return {
    title,
    url,
    channelId,
    thumbnailUrl: String(data?.thumbnailUrl || "").trim(),
  };
}

export async function searchYoutubeChannelSuggestions(
  input: string,
  apiKey = "",
  signal?: AbortSignal,
  limit = 8,
): Promise<YoutubeChannelSearchSuggestion[]> {
  if (normalizeSearchText(input).length < 2) return [];

  const cached = getCachedYoutubeChannelSuggestions(input, apiKey, limit);
  if (cached) return cached;

  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/youtube/channel-suggestions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, apiKey, limit }),
      signal,
    });
  } catch (error) {
    throw new Error(getNetworkErrorMessage(error, "YouTube channel suggestions failed"));
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getErrorMessage(data, `YouTube channel suggestions failed (${response.status})`));
  }

  const suggestions = Array.isArray(data?.suggestions)
    ? data.suggestions
      .map(normalizeChannelSuggestion)
      .filter((suggestion): suggestion is YoutubeChannelSearchSuggestion => Boolean(suggestion))
    : [];

  const cacheKey = getYoutubeChannelSuggestionCacheKey(input, apiKey, limit);
  setCachedYoutubeChannelSuggestions(cacheKey, suggestions);
  return suggestions;
}

export async function resolveYoutubeInput(
  input: string,
  apiKey = "",
  signal?: AbortSignal,
  options: YoutubeResolveOptions = {},
): Promise<YoutubeResolveResult> {
  const cacheKey = getYoutubeResolveCacheKey(input, apiKey);
  if (!options.forceRefresh && options.allowCache !== false) {
    const cached = getCachedYoutubeResolve(input, apiKey);
    if (cached) return cached.result;
  }

  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/youtube/resolve"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, apiKey, forceRefresh: options.forceRefresh === true }),
      signal,
    });
  } catch (error) {
    throw new Error(getNetworkErrorMessage(error, "YouTube lookup failed"));
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getErrorMessage(data, `YouTube lookup failed (${response.status})`));
  }

  const result = normalizeResolveResult(data, input);
  setCachedYoutubeResolve(cacheKey, result);
  return result;
}

function decodeHeader(value: string | null) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extensionFromContentType(contentType: string) {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "audio/mp4" || type === "video/mp4") return "m4a";
  if (type === "audio/ogg" || type === "application/ogg") return "ogg";
  if (type === "audio/webm" || type === "video/webm") return "webm";
  if (type === "audio/mpeg") return "mp3";
  return "webm";
}

export async function downloadYoutubeAudio(
  video: YoutubeVideoPreview,
  apiKey = "",
  signal?: AbortSignal,
): Promise<YoutubeDownloadResult> {
  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/youtube/download"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: video.videoId, url: video.url, apiKey }),
      signal,
    });
  } catch (error) {
    throw new Error(getNetworkErrorMessage(error, "YouTube download failed"));
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(getErrorMessage(data, `YouTube download failed (${response.status})`));
  }

  const blob = await response.blob();
  const contentType = blob.type || response.headers.get("Content-Type") || "audio/webm";
  const title = decodeHeader(response.headers.get("X-YouTube-Title")) || video.title || "YouTube audio";
  const videoId = decodeHeader(response.headers.get("X-YouTube-Video-Id")) || video.videoId;
  const channelId = decodeHeader(response.headers.get("X-YouTube-Channel-Id")) || video.channelId;
  const channelTitle = decodeHeader(response.headers.get("X-YouTube-Channel-Title")) || video.channelTitle;
  const thumbnailUrl = decodeHeader(response.headers.get("X-YouTube-Thumbnail-Url")) || video.thumbnailUrl;
  const url = decodeHeader(response.headers.get("X-YouTube-Original-Url")) || video.url;
  const ext = extensionFromContentType(contentType);
  const file = new File([blob], `${sanitizeFileBase(title)}.${ext}`, {
    type: contentType,
    lastModified: Date.now(),
  });

  return {
    file,
    video: {
      ...video,
      videoId,
      title,
      url,
      channelId,
      channelTitle,
      thumbnailUrl,
    },
  };
}

export async function fetchYoutubeCaptionTiming(
  video: Pick<YoutubeVideoPreview, "videoId" | "url">,
  options: YoutubeCaptionTimingOptions = {},
): Promise<YoutubeCaptionTimingResult> {
  const lang = options.lang || "";
  const targetLanguage = options.targetLanguage || "";
  const allowAutomaticCaptions = options.allowAutomaticCaptions === true;
  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/youtube/captions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: video.videoId, url: video.url, lang, targetLanguage, allowAutomaticCaptions }),
      signal: options.signal,
    });
  } catch (error) {
    throw new Error(getNetworkErrorMessage(error, "YouTube captions failed"));
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getErrorMessage(data, `YouTube captions failed (${response.status})`));
  }
  if (!Array.isArray(data?.segments) || !data.segments.length) {
    throw new Error("No readable YouTube captions are available for this video.");
  }

  return {
    source: "youtube-captions-json3",
    transcriptionSource: "youtube-captions-json3",
    extractorSource: String(data.extractorSource || data.rawSource || response.headers.get("X-YouTube-Captions-Source") || ""),
    automaticCaptionsAllowed: data.automaticCaptionsAllowed === true || response.headers.get("X-YouTube-Captions-Automatic-Opt-In") === "true",
    videoId: String(data.videoId || video.videoId || ""),
    requestedLanguage: String(data.requestedLanguage || lang || ""),
    requestedTargetLanguage: String(data.requestedTargetLanguage || targetLanguage || ""),
    languageCode: String(data.languageCode || ""),
    trackKind: String(data.trackKind || ""),
    trackName: String(data.trackName || ""),
    translationSource: String(data.translationSource || ""),
    translationLanguageCode: String(data.translationLanguageCode || ""),
    translationTrackKind: String(data.translationTrackKind || ""),
    translationTrackName: String(data.translationTrackName || ""),
    generatedAt: String(data.generatedAt || ""),
    segments: data.segments,
  };
}
