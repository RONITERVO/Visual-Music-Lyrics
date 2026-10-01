/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, CreditCard, Download, Loader2, Music2, Palette, Pause, Play, RefreshCw, RotateCcw, Search, Settings, Sparkles, Trash2, Upload, X, Youtube } from "lucide-react";
import { useStore } from "../lib/store";
import { cleanTitle, formatBytes, formatClock, formatPreciseClock, getBrowserLanguageCode } from "../lib/utils";
import { addAudioFiles, loadSongSegments } from "../lib/fileHandlers";
import { MusicLyricReactivity, applyMusicLyricFrameStyles, measureLyricLayout, type MusicLyricLayout, type MusicLyricBounds } from "../lib/graphics/MusicLyricReactivity";
import { createMusicLyricVisualizer, MUSIC_LYRIC_THEMES, type MusicLyricRenderer, type MusicLyricTheme } from "../lib/graphics/MusicLyricVisualizers";
import { musicLyricSegmentAt, musicLyricDisplaySegmentAt, wordProgress } from "../lib/graphics/MusicLyricsTiming";
import type { Segment } from "../types";
import { createScribeTranscript } from "../lib/scribe";
import { translateSegments } from "../lib/translate";
import { createElevenLabsCheckoutSession, fetchElevenLabsEntitlement, type ElevenLabsEntitlement } from "../lib/billing";
import { buildGeneratedTimingText, replaceSegmentsInRange, saveSongTiming } from "../lib/timing";
import { exportLibrary, importLibrary, LibraryTransferProgress } from "../lib/exportImport";
import { clearPersistedUserData } from "../lib/persistence";
import { downloadYoutubeAudio, fetchYoutubeCaptionTiming, getCachedYoutubeChannelMatches, getCachedYoutubeChannelSuggestions, getCachedYoutubeResolve, getYoutubeChannelSuggestionScore, getYoutubeInputKind, isYoutubeUrlInput, resolveYoutubeInput, searchYoutubeChannelSuggestions } from "../lib/youtube";
import type { CachedYoutubeChannelSuggestion, YoutubeCaptionTimingResult, YoutubeResolveResult, YoutubeVideoPreview } from "../lib/youtube";

const ELEVENLABS_AUTO_COMMIT_LIMIT_SECONDS = 90;
const LOCAL_AUTO_COMMIT_BUFFER_SECONDS = 5;
const MIN_COMMIT_SEGMENT_SECONDS = 15;
const AUTO_COMMIT_SEGMENT_SECONDS = ELEVENLABS_AUTO_COMMIT_LIMIT_SECONDS - LOCAL_AUTO_COMMIT_BUFFER_SECONDS;
const YOUTUBE_CACHED_RESOLVE_DELAY_MS = 120;
const YOUTUBE_VIDEO_RESOLVE_DELAY_MS = 350;
const YOUTUBE_DIRECT_CHANNEL_RESOLVE_DELAY_MS = 650;
const YOUTUBE_CHANNEL_SUGGESTION_MIN_CHARS = 2;
const YOUTUBE_CHANNEL_SUGGESTION_FETCH_DELAY_MS = 180;
const YOUTUBE_REMOTE_CHANNEL_SUGGESTION_LIMIT = 10;

type YoutubeChannelSuggestion = {
  key: string;
  title: string;
  lookupInput: string;
  url: string;
  channelId: string;
  thumbnailUrl: string;
  videoCount: number;
  matchScore: number;
  source: "library" | "cache" | "remote";
  result?: YoutubeResolveResult;
};

type SourceKind = "youtube" | "scribe" | "gemini" | "loaded" | "none";

type SourceStat = {
  kind: SourceKind;
  label: string;
  count: number;
  percent: number;
};

type SourceSummary = {
  total: number;
  items: SourceStat[];
};

const SOURCE_KIND_META: Record<SourceKind, { label: string; color: string }> = {
  youtube: { label: "YouTube", color: "#c2332f" },
  scribe: { label: "Scribe", color: "#184ba5" },
  gemini: { label: "Gemini", color: "#7a4bc2" },
  loaded: { label: "Loaded", color: "#6d625c" },
  none: { label: "None", color: "rgba(35, 30, 28, 0.25)" },
};

function getYoutubeResolveMessage(result: YoutubeResolveResult) {
  if (result.kind !== "channel") return "";
  const title = String(result.channel?.title || "").trim();
  return [title, `${result.videos.length} videos`].filter(Boolean).join(" - ");
}

function getAudioElement() {
  let audioEl = document.getElementById("global-audio") as HTMLAudioElement | null;
  if (!audioEl) {
    audioEl = document.createElement("audio");
    audioEl.id = "global-audio";
    audioEl.crossOrigin = "anonymous";
    audioEl.preload = "auto";
    document.body.appendChild(audioEl);
  }
  return audioEl;
}

function formatBalanceSeconds(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function renderTimedWords(segment: Segment, currentTime: number, onSeek: (seconds: number) => void) {
  if (!segment.words?.length) return renderProgressiveText(segment.primary, segment.start, segment.end, currentTime);
  return segment.words.map((word, index) => {
    const written = currentTime >= word.start;
    const active = currentTime >= word.start && currentTime < word.end;
    const progress = wordProgress(word.start, word.end, currentTime);
    return (
      <span key={`${word.start}-${index}`} className="music-lyrics-word-wrap">
        <button
          type="button"
          className={`${written ? "written" : "waiting"} ${active ? "active" : ""}`}
          aria-label={`Play from ${word.value}`}
          onClick={(event) => {
            event.stopPropagation();
            onSeek(word.start);
          }}
          style={{
            "--word-progress": `${progress * 100}%`,
            "--word-hide": `${(1 - progress) * 100}%`,
            "--word-index": index,
          } as React.CSSProperties}
        >
          <span className="music-lyrics-word-ghost">{word.value}</span>
          <span className="music-lyrics-word-ink" aria-hidden="true">{word.value}</span>
        </button>
        {index < (segment.words?.length ?? 0) - 1 ? " " : ""}
      </span>
    );
  });
}

function renderProgressiveText(text: string, start: number, end: number, currentTime: number) {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return null;
  const duration = Math.max(0.05, end - start);
  return words.map((word, index) => {
    const wordStart = start + (duration * index) / words.length;
    const wordEnd = start + (duration * (index + 1)) / words.length;
    const progress = wordProgress(wordStart, wordEnd, currentTime);
    return (
      <span
        key={`${index}-${word}`}
        className={`music-lyrics-progressive-word ${progress > 0 ? "written" : "waiting"}`}
        style={{
          "--word-hide": `${(1 - progress) * 100}%`,
          "--word-index": index,
        } as React.CSSProperties}
      >
        <span className="music-lyrics-word-ghost">{word}</span>
        <span className="music-lyrics-word-ink" aria-hidden="true">{word}</span>
        {index < words.length - 1 ? " " : ""}
      </span>
    );
  });
}

function normalizeLanguage(value: string) {
  const clean = value.trim();
  return clean.toLowerCase() === "auto" ? "" : clean;
}

function getErrorMessage(error: any) {
  return String(error?.message || error || "Generation failed");
}

function normalizeSearchKey(value: any) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function parseTimingTextCache(song: any) {
  try {
    return JSON.parse(String(song?.timing?.textCache || ""));
  } catch {
    return null;
  }
}

function getTranscriptSourceKind(value: any): SourceKind {
  const source = String(value || "").toLowerCase();
  if (/youtube/.test(source)) return "youtube";
  if (/scribe|elevenlabs/.test(source)) return "scribe";
  if (!source || /import|loaded|manual|file|lyrics/.test(source)) return "loaded";
  return "loaded";
}

function getTranslationSourceKind(value: any): SourceKind {
  const source = String(value || "").toLowerCase();
  if (/youtube/.test(source)) return "youtube";
  if (/gemini|flash/.test(source)) return "gemini";
  if (/scribe|elevenlabs/.test(source)) return "scribe";
  if (!source) return "loaded";
  return "loaded";
}

function makeSourceSummary(counts: Map<SourceKind, number>): SourceSummary {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const items = [...counts.entries()]
    .map(([kind, count]) => ({
      kind,
      label: SOURCE_KIND_META[kind].label,
      count,
      percent: total > 0 ? Math.round((count / total) * 100) : 0,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  return { total, items };
}

function getTranscriptSourceSummary(segments: any[], timingData: any): SourceSummary {
  const fallback = timingData?.transcriptionSource || timingData?.source || "";
  const counts = new Map<SourceKind, number>();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!String(segment?.primary || segment?.raw || "").trim()) continue;
    const kind = getTranscriptSourceKind(segment?.source || fallback);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return makeSourceSummary(counts);
}

function getTranslationSourceSummary(segments: any[], timingData: any): SourceSummary {
  const fallback = timingData?.translationSource || timingData?.youtubeCaptionTrack?.translationSource || "";
  const counts = new Map<SourceKind, number>();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!String(segment?.translation || segment?.secondary || "").trim()) continue;
    const kind = getTranslationSourceKind(segment?.translationSource || fallback);
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  if (!counts.size) counts.set("none", 1);
  return makeSourceSummary(counts);
}

function getSourceSummaryLabel(summary: SourceSummary) {
  if (!summary.items.length) return "";
  return summary.items.map((item) => `${item.label} ${item.percent}%`).join(", ");
}

function SourceKindIcon({ kind, size = 13 }: { kind: SourceKind; size?: number }) {
  if (kind === "youtube") return <Youtube size={size} />;
  if (kind === "scribe") return <Bot size={size} />;
  if (kind === "gemini") return <Sparkles size={size} />;
  if (kind === "none") return <X size={size} />;
  return <Music2 size={size} />;
}

function SourceSummaryRow({ label, summary }: { label: string; summary: SourceSummary }) {
  const primary = summary.items[0];
  if (!primary) return null;
  const isMixed = summary.items.length > 1;

  return (
    <div
      className="grid min-w-0 gap-1 px-1 py-0.5"
      title={`${label}: ${getSourceSummaryLabel(summary)}`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 font-body text-[0.78rem] leading-tight">
        <span className="min-w-0 truncate text-ink-graphite-light">{label}</span>
        <span className="flex min-w-0 items-center gap-1 truncate text-ink-graphite">
          <span className="shrink-0" style={{ color: SOURCE_KIND_META[primary.kind].color }}>
            <SourceKindIcon kind={primary.kind} />
          </span>
          <span className="truncate">{isMixed ? "Mixed" : primary.label}</span>
        </span>
      </div>
      {isMixed && (
        <div className="grid gap-1">
          <div className="flex h-1.5 overflow-hidden rounded-full bg-ink-graphite/10">
            {summary.items.map((item) => (
              <span
                key={item.kind}
                style={{
                  width: `${item.percent}%`,
                  backgroundColor: SOURCE_KIND_META[item.kind].color,
                }}
              />
            ))}
          </div>
          <div className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 font-body text-[0.74rem] leading-tight text-ink-graphite-light">
            {summary.items.map((item) => (
              <span key={item.kind} className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOURCE_KIND_META[item.kind].color }} />
                <span>{item.label} {item.percent}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function getSegmentTextForTranslation(segment: any) {
  return String(segment?.primary || segment?.raw || segment?.text || "").trim();
}

function getSegmentRangeBounds(segment: any) {
  const start = Number(segment?.start);
  const rawEnd = Number(segment?.end);
  if (!Number.isFinite(start)) return { start: NaN, end: NaN };
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + 0.05;
  return { start, end };
}

function doesSegmentOverlapRange(segment: any, startSeconds: number, endSeconds: number) {
  const bounds = getSegmentRangeBounds(segment);
  return Number.isFinite(bounds.start) && Number.isFinite(bounds.end) && bounds.end > startSeconds && bounds.start < endSeconds;
}

function clearSegmentTranslation(segment: any) {
  return {
    ...segment,
    translation: "",
    secondary: "",
    translationSource: "",
  };
}

function annotateTranslatedSegments(segments: any[], translationSource: string) {
  const source = String(translationSource || "").trim();
  return (Array.isArray(segments) ? segments : []).map((segment) => {
    const hasTranslation = String(segment?.translation || segment?.secondary || "").trim();
    return source && hasTranslation ? { ...segment, translationSource: source } : { ...segment };
  });
}

function ensureSegmentTranslationSources(segments: any[], fallbackSource: string) {
  const source = String(fallbackSource || "").trim();
  if (!source || source === "mixed") return Array.isArray(segments) ? segments : [];
  return (Array.isArray(segments) ? segments : []).map((segment) => {
    const hasTranslation = String(segment?.translation || segment?.secondary || "").trim();
    return hasTranslation && !String(segment?.translationSource || "").trim()
      ? { ...segment, translationSource: source }
      : segment;
  });
}

function getAggregateTranslationSource(segments: any[], fallbackSource = "") {
  const fallback = String(fallbackSource || "").trim();
  const sources = new Set<string>();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!String(segment?.translation || segment?.secondary || "").trim()) continue;
    const source = String(segment?.translationSource || fallback || "").trim();
    if (source) sources.add(source);
  }
  if (sources.size === 1) return [...sources][0];
  if (sources.size > 1) return "mixed";
  return fallback;
}

function mergeTranslatedSegmentsInRange(
  existingSegments: any[],
  translatedSegments: any[],
  startSeconds: number,
  endSeconds: number,
  translationSource: string,
  existingTranslationSource: string,
) {
  const byId = new Map<string, any>();
  const byOrder = new Map<number, any>();
  for (const segment of Array.isArray(translatedSegments) ? translatedSegments : []) {
    const id = String(segment?.id || "");
    const order = Number(segment?.order);
    if (id) byId.set(id, segment);
    if (Number.isFinite(order)) byOrder.set(order, segment);
  }

  return ensureSegmentTranslationSources(existingSegments, existingTranslationSource).map((segment, order) => {
    if (!doesSegmentOverlapRange(segment, startSeconds, endSeconds)) return { ...segment, order };

    const replacement = byId.get(String(segment?.id || "")) || byOrder.get(Number(segment?.order));
    const translation = String(replacement?.translation || replacement?.secondary || "").trim();
    if (!translation) {
      return { ...segment, order, translation: "", secondary: "", translationSource: "" };
    }

    return {
      ...segment,
      order,
      translation,
      secondary: String(replacement?.secondary || translation),
      translationSource: translationSource || String(replacement?.translationSource || ""),
    };
  });
}

function buildTimingTextFromExisting(song: any, timingData: any, segments: any[], options: {
  sourceLanguage: string;
  targetLanguage: string;
  translationSource: string;
}) {
  const existing = timingData && typeof timingData === "object" && !Array.isArray(timingData) ? timingData : {};
  const {
    segments: _oldSegments,
    translationError: _oldTranslationError,
    generatedAt: _oldGeneratedAt,
    ...existingMeta
  } = existing;
  const transcriptionSource = String(existing?.transcriptionSource || existing?.source || song?.timing?.source || "elevenlabs-scribe-v2");

  return JSON.stringify({
    ...existingMeta,
    source: transcriptionSource,
    transcriptionSource,
    translationSource: options.translationSource,
    commitStrategy: existing?.commitStrategy || "manual",
    manualCommitMarks: Array.isArray(existing?.manualCommitMarks) ? existing.manualCommitMarks : [],
    sourceLanguage: options.sourceLanguage || existing?.sourceLanguage || "auto",
    targetLanguage: options.targetLanguage || existing?.targetLanguage || "",
    generatedAt: new Date().toISOString(),
    segments,
  }, null, 2);
}

function matchesSearchText(value: any, query: string) {
  const haystack = normalizeSearchKey(value);
  const needle = normalizeSearchKey(query);
  return Boolean(haystack && needle && (haystack === needle || haystack.includes(needle)));
}

function isDirectYoutubeLookup(value: string) {
  const trimmed = value.trim();
  return Boolean(trimmed) && isYoutubeUrlInput(trimmed) && !/^@[\w.-]{3,30}$/i.test(trimmed);
}

function getLibraryYoutubeChannelSuggestions(input: string, audioFiles: any[], limit = 6): YoutubeChannelSuggestion[] {
  const query = normalizeSearchKey(input);
  if (query.length < YOUTUBE_CHANNEL_SUGGESTION_MIN_CHARS || isDirectYoutubeLookup(input)) return [];

  const suggestions = new Map<string, YoutubeChannelSuggestion>();
  for (const song of audioFiles) {
    const title = String(song?.youtubeChannelTitle || "").trim();
    const channelId = String(song?.youtubeChannelId || "").trim();
    if (!title && !channelId) continue;

    const score = getYoutubeChannelSuggestionScore(input, [title, channelId, song?.name]);
    if (!score) continue;

    const key = channelId ? `channel:${channelId}` : `title:${normalizeSearchKey(title)}`;
    const existing = suggestions.get(key);
    if (existing) {
      existing.videoCount += 1;
      existing.thumbnailUrl ||= String(song?.youtubeThumbnailUrl || "");
      existing.matchScore = Math.max(existing.matchScore, score);
      continue;
    }

    const channelUrl = /^UC[a-zA-Z0-9_-]{20,}$/.test(channelId)
      ? `https://www.youtube.com/channel/${channelId}`
      : "";
    suggestions.set(key, {
      key,
      title: title || "YouTube channel",
      lookupInput: channelUrl || title || channelId,
      url: channelUrl,
      channelId,
      thumbnailUrl: String(song?.youtubeThumbnailUrl || ""),
      videoCount: 1,
      matchScore: score,
      source: "library",
    });
  }

  return Array.from(suggestions.values())
    .sort((a, b) => b.matchScore - a.matchScore || b.videoCount - a.videoCount || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function getYoutubeChannelSuggestionPriority(suggestion: YoutubeChannelSuggestion | CachedYoutubeChannelSuggestion) {
  return suggestion.matchScore + Math.min(suggestion.videoCount, 12) + (suggestion.result ? 18 : 0);
}

function mergeYoutubeChannelSuggestion(
  preferred: YoutubeChannelSuggestion | CachedYoutubeChannelSuggestion,
  fallback: YoutubeChannelSuggestion | CachedYoutubeChannelSuggestion,
): YoutubeChannelSuggestion {
  return {
    ...fallback,
    ...preferred,
    key: preferred.key || fallback.key,
    title: preferred.title || fallback.title,
    lookupInput: preferred.lookupInput || fallback.lookupInput,
    url: preferred.url || fallback.url,
    channelId: preferred.channelId || fallback.channelId,
    thumbnailUrl: preferred.thumbnailUrl || fallback.thumbnailUrl,
    videoCount: Math.max(preferred.videoCount, fallback.videoCount),
    matchScore: Math.max(preferred.matchScore, fallback.matchScore),
    result: preferred.result || fallback.result,
  };
}

function getYoutubeChannelSuggestions(
  input: string,
  audioFiles: any[],
  remoteSuggestions: YoutubeChannelSuggestion[],
  limit = 6,
): YoutubeChannelSuggestion[] {
  const query = normalizeSearchKey(input);
  if (query.length < YOUTUBE_CHANNEL_SUGGESTION_MIN_CHARS || isDirectYoutubeLookup(input)) return [];

  const byKey = new Map<string, YoutubeChannelSuggestion>();
  const addSuggestion = (suggestion: YoutubeChannelSuggestion | CachedYoutubeChannelSuggestion) => {
    const key = suggestion.channelId ? `channel:${suggestion.channelId}` : suggestion.key;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...suggestion });
      return;
    }

    const preferred = getYoutubeChannelSuggestionPriority(suggestion) >= getYoutubeChannelSuggestionPriority(existing)
      ? suggestion
      : existing;
    const fallback = preferred === suggestion ? existing : suggestion;
    byKey.set(key, mergeYoutubeChannelSuggestion(preferred, fallback));
  };

  remoteSuggestions.forEach(addSuggestion);
  getCachedYoutubeChannelMatches(input, limit).forEach(addSuggestion);
  getLibraryYoutubeChannelSuggestions(input, audioFiles, limit).forEach(addSuggestion);

  return Array.from(byKey.values())
    .sort((a, b) => getYoutubeChannelSuggestionPriority(b) - getYoutubeChannelSuggestionPriority(a) || b.matchScore - a.matchScore || b.videoCount - a.videoCount || a.title.localeCompare(b.title))
    .slice(0, limit);
}

function mapYoutubeRemoteChannelSuggestions(input: string, suggestions: Array<{
  title: string;
  url: string;
  channelId: string;
  thumbnailUrl: string;
}>): YoutubeChannelSuggestion[] {
  return suggestions.map((suggestion, index) => ({
    key: suggestion.channelId
      ? `channel:${suggestion.channelId}`
      : `remote:${normalizeSearchKey(suggestion.title)}:${index}`,
    title: suggestion.title || "YouTube channel",
    lookupInput: suggestion.url || suggestion.channelId || suggestion.title,
    url: suggestion.url,
    channelId: suggestion.channelId,
    thumbnailUrl: suggestion.thumbnailUrl,
    videoCount: 0,
    matchScore: getYoutubeChannelSuggestionScore(input, [suggestion.title, suggestion.channelId, suggestion.url]) + Math.max(0, 8 - index),
    source: "remote",
  }));
}

function ControlIconButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: React.ReactNode;
}) {
  const { label, children, className = "", ...buttonProps } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border border-ink-graphite/25 bg-paper-light/80 text-ink-graphite shadow-sm backdrop-blur-sm transition hover:border-ink-blueprint hover:text-ink-blueprint active:scale-95 disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:h-[14px] [&_svg]:w-[14px] sm:h-10 sm:w-10 sm:[&_svg]:h-[18px] sm:[&_svg]:w-[18px] ${className}`}
      data-control="true"
      {...buttonProps}
    >
      {children}
    </button>
  );
}

function LibraryTitle({
  text,
  isSelected = false,
  className = "",
}: {
  text: string;
  isSelected?: boolean;
  className?: string;
}) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useEffect(() => {
    if (!isSelected) {
      setScrollDistance(0);
      return;
    }

    const viewport = viewportRef.current;
    const textElement = textRef.current;
    if (!viewport || !textElement) return;

    const measure = () => {
      const nextDistance = Math.max(0, Math.ceil(textElement.scrollWidth - viewport.clientWidth));
      setScrollDistance((current) => (current === nextDistance ? current : nextDistance));
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => measure());
    observer.observe(viewport);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [isSelected, text]);

  const shouldScroll = isSelected && scrollDistance > 12;
  const style = shouldScroll
    ? ({
        "--library-title-shift": `${scrollDistance}px`,
        "--library-title-duration": `${Math.max(7, Math.min(16, scrollDistance / 20))}s`,
      } as React.CSSProperties)
    : undefined;

  return (
    <span
      ref={viewportRef}
      className={`library-title-window block min-w-0 ${shouldScroll ? "library-title-window--active" : ""} ${className}`}
      style={style}
      title={text}
    >
      <span ref={textRef} className={`library-title-text ${shouldScroll ? "library-title-text--scroll" : ""}`}>
        {text}
      </span>
    </span>
  );
}

function SearchOverlay({
  isOpen,
  query,
  setQuery,
  isKeyGateOpen,
  setIsKeyGateOpen,
  onOpen,
  onClose,
  onExportLibrary,
  onImportLibrary,
  onClearAllData,
  onSelectSong,
  onSelectYoutubeChannel,
  onPersistYoutube,
  onRefreshYoutube,
  libraryTransferStatus,
  isLibraryTransferBusy,
  youtubeResults,
  youtubeStatus,
  youtubeMessage,
  youtubeImportingVideoId,
  currentTime,
  duration,
  sectionStart,
  isPlaying,
  isCapturing,
  showCommitControls,
  isBackendProcessing,
  isSectionMode,
  isSectionFinishing,
  isTranslationRangePlaying,
  transcriptSourceSummary,
  translationSourceSummary,
  canCommit,
  nextCommitAt,
  autoCommitAt,
  commitProgress,
  manualCommitMarks,
  scribeMessage,
  commitFeedback,
  onSliderChange,
  onToggleSectionMode,
  onTransportClick,
}: {
  isOpen: boolean;
  query: string;
  setQuery: (value: string) => void;
  isKeyGateOpen: boolean;
  setIsKeyGateOpen: (value: boolean) => void;
  onOpen: () => void;
  onClose: () => void;
  onExportLibrary: () => void;
  onImportLibrary: () => void;
  onClearAllData: () => void;
  onSelectSong: (songId: string) => void;
  onSelectYoutubeChannel: (suggestion: YoutubeChannelSuggestion) => void;
  onPersistYoutube: (video: YoutubeVideoPreview) => void;
  onRefreshYoutube: () => void;
  libraryTransferStatus: string;
  isLibraryTransferBusy: boolean;
  youtubeResults: YoutubeVideoPreview[];
  youtubeStatus: "idle" | "loading" | "ready" | "error";
  youtubeMessage: string;
  youtubeImportingVideoId: string;
  currentTime: number;
  duration: number;
  sectionStart: number;
  isPlaying: boolean;
  isCapturing: boolean;
  showCommitControls: boolean;
  isBackendProcessing: boolean;
  isSectionMode: boolean;
  isSectionFinishing: boolean;
  isTranslationRangePlaying: boolean;
  transcriptSourceSummary: SourceSummary;
  translationSourceSummary: SourceSummary;
  canCommit: boolean;
  nextCommitAt: number;
  autoCommitAt: number;
  commitProgress: number;
  manualCommitMarks: number[];
  scribeMessage: string;
  commitFeedback: string;
  onSliderChange: (value: number) => void;
  onToggleSectionMode: () => void;
  onTransportClick: () => void;
}) {
  const audioFiles = useStore((state) => state.audioFiles);
  const selectedAudioId = useStore((state) => state.selectedAudioId);
  const allowAutomaticYoutubeCaptions = useStore((state) => state.allowAutomaticYoutubeCaptions);
  const sourceLanguage = useStore((state) => state.sourceLanguage);
  const targetLanguage = useStore((state) => state.targetLanguage);
  const translationEnabled = useStore((state) => state.translationEnabled);
  const [isSongPickerOpen, setIsSongPickerOpen] = useState(false);
  const [youtubeRemoteChannelSuggestions, setYoutubeRemoteChannelSuggestions] = useState<YoutubeChannelSuggestion[]>([]);
  const [youtubeChannelSuggestionStatus, setYoutubeChannelSuggestionStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [entitlement, setEntitlement] = useState<ElevenLabsEntitlement | null>(null);
  const [billingStatus, setBillingStatus] = useState<"idle" | "loading" | "checkout" | "error">("idle");
  const [billingMessage, setBillingMessage] = useState("");
  const selectedSong = audioFiles.find((audio) => audio.id === selectedAudioId) || null;
  const isTranslationRangePreview = Boolean(isSectionMode && isTranslationRangePlaying);
  const sliderValue = isSectionMode && !isCapturing && !isTranslationRangePreview ? sectionStart : currentTime;
  const isSyncedPlayback = Boolean(selectedSong?.timing) && !isCapturing && !isSectionMode;
  const shouldShowSongPicker = isSongPickerOpen || query.trim().length > 0;
  const youtubeInputKind = getYoutubeInputKind(query);
  const isYoutubeUrlQuery = isYoutubeUrlInput(query) || query.trim().startsWith("@");
  const isYoutubeChannelSuggestionQuery = Boolean(query.trim() && youtubeInputKind === "channel" && !isDirectYoutubeLookup(query));
  const isYoutubeQuery = Boolean(youtubeInputKind && (isDirectYoutubeLookup(query) || youtubeStatus !== "idle" || youtubeResults.length > 0));
  const canUseTranslationRange = Boolean(selectedSong?.timing);
  const regenerateLabel = "Replace translations in range";
  const transportLabel = isBackendProcessing
    ? "Working"
    : isSectionMode
      ? (isTranslationRangePlaying ? "Apply translation range" : "Preview translation range")
      : isSyncedPlayback && isPlaying
          ? "Pause"
          : isPlaying
            ? "Playback running"
            : "Play";
  const transportDisabled = !selectedSong ||
    isBackendProcessing ||
    isSectionFinishing ||
    (isSectionMode
      ? !selectedSong.timing
      : (!isSectionMode && isPlaying && !isSyncedPlayback));

  const filteredSongs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (isYoutubeUrlQuery) return [];
    const songs = needle
      ? audioFiles.filter((song) => song.name.toLowerCase().includes(needle) || cleanTitle(song.name).toLowerCase().includes(needle))
      : audioFiles;
    return songs.slice(0, 100);
  }, [audioFiles, isYoutubeUrlQuery, query]);

  const youtubeRows = useMemo(() => {
    if (!isYoutubeQuery) return [];
    return youtubeResults
      .map((video, index) => ({
        video,
        index,
        existingSong: audioFiles.find((song) => song.youtubeVideoId === video.videoId) || null,
      }))
      .sort((a, b) => Number(Boolean(a.existingSong)) - Number(Boolean(b.existingSong)) || a.index - b.index);
  }, [audioFiles, isYoutubeQuery, youtubeResults]);

  useEffect(() => {
    const input = query.trim();
    if (!isYoutubeChannelSuggestionQuery || normalizeSearchKey(input).length < YOUTUBE_CHANNEL_SUGGESTION_MIN_CHARS) {
      setYoutubeRemoteChannelSuggestions([]);
      setYoutubeChannelSuggestionStatus("idle");
      return;
    }

    const cachedSuggestions = getCachedYoutubeChannelSuggestions(input, YOUTUBE_REMOTE_CHANNEL_SUGGESTION_LIMIT);
    if (cachedSuggestions) {
      setYoutubeRemoteChannelSuggestions(mapYoutubeRemoteChannelSuggestions(input, cachedSuggestions));
      setYoutubeChannelSuggestionStatus("ready");
      return;
    }

    const controller = new AbortController();
    setYoutubeRemoteChannelSuggestions([]);
    setYoutubeChannelSuggestionStatus("loading");

    const timeoutId = window.setTimeout(async () => {
      try {
        const suggestions = await searchYoutubeChannelSuggestions(
          input,
          controller.signal,
          YOUTUBE_REMOTE_CHANNEL_SUGGESTION_LIMIT,
        );
        if (controller.signal.aborted) return;

        setYoutubeRemoteChannelSuggestions(mapYoutubeRemoteChannelSuggestions(input, suggestions));
        setYoutubeChannelSuggestionStatus("ready");
      } catch {
        if (controller.signal.aborted) return;
        setYoutubeRemoteChannelSuggestions([]);
        setYoutubeChannelSuggestionStatus("ready");
      }
    }, YOUTUBE_CHANNEL_SUGGESTION_FETCH_DELAY_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [isYoutubeChannelSuggestionQuery, query]);

  useEffect(() => {
    if (!isKeyGateOpen) return;

    let canceled = false;
    setBillingStatus("loading");
    fetchElevenLabsEntitlement()
      .then((nextEntitlement) => {
        if (canceled) return;
        setEntitlement(nextEntitlement);
        setBillingStatus("idle");
        setBillingMessage("");
      })
      .catch((error: any) => {
        if (canceled) return;
        setBillingStatus("error");
        setBillingMessage(String(error?.message || error || "Could not load Scribe balance."));
      });

    return () => {
      canceled = true;
    };
  }, [isKeyGateOpen]);

  const handleBuyScribeHour = async () => {
    setBillingStatus("checkout");
    setBillingMessage("");
    try {
      const checkout = await createElevenLabsCheckoutSession(3600);
      window.location.assign(checkout.url);
    } catch (error: any) {
      setBillingStatus("error");
      setBillingMessage(String(error?.message || error || "Could not start checkout."));
    }
  };

  const youtubeChannelSuggestions = useMemo(() => {
    if (youtubeStatus === "loading" || youtubeRows.length > 0) return [];
    return getYoutubeChannelSuggestions(query, audioFiles, youtubeRemoteChannelSuggestions);
  }, [audioFiles, query, youtubeRemoteChannelSuggestions, youtubeRows.length, youtubeStatus]);

  if (!isOpen) {
    return (
      <button
        type="button"
        className="fixed right-3 top-3 z-50 grid h-8 w-8 place-items-center rounded-full border-none bg-transparent text-ink-graphite/70 transition hover:text-ink-blueprint active:scale-95 sm:right-5 sm:top-[58px] sm:h-10 sm:w-10"
        data-control="true"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <Search className="h-4 w-4 sm:h-[22px] sm:w-[22px]" />
      </button>
    );
  }

  return (
    <section
      className="fixed right-3 top-3 left-[calc(var(--binder-spine-width)+0.75rem)] z-50 grid max-h-[calc(100svh-1.5rem)] min-w-0 gap-1.5 overflow-x-hidden overflow-y-auto overscroll-contain pr-0.5 text-ink-graphite sm:left-auto sm:right-4 sm:top-4 sm:w-[min(420px,calc(100vw-2.5rem))] sm:gap-2 sm:pr-0"
      data-control="true"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="grid gap-1.5 rounded-[8px] border border-ink-graphite/25 bg-paper-light/90 p-1.5 shadow-lg backdrop-blur-md sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-2 sm:p-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Search className="ml-0.5 h-[15px] w-[15px] shrink-0 text-ink-blueprint sm:ml-1 sm:h-[18px] sm:w-[18px]" />
          <input
            className="min-w-0 w-full bg-transparent px-0.5 py-0.5 font-body text-[0.9rem] outline-none placeholder:text-ink-graphite-light sm:px-1 sm:py-1 sm:text-[1.05rem]"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="@channel, video URL, or search..."
            autoFocus
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1 sm:min-w-fit sm:flex-nowrap sm:gap-2">
          <ControlIconButton
            label="Export library"
            onClick={onExportLibrary}
            disabled={isLibraryTransferBusy || audioFiles.length === 0}
          >
            <Download size={18} />
          </ControlIconButton>
          <ControlIconButton
            label="Import library"
            onClick={onImportLibrary}
            disabled={isLibraryTransferBusy}
          >
            <Upload size={18} />
          </ControlIconButton>
          <ControlIconButton
            label="Clear all local data"
            onClick={onClearAllData}
            disabled={isLibraryTransferBusy}
          >
            <Trash2 size={18} />
          </ControlIconButton>
          <ControlIconButton label="Settings" onClick={() => setIsKeyGateOpen(!isKeyGateOpen)}>
            <Settings size={18} />
          </ControlIconButton>
          <ControlIconButton label="Close search" onClick={onClose}>
            <X size={18} />
          </ControlIconButton>
        </div>
      </div>

      {libraryTransferStatus && (
        <div className="flex items-start gap-2 overflow-hidden rounded-[8px] border border-ink-blueprint/20 bg-paper-light/90 px-2.5 py-1.5 font-body text-[0.82rem] text-ink-graphite shadow-lg backdrop-blur-md sm:px-3 sm:py-2 sm:text-[0.9rem]">
          {isLibraryTransferBusy && <Loader2 size={15} className="shrink-0 animate-spin text-ink-blueprint" />}
          <span className="min-w-0 break-words leading-tight">{libraryTransferStatus}</span>
        </div>
      )}

      <div className="grid gap-1.5 rounded-[8px] border border-ink-graphite/20 bg-paper-light/90 p-2 shadow-lg backdrop-blur-md sm:gap-2 sm:p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="break-words font-display text-[1.08rem] leading-tight sm:truncate sm:text-[1.2rem]">
              {scribeMessage || (selectedSong ? (isPlaying ? "Playing" : "Ready") : "Drop audio")}
            </div>
            <div className="break-words font-body text-[0.85rem] leading-tight text-ink-graphite-light sm:truncate sm:text-[0.92rem]">
              {commitFeedback || (duration ? `${formatClock(currentTime)} / ${formatClock(duration)}` : " ")}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <ControlIconButton
              label={regenerateLabel}
              className={isSectionMode ? "border-ink-blueprint text-ink-blueprint" : ""}
              onClick={onToggleSectionMode}
              disabled={!selectedSong || !canUseTranslationRange || isCapturing || isSectionFinishing || isBackendProcessing}
            >
              <RefreshCw size={17} />
            </ControlIconButton>
            <ControlIconButton
              label={transportLabel}
              onClick={onTransportClick}
              disabled={transportDisabled}
            >
              {isBackendProcessing
                ? <Loader2 size={18} className="animate-spin" />
                : isSectionMode && isTranslationRangePlaying
                  ? <Check size={18} />
                : isSyncedPlayback && isPlaying
                  ? <Pause size={18} />
                  : <Play size={18} />}
            </ControlIconButton>
          </div>
        </div>

        {duration > 0 && (
          <div className="grid gap-1">
            <input
              type="range"
              min={0}
              max={Math.max(1, duration)}
              step={0.05}
              value={Math.min(Math.max(0, sliderValue), duration)}
              onChange={(event) => onSliderChange(Number(event.target.value))}
              disabled={isCapturing || isSectionFinishing || isBackendProcessing || isTranslationRangePlaying}
              className="w-full accent-ink-blueprint"
              aria-label={isSectionMode ? "Section start" : "Playback position"}
            />
            <div className="flex justify-between font-body text-[0.82rem] leading-none text-ink-graphite-light">
              <span>{isTranslationRangePreview ? `${formatClock(sectionStart)} - ${formatClock(currentTime)}` : formatClock(isSectionMode ? sectionStart : currentTime)}</span>
              <span>{formatClock(duration)}</span>
            </div>
          </div>
        )}

        {showCommitControls && (
          <div className="grid gap-1">
            <div className="flex items-start justify-between gap-3 font-body text-[0.88rem] leading-tight">
              <span className={`min-w-0 break-words ${canCommit ? "text-ink-blueprint" : "text-ink-graphite-light"}`}>
                {canCommit
                  ? `Automatic at: ${formatClock(autoCommitAt)}`
                  : `Click possible in: ${formatClock(nextCommitAt)}`}
              </span>
              <span className="shrink-0 text-right text-ink-graphite-light">{`${formatClock(nextCommitAt)}-${formatClock(autoCommitAt)}`}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-ink-graphite/10">
              <div
                className="h-full rounded-full bg-ink-blueprint transition-[width] duration-200"
                style={{ width: `${Math.round(commitProgress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {showCommitControls && manualCommitMarks.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {manualCommitMarks.slice(-8).map((mark) => (
              <span key={mark} className="rounded-full bg-ink-blueprint/10 px-2 py-0.5 font-body text-[0.82rem] text-ink-blueprint">
                {formatClock(mark)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-[8px] border border-ink-graphite/20 bg-paper-light/90 shadow-lg backdrop-blur-md">
        {selectedSong ? (
          <button
            type="button"
            className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-ink-blueprint/10 sm:gap-3 sm:px-3 sm:py-2"
            onClick={() => setIsSongPickerOpen(!isSongPickerOpen)}
          >
            <Music2 size={18} className={selectedSong.file || selectedSong.url ? "text-ink-blueprint" : "text-ink-red"} />
            <span className="min-w-0">
              <LibraryTitle
                text={selectedSong.name}
                isSelected
                className="font-display text-[1.1rem] leading-tight sm:text-[1.25rem]"
              />
              <span className="block truncate font-body text-[0.82rem] leading-tight text-ink-graphite-light sm:text-[0.9rem]">
                {[formatBytes(selectedSong.size), selectedSong.timing ? "Synced" : "Unsynced"].filter(Boolean).join(" - ")}
              </span>
            </span>
            <span className="font-display text-[0.92rem] text-ink-blueprint sm:text-[1rem]">{shouldShowSongPicker ? "Hide" : "Songs"}</span>
          </button>
        ) : (
          <div className="px-3 py-2 font-body text-[0.92rem] text-ink-graphite-light sm:px-4 sm:py-3 sm:text-[1rem]">Drop audio to begin</div>
        )}

        {selectedSong?.timing && (
          <div className="grid gap-1 border-t border-ink-graphite/10 px-2 py-1.5 min-[380px]:grid-cols-2 sm:px-3">
            <SourceSummaryRow label="Lyrics" summary={transcriptSourceSummary} />
            <SourceSummaryRow label="Translation" summary={translationSourceSummary} />
          </div>
        )}

        {shouldShowSongPicker && (
          <div
            className="border-t border-ink-graphite/15 overflow-auto py-1"
            style={{ maxHeight: "min(180px, max(84px, calc(38svh - 220px)))" }}
          >
            {isYoutubeQuery && (youtubeRows.length > 0 || youtubeStatus === "loading") && (
              <div className="flex min-h-9 items-center justify-between gap-2 border-b border-ink-graphite/10 px-2.5 py-1 sm:px-3">
                <span className="min-w-0 truncate font-body text-[0.82rem] leading-tight text-ink-graphite-light sm:text-[0.9rem]">
                  {youtubeMessage || (youtubeInputKind === "channel" ? "YouTube channel" : "YouTube video")}
                </span>
                <ControlIconButton
                  label="Refresh YouTube results"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRefreshYoutube();
                  }}
                  disabled={youtubeStatus === "loading" || Boolean(youtubeImportingVideoId)}
                  className="h-7 w-7 sm:h-8 sm:w-8 sm:[&_svg]:h-[15px] sm:[&_svg]:w-[15px]"
                >
                  <RefreshCw className={youtubeStatus === "loading" ? "animate-spin" : ""} />
                </ControlIconButton>
              </div>
            )}

            {youtubeChannelSuggestions.map((suggestion) => {
              const meta = suggestion.source === "cache"
                ? [`${suggestion.videoCount} cached videos`, "YouTube channel"].join(" - ")
                : suggestion.source === "library"
                  ? [`${suggestion.videoCount} in library`, "YouTube channel"].join(" - ")
                  : "YouTube channel match";

              return (
                <button
                  type="button"
                  key={`youtube-channel-${suggestion.key}`}
                  aria-label={`Open YouTube channel ${suggestion.title}`}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-ink-blueprint/10 sm:gap-3 sm:px-3 sm:py-2"
                  onClick={() => onSelectYoutubeChannel(suggestion)}
                  disabled={isLibraryTransferBusy || Boolean(youtubeImportingVideoId)}
                >
                  {suggestion.thumbnailUrl ? (
                    <img
                      src={suggestion.thumbnailUrl}
                      alt=""
                      className="h-[22px] w-[22px] rounded-full object-cover sm:h-7 sm:w-7"
                    />
                  ) : (
                    <Search size={18} className="text-ink-blueprint" />
                  )}
                  <span className="min-w-0">
                    <LibraryTitle
                      text={suggestion.title}
                      className="font-display text-[1.1rem] leading-tight sm:text-[1.25rem]"
                    />
                    <span className="block truncate font-body text-[0.82rem] leading-tight text-ink-graphite-light sm:text-[0.9rem]">
                      {meta}
                    </span>
                  </span>
                  <RefreshCw size={16} className="text-ink-blueprint" />
                </button>
              );
            })}

            {!youtubeRows.length && !filteredSongs.length && !youtubeChannelSuggestions.length && youtubeChannelSuggestionStatus === "loading" && (
              <div className="flex items-center gap-2 px-4 py-3 font-body text-[1rem] text-ink-graphite-light">
                <Loader2 size={16} className="animate-spin text-ink-blueprint" />
                <span>Searching YouTube channels</span>
              </div>
            )}

            {youtubeRows.map(({ video, existingSong }) => {
              const isExisting = Boolean(existingSong);
              const isSelected = existingSong?.id === selectedAudioId;
              const isImporting = youtubeImportingVideoId === video.videoId;
              const meta = isExisting
                ? [formatBytes(existingSong?.size), existingSong?.timing ? "Synced" : "Unsynced", "In library"].filter(Boolean).join(" - ")
                : ["YouTube", video.channelTitle, video.durationSeconds ? formatClock(video.durationSeconds) : ""].filter(Boolean).join(" - ");

              return (
                <button
                  type="button"
                  key={`youtube-${video.videoId}`}
                  className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-ink-blueprint/10 sm:gap-3 sm:px-3 sm:py-2 ${isSelected ? "bg-ink-blueprint/10 text-ink-blueprint" : ""}`}
                  onClick={() => {
                    if (existingSong) {
                      setIsSongPickerOpen(false);
                      onSelectSong(existingSong.id);
                    } else {
                      onPersistYoutube(video);
                    }
                  }}
                  disabled={isLibraryTransferBusy && !isImporting}
                >
                  {isImporting
                    ? <Loader2 size={18} className="animate-spin text-ink-blueprint" />
                    : isExisting
                      ? <Music2 size={18} className="text-ink-blueprint" />
                      : <Download size={18} className="text-ink-blueprint" />}
                  <span className="min-w-0">
                    <LibraryTitle
                      text={video.title}
                      isSelected={isSelected}
                      className="font-display text-[1.1rem] leading-tight sm:text-[1.25rem]"
                    />
                    <span className="block truncate font-body text-[0.82rem] leading-tight text-ink-graphite-light sm:text-[0.9rem]">
                      {meta}
                    </span>
                  </span>
                  {(isSelected || isExisting) && <Check size={17} />}
                </button>
              );
            })}

            {filteredSongs.map((song) => {
                const isSelected = song.id === selectedAudioId;
                return (
                  <button
                    type="button"
                    key={song.id}
                    className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-ink-blueprint/10 sm:gap-3 sm:px-3 sm:py-2 ${isSelected ? "bg-ink-blueprint/10 text-ink-blueprint" : ""}`}
                    onClick={() => {
                      setIsSongPickerOpen(false);
                      onSelectSong(song.id);
                    }}
                    disabled={!song.file && !song.url}
                  >
                    <Music2 size={18} className={song.file || song.url ? "text-ink-blueprint" : "text-ink-red"} />
                    <span className="min-w-0">
                      <LibraryTitle
                        text={song.name}
                        isSelected={isSelected}
                        className="font-display text-[1.1rem] leading-tight sm:text-[1.25rem]"
                      />
                      <span className="block truncate font-body text-[0.82rem] leading-tight text-ink-graphite-light sm:text-[0.9rem]">
                        {[formatBytes(song.size), song.timing ? "Synced" : "Unsynced"].filter(Boolean).join(" - ")}
                      </span>
                    </span>
                    {isSelected && <Check size={17} />}
                  </button>
                );
              })}

            {isYoutubeQuery && youtubeStatus === "loading" && (
              <div className="flex items-center gap-2 px-4 py-3 font-body text-[1rem] text-ink-graphite-light">
                <Loader2 size={16} className="animate-spin text-ink-blueprint" />
                <span>YouTube</span>
              </div>
            )}

            {isYoutubeQuery && youtubeStatus === "error" && (
              <div className="break-words px-4 py-3 font-body text-[1rem] text-ink-red">{youtubeMessage || "YouTube unavailable"}</div>
            )}

            {!youtubeRows.length && !filteredSongs.length && !youtubeChannelSuggestions.length && youtubeChannelSuggestionStatus !== "loading" && (!isYoutubeQuery || youtubeStatus !== "loading") && youtubeStatus !== "error" && (
              <div className="break-words px-4 py-3 font-body text-[1rem] text-ink-graphite-light">
                {isYoutubeChannelSuggestionQuery ? "No channels found" : isYoutubeQuery ? (youtubeMessage || "No videos found") : "No songs found"}
              </div>
            )}
          </div>
        )}
      </div>

      {isKeyGateOpen && (
        <form
          className="grid min-w-0 gap-3 overflow-x-hidden rounded-[8px] border border-ink-graphite/20 bg-paper-light/95 p-3 shadow-lg backdrop-blur-md"
          autoComplete="off"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="grid gap-2 rounded-[6px] border border-ink-blueprint/15 bg-ink-blueprint/5 px-3 py-2 font-body text-[0.92rem] text-ink-graphite">
            <div className="flex items-center justify-between gap-3">
              <span>Scribe time</span>
              <strong className="font-body text-[0.95rem] text-ink-blueprint">
                {billingStatus === "loading"
                  ? "Loading"
                  : entitlement
                    ? formatBalanceSeconds(entitlement.elevenLabsRemainingSeconds)
                    : "0m"}
              </strong>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-[6px] bg-ink-blueprint px-3 py-2 text-paper-light transition hover:bg-ink-blueprint/90 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={handleBuyScribeHour}
              disabled={billingStatus === "checkout"}
            >
              {billingStatus === "checkout" ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
              Buy 1h
            </button>
            {billingMessage && (
              <span className="break-words text-[0.82rem] leading-5 text-ink-red">
                {billingMessage}
              </span>
            )}
          </div>
          <label className="inline-flex flex-wrap items-center gap-2 font-body text-[0.98rem]">
            <input
              type="checkbox"
              checked={allowAutomaticYoutubeCaptions}
              onChange={(event) => useStore.setState({ allowAutomaticYoutubeCaptions: event.target.checked })}
            />
            YouTube(bad)auto caption
          </label>
          <p className="rounded-[6px] border border-ink-blueprint/15 bg-ink-blueprint/5 px-3 py-2 font-body text-[0.82rem] leading-5 text-ink-graphite">
            Gemini translation and media processing use server-side production credentials.
          </p>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="grid min-w-0 gap-1 font-body text-[0.95rem]">
              Source
              <input
                className="min-w-0 w-full rounded-[6px] border border-ink-graphite/25 bg-transparent px-2 py-1 outline-none focus:border-ink-blueprint"
                list="source-language-options"
                value={sourceLanguage}
                onChange={(event) => useStore.setState({ sourceLanguage: event.target.value })}
                placeholder="auto"
              />
            </label>
            <label className="grid min-w-0 gap-1 font-body text-[0.95rem]">
              Target
              <input
                className="min-w-0 w-full rounded-[6px] border border-ink-graphite/25 bg-transparent px-2 py-1 outline-none focus:border-ink-blueprint"
                list="target-language-options"
                value={targetLanguage}
                onChange={(event) => useStore.setState({ targetLanguage: event.target.value })}
                placeholder="en"
              />
            </label>
          </div>
          <datalist id="source-language-options">
            {["auto", "es", "en", "fi", "ja", "ko", "fr", "de", "it", "pt", "hi", "zh"].map((language) => (
              <option key={language} value={language} />
            ))}
          </datalist>
          <datalist id="target-language-options">
            {["en", "es", "fi", "ja", "ko", "fr", "de", "it", "pt", "hi", "zh"].map((language) => (
              <option key={language} value={language} />
            ))}
          </datalist>
          <label className="inline-flex flex-wrap items-center gap-2 font-body text-[0.98rem]">
            <input
              type="checkbox"
              checked={translationEnabled}
              onChange={(event) => useStore.setState({ translationEnabled: event.target.checked })}
            />
            Translate lyrics
          </label>
        </form>
      )}
    </section>
  );
}

function KeyField({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 font-body text-[0.95rem]">
      {label}
      <span className="flex items-center gap-2 rounded-[6px] border border-ink-graphite/25 px-2 py-1 focus-within:border-ink-blueprint">
        <input
          type="password"
          name={name}
          className="min-w-0 flex-1 bg-transparent outline-none"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="new-password"
        />
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-full text-ink-graphite-light transition hover:text-ink-red active:scale-95"
          aria-label={`Reset ${label} key`}
          title={`Reset ${label} key`}
          onClick={() => onChange("")}
        >
          <RotateCcw size={15} />
        </button>
      </span>
    </label>
  );
}

function formatTransferProgress(progress: LibraryTransferProgress) {
  const label = progress.phase === "exporting" ? "Exporting" : "Importing";
  const songTotal = progress.songsTotal || "?";
  const songPart = `${progress.songsDone}/${songTotal} songs`;
  const bytePart = progress.bytesTotal
    ? `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`
    : formatBytes(progress.bytesDone);
  const currentPart = progress.currentSong ? ` - ${progress.currentSong}` : "";

  return `${label} ${songPart} - ${bytePart}${currentPart}`;
}

function hasTranslations(segments: any[]) {
  return segments.some((segment) => String(segment?.translation || segment?.secondary || "").trim());
}

async function saveYoutubeCaptionTimingForSong(songId: string, caption: YoutubeCaptionTimingResult, state: any) {
  let outputSegments = Array.isArray(caption.segments) ? caption.segments : [];
  if (!outputSegments.length) throw new Error("No readable YouTube captions are available for this video.");

  const requestedSourceLanguage = normalizeLanguage(state.sourceLanguage);
  const sourceLanguage = requestedSourceLanguage || "auto";
  const targetLanguage = state.targetLanguage.trim() || getBrowserLanguageCode();
  const shouldTranslate = Boolean(state.translationEnabled && targetLanguage);
  let translationSource = hasTranslations(outputSegments) ? (caption.translationSource || "youtube-captions-timedtext") : "";
  let translationError = "";

  if (shouldTranslate && !translationSource) {
    try {
      const translationResult = await translateSegments({
        segments: outputSegments,
        sourceLanguage: requestedSourceLanguage,
        targetLanguage,
      });
      outputSegments = translationResult.segments;
      translationSource = translationResult.translationSource || "gemini";
    } catch (error) {
      translationError = getErrorMessage(error);
    }
  }

  const transcriptionSource = caption.transcriptionSource || caption.source;
  outputSegments = outputSegments.map((segment) => ({
    ...segment,
    source: segment?.source || transcriptionSource,
  }));
  if (translationSource) {
    outputSegments = annotateTranslatedSegments(outputSegments, translationSource);
  }

  const timingText = buildGeneratedTimingText({
    segments: outputSegments,
    sourceLanguage,
    targetLanguage,
    translationEnabled: shouldTranslate,
    translationSource,
    translationError,
    transcriptionSource,
    commitStrategy: "youtube-captions",
    manualCommitMarks: [],
    youtubeCaptionTrack: {
      videoId: caption.videoId,
      requestedLanguage: caption.requestedLanguage,
      languageCode: caption.languageCode,
      trackKind: caption.trackKind,
      trackName: caption.trackName,
      extractorSource: caption.extractorSource,
      automaticCaptionsAllowed: caption.automaticCaptionsAllowed,
      translationLanguageCode: caption.translationLanguageCode,
      translationTrackKind: caption.translationTrackKind,
      translationTrackName: caption.translationTrackName,
      translationSource: caption.translationSource,
    },
  });

  await saveSongTiming(songId, timingText);
  return { translationError, segmentCount: outputSegments.length };
}

type TimedDrawLetter = { key: string; text: string; start: number; end: number };
type TimedDrawWord = { key: string; text: string; letters: TimedDrawLetter[] };

function getTimedLetterText(value: any) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value.text ?? value.character ?? value.char ?? "");
}

function getTimedLettersFromWord(word: any, wordIndex: number): TimedDrawLetter[] {
  const text = String(word?.text || word?.word || "");
  const rawLetters = Array.isArray(word?.letters) ? word.letters : [];
  if (rawLetters.length) {
    return rawLetters
      .map((letter: any, letterIndex: number) => {
        const start = Number(letter?.start);
        const rawEnd = Number(letter?.end);
        return {
          key: `w${wordIndex}-l${letterIndex}`,
          text: getTimedLetterText(letter),
          start,
          end: Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : NaN,
        };
      })
      .filter((letter) => letter.text && Number.isFinite(letter.start))
      .map((letter, letterIndex, letters) => ({
        ...letter,
        end: Number.isFinite(letter.end)
          ? letter.end
          : Number.isFinite(letters[letterIndex + 1]?.start)
            ? Math.max(letter.start + 0.01, letters[letterIndex + 1].start)
            : Math.max(letter.start + 0.04, Number(word?.end) || letter.start + 0.04),
      }));
  }

  const start = Number(word?.start);
  const end = Number(word?.end);
  if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const chars = Array.from(text);
  return chars.map((char, letterIndex) => ({
    key: `w${wordIndex}-f${letterIndex}`,
    text: char,
    start: start + ((end - start) * letterIndex) / Math.max(1, chars.length),
    end: start + ((end - start) * (letterIndex + 1)) / Math.max(1, chars.length),
  }));
}

function getTimedLetterWordsFromTimeline(segment: any): TimedDrawWord[] {
  const timeline = Array.isArray(segment?.characterTimeline) ? segment.characterTimeline : [];
  const letters = timeline
    .map((item: any, index: number) => {
      const start = Number(item?.start);
      const rawEnd = Number(item?.end);
      return {
        key: `c${index}`,
        text: getTimedLetterText(item),
        start,
        end: Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : NaN,
      };
    })
    .filter((item) => item.text && Number.isFinite(item.start))
    .map((letter, index, items) => ({
      ...letter,
      end: Number.isFinite(letter.end)
        ? letter.end
        : Number.isFinite(items[index + 1]?.start)
          ? Math.max(letter.start + 0.01, items[index + 1].start)
          : letter.start + 0.04,
    }));

  const groups: TimedDrawWord[] = [];
  let current: TimedDrawLetter[] = [];

  const flush = () => {
    if (!current.length) return;
    groups.push({
      key: `ctw-${groups.length}`,
      text: current.map((letter) => letter.text).join(""),
      letters: current,
    });
    current = [];
  };

  for (const letter of letters) {
    if (/\s/u.test(letter.text)) {
      flush();
    } else {
      current.push(letter);
    }
  }
  flush();

  return groups;
}

function getTimedLetterWords(segment: any): TimedDrawWord[] {
  const words = Array.isArray(segment?.words) ? segment.words : [];
  const groupedWords = words
    .map((word, wordIndex): TimedDrawWord | null => {
      const letters = getTimedLettersFromWord(word, wordIndex);
      if (!letters.length) return null;

      return {
        key: `w${wordIndex}`,
        text: String(word?.text || word?.word || letters.map((letter) => letter.text).join("")),
        letters,
      };
    })
    .filter((group): group is TimedDrawWord => Boolean(group));

  if (groupedWords.length) return groupedWords;
  return getTimedLetterWordsFromTimeline(segment);
}

function getTimedWordReveal(word: TimedDrawWord, currentTime: number) {
  if (!word.letters.length) return 0;
  if (currentTime < word.letters[0].start) return 0;

  let revealUnits = 0;
  for (let index = 0; index < word.letters.length; index += 1) {
    const letter = word.letters[index];
    const start = Number(letter.start);
    const end = Number.isFinite(letter.end) && letter.end > start
      ? letter.end
      : Math.max(start + 0.04, word.letters[index + 1]?.start || start + 0.04);

    if (currentTime >= end) {
      revealUnits = index + 1;
      continue;
    }

    if (currentTime >= start) {
      revealUnits = index + Math.max(0, Math.min(1, (currentTime - start) / (end - start)));
    }
    break;
  }

  return Math.max(0, Math.min(1, revealUnits / word.letters.length));
}

export function PlayerView() {
  const selectedAudioId = useStore((state) => state.selectedAudioId);
  const audioFiles = useStore((state) => state.audioFiles);
  const segments = useStore((state) => state.segments);
  const currentSegmentIndex = useStore((state) => state.currentSegmentIndex);
  const scribeStatus = useStore((state) => state.scribeStatus);
  const scribeMessage = useStore((state) => state.scribeMessage);
  const manualCommitMarks = useStore((state) => state.manualCommitMarks);
  const lastManualCommitAt = useStore((state) => state.lastManualCommitAt);
  const commitFeedback = useStore((state) => state.commitFeedback);

  const visualizerRef = useRef<MusicLyricRenderer | null>(null);
  const rafId = useRef<number>(0);
  const scribeAbortRef = useRef<AbortController | null>(null);
  const activeSongIdRef = useRef<string | null>(null);
  const activeModeRef = useRef<"full" | null>(null);
  const completedSongIdsRef = useRef<Set<string>>(new Set());
  const failedSongIdsRef = useRef<Set<string>>(new Set());
  const sectionStartRef = useRef(0);
  const sectionEndRef = useRef<number>(NaN);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const explicitYoutubeLookupRef = useRef("");
  const manualYoutubeRefreshInputRef = useRef("");
  const handledYoutubeRefreshNonceRef = useRef(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isKeyGateOpen, setIsKeyGateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [libraryTransferStatus, setLibraryTransferStatus] = useState("");
  const [isLibraryTransferBusy, setIsLibraryTransferBusy] = useState(false);
  const [youtubeResults, setYoutubeResults] = useState<YoutubeVideoPreview[]>([]);
  const [youtubeStatus, setYoutubeStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [youtubeMessage, setYoutubeMessage] = useState("");
  const [youtubeImportingVideoId, setYoutubeImportingVideoId] = useState("");
  const [youtubeRefreshNonce, setYoutubeRefreshNonce] = useState(0);
  const [isSectionMode, setIsSectionMode] = useState(false);
  const [isSectionFinishing, setIsSectionFinishing] = useState(false);
  const [isTranslationRangePlaying, setIsTranslationRangePlaying] = useState(false);
  const [isReplacingTranslations, setIsReplacingTranslations] = useState(false);
  const [sectionStart, setSectionStart] = useState(0);
  const [theme, setTheme] = useState<MusicLyricTheme>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("visualizer_theme") as MusicLyricTheme) || "sketchbook";
    }
    return "sketchbook";
  });
  const primaryRef = useRef<HTMLDivElement>(null);
  const translationRef = useRef<HTMLDivElement>(null);
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef(currentTime);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const song = audioFiles.find((audio) => audio.id === selectedAudioId) || null;
  const timingData = useMemo(() => parseTimingTextCache(song), [song?.timing?.textCache]);
  const transcriptSourceSummary = useMemo(() => getTranscriptSourceSummary(segments, timingData), [segments, timingData]);
  const translationSourceSummary = useMemo(() => getTranslationSourceSummary(segments, timingData), [segments, timingData]);
  const currentSegment = currentSegmentIndex >= 0 ? segments[currentSegmentIndex] : null;
  const activeSegment = musicLyricSegmentAt(segments, currentTime);
  const displaySegment = musicLyricDisplaySegmentAt(segments, currentTime) || currentSegment;
  const cueExiting = Boolean(displaySegment && activeSegment && displaySegment !== activeSegment);
  const isCapturing = Boolean(song && activeSongIdRef.current === song.id && scribeStatus !== "saved" && scribeStatus !== "error");
  const isSectionCapturing = false;
  const nextCommitAt = lastManualCommitAt > 0 ? lastManualCommitAt + MIN_COMMIT_SEGMENT_SECONDS : MIN_COMMIT_SEGMENT_SECONDS;
  const autoCommitAt = lastManualCommitAt > 0 ? lastManualCommitAt + AUTO_COMMIT_SEGMENT_SECONDS : AUTO_COMMIT_SEGMENT_SECONDS;
  const nextCommitAtDisplay = duration > 0 ? Math.min(nextCommitAt, duration) : nextCommitAt;
  const autoCommitAtDisplay = duration > 0 ? Math.min(autoCommitAt, duration) : autoCommitAt;
  const isBackendProcessing = Boolean(
    song && (
      isReplacingTranslations ||
      (activeSongIdRef.current === song.id && (
        isSectionFinishing ||
        scribeStatus === "translating" ||
        scribeStatus === "transcribing"
      ))
    )
  );
  const showCommitControls = false;
  const canCommit = false;
  const commitProgressTarget = Math.max(lastManualCommitAt, autoCommitAtDisplay);
  const commitProgress = 1;
  const statusTitle = !song
    ? "Drop"
    : isReplacingTranslations
      ? "Translate"
    : isTranslationRangePlaying
      ? "Range"
    : isBackendProcessing
      ? (scribeStatus === "translating" ? "Translate" : "Syncing")
    : scribeStatus === "preparing"
          ? "Prep"
          : scribeStatus === "transcribing"
            ? "Syncing"
          : scribeStatus === "saved"
            ? "Saved"
            : scribeStatus === "error"
              ? "Error"
              : isPlaying
                ? "Play"
                : "Ready";
  const statusDetail = !song
    ? "Add audio to begin."
    : isReplacingTranslations
      ? (commitFeedback || "Replacing range.")
    : isTranslationRangePlaying
      ? `${formatClock(sectionStart)} - ${formatClock(currentTime)}`
    : isBackendProcessing
      ? (scribeStatus === "translating"
          ? "Translating."
          : "Finalizing transcript.")
    : (commitFeedback || (duration ? `${formatClock(currentTime)} / ${formatClock(duration)}` : " "));

  useEffect(() => {
    const input = query.trim();
    if (!input) {
      explicitYoutubeLookupRef.current = "";
      setYoutubeResults([]);
      setYoutubeStatus("idle");
      setYoutubeMessage("");
      return;
    }

    const lookupInput = input;
    const youtubeKind = getYoutubeInputKind(lookupInput);
    const isYoutubeUrlQuery = isYoutubeUrlInput(input) || input.startsWith("@");
    const isExplicitChannelLookup = explicitYoutubeLookupRef.current === lookupInput;
    const shouldResolveYoutube = Boolean(
      youtubeKind && (youtubeKind === "video" || isDirectYoutubeLookup(lookupInput) || isExplicitChannelLookup)
    );
    const hasLocalMatches = !isYoutubeUrlQuery && input
      ? audioFiles.some((song) => matchesSearchText(song.name, input) || matchesSearchText(cleanTitle(song.name), input))
      : false;

    if (!youtubeKind || !shouldResolveYoutube || (hasLocalMatches && !isExplicitChannelLookup && !isDirectYoutubeLookup(lookupInput))) {
      setYoutubeResults([]);
      setYoutubeStatus("idle");
      setYoutubeMessage("");
      return;
    }

    const controller = new AbortController();
    const forceRefresh = youtubeRefreshNonce > handledYoutubeRefreshNonceRef.current && manualYoutubeRefreshInputRef.current === lookupInput;
    if (forceRefresh) handledYoutubeRefreshNonceRef.current = youtubeRefreshNonce;
    const cached = getCachedYoutubeResolve(lookupInput, { allowStale: true });

    if (cached) {
      setYoutubeResults(cached.result.videos);
      setYoutubeStatus(cached.isFresh && !forceRefresh ? "ready" : "loading");
      setYoutubeMessage(getYoutubeResolveMessage(cached.result));
      if (cached.isFresh && !forceRefresh) return;
    } else {
      setYoutubeResults([]);
      setYoutubeStatus("loading");
      setYoutubeMessage(youtubeKind === "channel" ? "Loading channel" : "Loading video");
    }

    const resolveDelay = cached
      ? YOUTUBE_CACHED_RESOLVE_DELAY_MS
      : youtubeKind === "video"
        ? YOUTUBE_VIDEO_RESOLVE_DELAY_MS
        : YOUTUBE_DIRECT_CHANNEL_RESOLVE_DELAY_MS;

    const timeoutId = window.setTimeout(async () => {
      try {
        const result = await resolveYoutubeInput(lookupInput, controller.signal, {
          forceRefresh,
          allowCache: !forceRefresh && !cached,
        });
        if (controller.signal.aborted) return;
        setYoutubeResults(result.videos);
        setYoutubeStatus("ready");
        setYoutubeMessage(getYoutubeResolveMessage(result));
      } catch (error: any) {
        if (controller.signal.aborted) return;
        if (cached) {
          setYoutubeResults(cached.result.videos);
          setYoutubeStatus("ready");
          setYoutubeMessage(getYoutubeResolveMessage(cached.result));
          return;
        }
        setYoutubeResults([]);
        setYoutubeStatus("error");
        setYoutubeMessage(getErrorMessage(error));
      }
    }, resolveDelay);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [audioFiles, query, youtubeRefreshNonce]);

  useEffect(() => {
    const canvas = document.getElementById("visualizer-canvas") as HTMLCanvasElement | null;
    if (!canvas) return;

    let visualizer: MusicLyricRenderer | undefined;
    let disposed = false;
    let frame = 0;

    void createMusicLyricVisualizer(theme, canvas)
      .then((created) => {
        if (disposed) {
          created.destroy?.();
          return;
        }
        visualizer = created;
        const reactivity = new MusicLyricReactivity();
        let layout = measureLyricLayout(canvas, primaryRef.current, translationRef.current);
        let lastLayoutAt = 0;
        const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

        const draw = (now = performance.now()) => {
          if (disposed || !visualizer) return;
          if (now - lastLayoutAt >= 80) {
            layout = measureLyricLayout(canvas, primaryRef.current, translationRef.current);
            lastLayoutAt = now;
          }
          const { analyser, dataFrequency, dataTime } = useStore.getState();
          const totalDuration = Number(duration) || Number(song?.durationSeconds) || 198;
          const progress = Math.max(0, Math.min(1, currentTimeRef.current / Math.max(0.01, totalDuration)));

          const visualFrame = reactivity.sample(
            analyser ?? undefined,
            dataFrequency ?? undefined,
            dataTime ?? undefined,
            progress,
            layout,
            now
          );

          visualizer.draw(visualFrame);

          if (stageContainerRef.current) {
            applyMusicLyricFrameStyles(stageContainerRef.current, visualFrame);
          }

          if (!reducedMotion) {
            frame = requestAnimationFrame(draw);
          }
        };

        draw();
      })
      .catch(console.error);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      visualizer?.destroy?.();
    };
  }, [theme, song?.id, duration]);

  useEffect(() => {
    const audioEl = getAudioElement();
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = (event: Event) => {
      const audioTarget = event.currentTarget as HTMLAudioElement;
      setIsPlaying(false);
      setCurrentTime(audioTarget.duration || audioTarget.currentTime || 0);
    };
    const onTimeUpdate = (event: Event) => setCurrentTime((event.currentTarget as HTMLAudioElement).currentTime);
    const onLoadedMeta = (event: Event) => setDuration((event.currentTarget as HTMLAudioElement).duration || 0);

    audioEl.addEventListener("play", onPlay);
    audioEl.addEventListener("pause", onPause);
    audioEl.addEventListener("ended", onEnded);
    audioEl.addEventListener("timeupdate", onTimeUpdate);
    audioEl.addEventListener("loadedmetadata", onLoadedMeta);

    setIsPlaying(!audioEl.paused);
    setCurrentTime(audioEl.currentTime);
    setDuration(audioEl.duration || 0);

    return () => {
      audioEl.removeEventListener("play", onPlay);
      audioEl.removeEventListener("pause", onPause);
      audioEl.removeEventListener("ended", onEnded);
      audioEl.removeEventListener("timeupdate", onTimeUpdate);
      audioEl.removeEventListener("loadedmetadata", onLoadedMeta);
    };
  }, []);

  useEffect(() => {
    let index = -1;
    const grace = 0.08;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      if (currentTime >= seg.start - grace && currentTime <= seg.end + grace) {
        index = i;
        break;
      }
    }
    if (index !== currentSegmentIndex) {
      useStore.setState({ currentSegmentIndex: index });
    }
  }, [currentTime, segments, currentSegmentIndex]);

  const ensureAudioGraph = useCallback(async (audioEl: HTMLAudioElement) => {
    let { audioContext, analyser, dataFrequency, dataTime, sourceNode } = useStore.getState();

    if (!audioContext) {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.68;
      analyser.minDecibels = -92;
      analyser.maxDecibels = -12;
      dataFrequency = new Uint8Array(analyser.frequencyBinCount);
      dataTime = new Uint8Array(analyser.fftSize);
    }

    if (!sourceNode && analyser) {
      sourceNode = audioContext.createMediaElementSource(audioEl);
      sourceNode.connect(analyser);
      analyser.connect(audioContext.destination);
    }

    useStore.setState({ audioContext, analyser, dataFrequency, dataTime, sourceNode });

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  }, []);

  const seekToTime = useCallback((seconds: number) => {
    const audioEl = getAudioElement();
    const safeDuration = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : duration;
    const safeTime = Math.max(0, Math.min(Number.isFinite(safeDuration) && safeDuration > 0 ? safeDuration : seconds, seconds));
    audioEl.currentTime = safeTime;
    setCurrentTime(safeTime);
    return safeTime;
  }, [duration]);

  const playCurrentSong = useCallback(async (fromSeconds?: number) => {
    if (!song?.url) return false;
    const audioEl = getAudioElement();
    if (audioEl.src !== song.url) {
      audioEl.src = song.url;
      audioEl.load();
    }
    if (Number.isFinite(fromSeconds)) {
      const safeTime = Math.max(0, Math.min(Number(fromSeconds), Number.isFinite(audioEl.duration) ? audioEl.duration : Number(fromSeconds)));
      audioEl.currentTime = safeTime;
      setCurrentTime(safeTime);
    }

    try {
      await ensureAudioGraph(audioEl);
      await audioEl.play();
      return true;
    } catch {
      return false;
    }
  }, [ensureAudioGraph, song?.url]);

  useEffect(() => {
    if (!song?.url) return;
    const audioEl = getAudioElement();
    if (audioEl.src !== song.url) {
      audioEl.src = song.url;
      audioEl.load();
      setCurrentTime(0);
      setDuration(0);
    }
    playCurrentSong();
  }, [playCurrentSong, song?.id, song?.url]);

  useEffect(() => {
    setIsSectionMode(false);
    setIsSectionFinishing(false);
    setIsTranslationRangePlaying(false);
    setIsReplacingTranslations(false);
    setSectionStart(0);
    sectionStartRef.current = 0;
    sectionEndRef.current = NaN;
  }, [song?.id]);

  const startScribe = useCallback(async () => {
    if (!song?.id || !song.file) return false;

    scribeAbortRef.current?.abort();
    const controller = new AbortController();
    scribeAbortRef.current = controller;

    const state = useStore.getState();
    const sourceLanguage = normalizeLanguage(state.sourceLanguage);
    const targetLanguage = state.targetLanguage.trim() || getBrowserLanguageCode();
    const audioDuration = Number(getAudioElement().duration) ||
      Number(song.durationSeconds) ||
      Number(song.youtubeDurationSeconds) ||
      0;

    sectionStartRef.current = 0;
    sectionEndRef.current = NaN;
    activeSongIdRef.current = song.id;
    activeModeRef.current = "full";
    setIsSectionFinishing(false);

    useStore.setState({
      scribeStatus: "preparing",
      scribeMessage: "Preparing audio",
      manualCommitMarks: [],
      lastManualCommitAt: 0,
      commitFeedback: "",
    });

    try {
      useStore.setState({ scribeStatus: "transcribing", scribeMessage: "Syncing" });

      const payload = await createScribeTranscript({
        file: song.file,
        sourceLanguage,
        estimatedDurationSeconds: audioDuration,
        songName: song.name,
        songBase: song.base,
        youtubeTitle: song.youtubeTitle || song.youtubeVideoTitle || "",
        youtubeChannelTitle: song.youtubeChannelTitle || "",
      }, controller.signal);

      if (controller.signal.aborted || activeSongIdRef.current !== song.id || activeModeRef.current !== "full") {
        return false;
      }

      let outputSegments = Array.isArray(payload.segments) ? payload.segments : [];
      if (!outputSegments.length) {
        throw new Error("Scribe did not return lyric segments for this audio.");
      }

      let translationSource = "";
      let translationError = "";
      const latest = useStore.getState();
      const detectedSourceLanguage = sourceLanguage || payload.languageCode || "auto";

      if (latest.translationEnabled) {
        useStore.setState({ scribeStatus: "translating", scribeMessage: "Translating" });
        try {
          const translationResult = await translateSegments({
            segments: outputSegments,
            sourceLanguage: detectedSourceLanguage === "auto" ? "" : detectedSourceLanguage,
            targetLanguage,
          });
          outputSegments = translationResult.segments;
          translationSource = translationResult.translationSource || "gemini";
          outputSegments = annotateTranslatedSegments(outputSegments, translationSource);
        } catch (error: any) {
          translationError = getErrorMessage(error);
        }
      }

      const finalSegments = ensureSegmentTranslationSources(outputSegments, "");
      const finalTranslationSource = getAggregateTranslationSource(finalSegments, translationSource);
      const timingText = buildGeneratedTimingText({
        segments: finalSegments,
        sourceLanguage: detectedSourceLanguage,
        targetLanguage,
        translationEnabled: latest.translationEnabled,
        translationSource: finalTranslationSource,
        translationError,
        transcriptionSource: payload.source || "elevenlabs-scribe-v2",
        commitStrategy: "batch",
        manualCommitMarks: [],
      });

      await saveSongTiming(song.id, timingText);
      completedSongIdsRef.current.add(song.id);
      activeSongIdRef.current = null;
      activeModeRef.current = null;
      if (scribeAbortRef.current === controller) scribeAbortRef.current = null;
      setIsSectionFinishing(false);
      useStore.setState({
        scribeStatus: "saved",
        scribeMessage: translationError ? "Synced without translation" : "Synced",
        commitFeedback: translationError || "",
      });
      return true;
    } catch (error: any) {
      if (controller.signal.aborted) return false;
      activeSongIdRef.current = null;
      activeModeRef.current = null;
      if (scribeAbortRef.current === controller) scribeAbortRef.current = null;
      setIsSectionFinishing(false);
      failedSongIdsRef.current.add(song.id);
      useStore.setState({
        scribeStatus: "error",
        scribeMessage: "Scribe failed",
        commitFeedback: getErrorMessage(error),
      });
      return false;
    }
  }, [song?.id, song?.file, song?.name, song?.base, song?.youtubeTitle, song?.youtubeVideoTitle, song?.youtubeChannelTitle, song?.durationSeconds, song?.youtubeDurationSeconds]);

  useEffect(() => {
    if (!song?.id) return;

    if (activeSongIdRef.current && activeSongIdRef.current !== song.id) {
      scribeAbortRef.current?.abort();
      scribeAbortRef.current = null;
      activeSongIdRef.current = null;
      activeModeRef.current = null;
      useStore.setState({
        manualCommitMarks: [],
        lastManualCommitAt: 0,
        commitFeedback: "",
      });
    }

    if (activeSongIdRef.current === song.id) return;

    if (isSectionMode) {
      useStore.setState({
        scribeStatus: "idle",
        scribeMessage: "Translation range",
        manualCommitMarks: [],
        lastManualCommitAt: sectionStart,
      });
      return;
    }

    if (song.timing) {
      useStore.setState({
        scribeStatus: "saved",
        scribeMessage: "Synced",
        manualCommitMarks: [],
        lastManualCommitAt: 0,
        commitFeedback: "",
      });
      return;
    }

    if (!song.file) {
      useStore.setState({ scribeStatus: "idle", scribeMessage: "Audio unavailable" });
      return;
    }

    if (!isPlaying) {
      useStore.setState({
        scribeStatus: "idle",
        scribeMessage: "Ready",
        manualCommitMarks: [],
        lastManualCommitAt: 0,
        commitFeedback: "",
      });
      return;
    }

    if (completedSongIdsRef.current.has(song.id) || failedSongIdsRef.current.has(song.id)) return;
    void startScribe();
  }, [isPlaying, isSectionMode, sectionStart, song?.id, song?.file, song?.timing, startScribe]);

  const startTranslationRangePreview = useCallback(async () => {
    if (!song?.timing || isReplacingTranslations) return;
    const start = seekToTime(sectionStart);
    const didPlay = await playCurrentSong(start);
    if (!didPlay) {
      useStore.setState({ commitFeedback: "Playback could not start." });
      return;
    }

    setIsTranslationRangePlaying(true);
    useStore.setState({
      scribeStatus: "idle",
      scribeMessage: "Translation range",
      commitFeedback: `${formatClock(start)} - pick end`,
      manualCommitMarks: [],
      lastManualCommitAt: start,
    });
  }, [isReplacingTranslations, playCurrentSong, sectionStart, seekToTime, song?.timing]);

  const replaceTranslationsInSelectedRange = useCallback(async () => {
    if (!song?.id || !song.timing || isReplacingTranslations) return;

    const rawStart = sectionStartRef.current;
    const rawEnd = Number(currentTime.toFixed(3));
    const start = Math.max(0, Math.min(rawStart, rawEnd));
    const end = Math.max(rawStart, rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.25) {
      useStore.setState({ commitFeedback: "Choose an end point." });
      return;
    }

    const latestSegments = useStore.getState().segments;
    const rangeSegments = latestSegments
      .filter((segment) => doesSegmentOverlapRange(segment, start, end))
      .filter((segment) => getSegmentTextForTranslation(segment));
    if (!rangeSegments.length) {
      useStore.setState({ commitFeedback: "No lyrics in range." });
      return;
    }

    const audioEl = getAudioElement();
    audioEl.pause();
    setIsTranslationRangePlaying(false);
    setIsReplacingTranslations(true);

    const latest = useStore.getState();
    const targetLanguage = latest.targetLanguage.trim() || getBrowserLanguageCode();
    const sourceLanguage = normalizeLanguage(latest.sourceLanguage);
    const translationRangeLabel = `${formatClock(start)} - ${formatClock(end)}`;
    useStore.setState({
      scribeStatus: "translating",
      scribeMessage: "Translate",
      commitFeedback: translationRangeLabel,
      manualCommitMarks: [],
      lastManualCommitAt: start,
    });

    try {
      const translationResult = await translateSegments({
        segments: rangeSegments.map(clearSegmentTranslation),
        sourceLanguage,
        targetLanguage,
      });
      const translationSource = translationResult.translationSource || "gemini";
      const timingSnapshot = parseTimingTextCache(song);
      const existingTranslationSource = String(timingSnapshot?.translationSource || timingSnapshot?.youtubeCaptionTrack?.translationSource || "");
      const nextSegments = mergeTranslatedSegmentsInRange(
        latestSegments,
        translationResult.segments,
        start,
        end,
        translationSource,
        existingTranslationSource,
      );
      const timingText = buildTimingTextFromExisting(song, timingSnapshot, nextSegments, {
        sourceLanguage: sourceLanguage || timingSnapshot?.sourceLanguage || "auto",
        targetLanguage: targetLanguage || timingSnapshot?.targetLanguage || getBrowserLanguageCode(),
        translationSource: getAggregateTranslationSource(nextSegments, translationSource || existingTranslationSource),
      });

      await saveSongTiming(song.id, timingText);
      setIsSectionMode(false);
      sectionStartRef.current = 0;
      useStore.setState({
        scribeStatus: "saved",
        scribeMessage: "Translations saved",
        commitFeedback: translationRangeLabel,
        manualCommitMarks: [],
        lastManualCommitAt: 0,
      });
    } catch (error: any) {
      useStore.setState({
        scribeStatus: "error",
        scribeMessage: "Translation failed",
        commitFeedback: getErrorMessage(error),
      });
    } finally {
      setIsReplacingTranslations(false);
    }
  }, [currentTime, isReplacingTranslations, song]);

  const handleToggleSectionMode = useCallback(() => {
    const canUseRangeMode = Boolean(song?.timing && segments.length);
    if (!canUseRangeMode || isCapturing || isSectionFinishing || isReplacingTranslations) return;
    const next = !isSectionMode;
    setIsSectionMode(next);
    setIsTranslationRangePlaying(false);
    const start = seekToTime(currentTime);
    if (next || isTranslationRangePlaying) {
      getAudioElement().pause();
    }
    setSectionStart(start);
    sectionStartRef.current = start;
    useStore.setState({
      scribeMessage: next ? "Translation range" : (song?.timing ? "Synced" : "Ready"),
      commitFeedback: next ? `${formatClock(start)} / ${formatClock(duration)}` : "",
      manualCommitMarks: [],
      lastManualCommitAt: next ? start : 0,
    });
  }, [currentTime, duration, isCapturing, isReplacingTranslations, isSectionFinishing, isSectionMode, isTranslationRangePlaying, seekToTime, segments.length, song?.timing]);

  const handleSliderChange = useCallback((value: number) => {
    const safeValue = Math.max(0, Math.min(Number.isFinite(duration) && duration > 0 ? duration : value, value));
    if (isSectionMode && !isCapturing) {
      setSectionStart(safeValue);
      sectionStartRef.current = safeValue;
      seekToTime(safeValue);
      useStore.setState({
        lastManualCommitAt: safeValue,
        commitFeedback: `${formatClock(safeValue)} / ${formatClock(duration)}`,
      });
      return;
    }
    seekToTime(safeValue);
  }, [duration, isCapturing, isSectionMode, seekToTime]);

  const handleTransportClick = useCallback(() => {
    if (!song) return;
    if (isSectionMode) {
      if (isTranslationRangePlaying || currentTime > sectionStartRef.current + 0.25) {
        replaceTranslationsInSelectedRange();
      } else {
        startTranslationRangePreview();
      }
      return;
    }
    if (isPlaying && song.timing) {
      getAudioElement().pause();
      return;
    }
    if (!isPlaying) {
      playCurrentSong();
    }
  }, [currentTime, isPlaying, isSectionMode, isTranslationRangePlaying, playCurrentSong, replaceTranslationsInSelectedRange, song, startTranslationRangePreview]);

  const handleStageClick = async (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-control]")) return;
    if (!song) {
      setIsSearchOpen(true);
      return;
    }
    if (isSectionFinishing || isBackendProcessing) return;
    if (isSectionMode) {
      if (isTranslationRangePlaying || currentTime > sectionStartRef.current + 0.25) {
        await replaceTranslationsInSelectedRange();
      } else {
        await startTranslationRangePreview();
      }
      return;
    }
    if (isCapturing) return;
    if (!isPlaying) {
      await playCurrentSong();
    } else if (song.timing) {
      getAudioElement().pause();
    }
  };

  const handleSelectSong = async (songId: string) => {
    await loadSongSegments(songId);
    setQuery("");
    setIsSearchOpen(false);
  };

  const handleSelectYoutubeChannel = useCallback((suggestion: YoutubeChannelSuggestion) => {
    const lookupInput = (suggestion.lookupInput || suggestion.url || suggestion.title).trim();
    if (!lookupInput) return;

    explicitYoutubeLookupRef.current = lookupInput;
    setIsSearchOpen(true);
    setQuery(lookupInput);

    if (suggestion.result) {
      setYoutubeResults(suggestion.result.videos);
      setYoutubeStatus("ready");
      setYoutubeMessage(getYoutubeResolveMessage(suggestion.result));
      return;
    }

    setYoutubeResults([]);
    setYoutubeStatus("loading");
    setYoutubeMessage("Loading channel");
  }, []);

  const handleRefreshYoutube = useCallback(() => {
    const input = query.trim();
    const lookupInput = input;
    if (!getYoutubeInputKind(lookupInput)) return;
    explicitYoutubeLookupRef.current = lookupInput;
    manualYoutubeRefreshInputRef.current = lookupInput;
    setYoutubeRefreshNonce((value) => value + 1);
  }, [query]);

  const handlePersistYoutube = useCallback(async (video: YoutubeVideoPreview) => {
    if (isLibraryTransferBusy || youtubeImportingVideoId) return;

    const existingSong = useStore.getState().audioFiles.find((audio) => audio.youtubeVideoId === video.videoId);
    if (existingSong) {
      await loadSongSegments(existingSong.id);
      setQuery("");
      setIsSearchOpen(false);
      return;
    }

    setIsLibraryTransferBusy(true);
    setYoutubeImportingVideoId(video.videoId);
    setLibraryTransferStatus(`Importing ${video.title}`);

    try {
      const importState = useStore.getState();
      const captionLanguage = normalizeLanguage(importState.sourceLanguage);
      const captionTargetLanguage = importState.translationEnabled ? (importState.targetLanguage.trim() || getBrowserLanguageCode()) : "";

      const result = await downloadYoutubeAudio(video);
      const importedAt = new Date().toISOString();
      const addedSongs = await addAudioFiles([result.file], {
        metadata: {
          source: "youtube",
          youtubeTitle: result.video.title,
          youtubeVideoId: result.video.videoId,
          youtubeUrl: result.video.url,
          youtubeChannelId: result.video.channelId,
          youtubeChannelTitle: result.video.channelTitle,
          youtubeThumbnailUrl: result.video.thumbnailUrl,
          youtubeImportedAt: importedAt,
          youtubePublishedAt: result.video.publishedAt,
          youtubeDurationSeconds: result.video.durationSeconds,
        },
      });
      const addedSong = addedSongs[0];
      if (!addedSong) throw new Error("YouTube audio could not be added to the library.");

      setLibraryTransferStatus(`Checking ${importState.allowAutomaticYoutubeCaptions ? "captions" : "manual captions"} for ${cleanTitle(addedSong.name)}`);
      const captionResult = await fetchYoutubeCaptionTiming(video, {
        lang: captionLanguage,
        targetLanguage: captionTargetLanguage,
        allowAutomaticCaptions: importState.allowAutomaticYoutubeCaptions,
      })
        .then((caption) => ({ caption, error: null as any }))
        .catch((error) => ({ caption: null, error }));
      if (captionResult.caption) {
        setLibraryTransferStatus(`Saving captions for ${cleanTitle(addedSong.name)}`);
        const timingResult = await saveYoutubeCaptionTimingForSong(addedSong.id, captionResult.caption, importState);
        setLibraryTransferStatus(
          timingResult.translationError
            ? `Imported and synced captions - translation skipped`
            : `Imported and synced captions`
        );
      } else {
        console.warn("YouTube captions unavailable; imported audio will use Scribe fallback:", getErrorMessage(captionResult.error));
        setLibraryTransferStatus(`Imported ${cleanTitle(addedSong.name)} - captions unavailable`);
      }

      await loadSongSegments(addedSong.id);
      setQuery("");
      setIsSearchOpen(false);
      setYoutubeResults((results) => results.map((item) => item.videoId === result.video.videoId ? result.video : item));
    } catch (error) {
      console.error("YouTube import failed", error);
      const message = getErrorMessage(error);
      setLibraryTransferStatus("YouTube import failed");
      setYoutubeStatus("error");
      setYoutubeMessage(message);
    } finally {
      setYoutubeImportingVideoId("");
      setIsLibraryTransferBusy(false);
    }
  }, [isLibraryTransferBusy, youtubeImportingVideoId]);

  const handleExportLibrary = useCallback(async () => {
    if (isLibraryTransferBusy) return;

    setIsLibraryTransferBusy(true);
    setLibraryTransferStatus("Preparing export");

    let lastProgressAt = 0;
    try {
      const result = await exportLibrary({
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastProgressAt < 250 && progress.songsDone !== progress.songsTotal) return;
          lastProgressAt = now;
          setLibraryTransferStatus(formatTransferProgress(progress));
        },
      });

      setLibraryTransferStatus(`Exported ${result.songs} songs - ${formatBytes(result.bytes)}`);
    } catch (error: any) {
      if (error?.name === "AbortError") {
        setLibraryTransferStatus("Export canceled");
      } else {
        console.error("Library export failed", error);
        setLibraryTransferStatus("Export failed");
      }
    } finally {
      setIsLibraryTransferBusy(false);
    }
  }, [isLibraryTransferBusy]);

  const handlePickImportLibrary = useCallback(() => {
    if (isLibraryTransferBusy) return;
    importInputRef.current?.click();
  }, [isLibraryTransferBusy]);

  const handleImportLibraryFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || isLibraryTransferBusy) return;

    setIsSearchOpen(true);
    setIsLibraryTransferBusy(true);
    setLibraryTransferStatus("Preparing import");

    const selectedBeforeImport = useStore.getState().selectedAudioId;
    let lastProgressAt = 0;

    try {
      const result = await importLibrary(file, {
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastProgressAt < 250 && progress.songsDone !== progress.songsTotal) return;
          lastProgressAt = now;
          setLibraryTransferStatus(formatTransferProgress(progress));
        },
      });

      const changedSongs = result.imported + result.updated;
      setLibraryTransferStatus(
        result.failed
          ? `Imported ${changedSongs} songs - ${result.failed} failed`
          : `Imported ${changedSongs} songs - ${formatBytes(result.bytes)}`
      );

      if (selectedBeforeImport && useStore.getState().audioFiles.some((audio) => audio.id === selectedBeforeImport)) {
        await loadSongSegments(selectedBeforeImport);
      } else if (!selectedBeforeImport && result.firstPlayableId) {
        await loadSongSegments(result.firstPlayableId);
      }
    } catch (error) {
      console.error("Library import failed", error);
      setLibraryTransferStatus("Import failed");
    } finally {
      setIsLibraryTransferBusy(false);
    }
  }, [isLibraryTransferBusy]);

  const handleClearAllData = useCallback(async () => {
    if (isLibraryTransferBusy) return;

    const shouldClear = window.confirm(
      "Clear all local songs, lyrics, imports, API keys, and settings from this browser? This cannot be undone."
    );
    if (!shouldClear) return;

    setIsLibraryTransferBusy(true);
    setLibraryTransferStatus("Clearing local data");

    try {
      scribeAbortRef.current?.abort();
      scribeAbortRef.current = null;
      activeSongIdRef.current = null;
      activeModeRef.current = null;
      completedSongIdsRef.current.clear();
      failedSongIdsRef.current.clear();
      sectionStartRef.current = 0;
      sectionEndRef.current = NaN;

      const state = useStore.getState();
      for (const audio of state.audioFiles) {
        if (audio?.url) URL.revokeObjectURL(audio.url);
      }
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);

      const audioEl = getAudioElement();
      audioEl.pause();
      audioEl.removeAttribute("src");
      audioEl.load();

      await clearPersistedUserData();
      useStore.setState({
        audioFiles: [],
        orphanTextItems: [],
        selectedAudioId: null,
        segments: [],
        currentSegmentIndex: -1,
        sourceLanguage: "",
        targetLanguage: getBrowserLanguageCode(),
        translationEnabled: true,
        allowAutomaticYoutubeCaptions: false,
        scribeStatus: "idle",
        scribeMessage: "",
        manualCommitMarks: [],
        lastManualCommitAt: 0,
        commitFeedback: "",
        objectUrl: null,
        seekLock: false,
        lastRenderSecond: -1,
      });

      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setQuery("");
      setYoutubeResults([]);
      setYoutubeStatus("idle");
      setYoutubeMessage("");
      setYoutubeImportingVideoId("");
      setIsKeyGateOpen(false);
      setIsSectionMode(false);
      setIsSectionFinishing(false);
      setIsTranslationRangePlaying(false);
      setIsReplacingTranslations(false);
      setSectionStart(0);
      setLibraryTransferStatus("Local data cleared");
    } catch (error) {
      console.error("Failed to clear local data", error);
      setLibraryTransferStatus("Clear failed");
    } finally {
      setIsLibraryTransferBusy(false);
    }
  }, [isLibraryTransferBusy]);

  const renderDrawnText = (isTranslation: boolean) => {
    if (!currentSegment) {
      if (isTranslation) return null;
      if (segments.length > 0) {
        const upcoming = segments.find((segment) => segment.start >= currentTime);
        return <span className="word-write text-ink-graphite-light">{upcoming ? "( Instrumental )" : "End of page"}</span>;
      }
      return <span className="word-write text-ink-graphite">{song ? cleanTitle(song.name) : "Drop a song"}</span>;
    }

    const words = currentSegment.words || [];
    const sourceString = isTranslation
      ? (currentSegment.translation || currentSegment.secondary || "")
      : currentSegment.primary;
    const isErasing = currentTime > currentSegment.end + (isTranslation ? 0.1 : 0.3);
    const timedLetterWords = isTranslation ? [] : getTimedLetterWords(currentSegment);

    if (timedLetterWords.length) {
      return timedLetterWords.map((word, wordIndex) => {
        const reveal = isErasing ? 1 : getTimedWordReveal(word, currentTime);
        const stateClass = isErasing
          ? "timed-word-reveal--erase"
          : reveal > 0
            ? "timed-word-reveal--write"
            : "timed-word-reveal--hidden";

        return (
          <React.Fragment key={word.key}>
            <span
              className={`timed-word-reveal ${stateClass}`}
              style={{ "--timed-word-hide": `${Math.max(0, Math.min(100, (1 - reveal) * 100))}%` } as React.CSSProperties}
            >
              <span className="timed-word-reveal__ghost">{word.text}</span>
              <span className="timed-word-reveal__ink">{word.text}</span>
            </span>
            {wordIndex < timedLetterWords.length - 1 ? " " : ""}
          </React.Fragment>
        );
      });
    }

    if (!words.length || isTranslation) {
      const strWords = sourceString.split(" ");
      if (!strWords.length || !strWords[0]) return null;

      const segmentDuration = currentSegment.end - currentSegment.start;
      const timePerWord = segmentDuration / strWords.length;

      return strWords.map((wordStr: string, index: number) => {
        const fakedStart = currentSegment.start + (index * timePerWord);
        const hasStarted = currentTime >= fakedStart;

        let className = "word-hidden";
        if (hasStarted && !isErasing) className = "word-write";
        else if (hasStarted && isErasing) className = "word-erase";

        return (
          <span key={index} className={className}>
            {wordStr}{index < strWords.length - 1 ? " " : ""}
          </span>
        );
      });
    }

    return words.map((word: any, wordIndex: number) => {
      const start = Number(word.start);
      const text = word.text || word.word || "";
      const hasStarted = currentTime >= start;

      let className = "word-hidden";
      if (hasStarted && !isErasing) className = "word-write";
      else if (hasStarted && isErasing) className = "word-erase";

      return (
        <span key={`w${wordIndex}`} className={className}>
          {text}{wordIndex < words.length - 1 ? " " : ""}
        </span>
      );
    });
  };

  return (
    <section
      className="player-view fixed inset-0 z-30 min-h-[100svh] cursor-pointer overflow-hidden bg-transparent"
      aria-label="Visualizer player"
      onClick={handleStageClick}
    >
      <div className="paper-grain-overlay pointer-events-none"></div>

      <SearchOverlay
        isOpen={isSearchOpen}
        query={query}
        setQuery={setQuery}
        isKeyGateOpen={isKeyGateOpen}
        setIsKeyGateOpen={setIsKeyGateOpen}
        onOpen={() => setIsSearchOpen(true)}
        onClose={() => setIsSearchOpen(false)}
        onExportLibrary={handleExportLibrary}
        onImportLibrary={handlePickImportLibrary}
        onClearAllData={handleClearAllData}
        onSelectSong={handleSelectSong}
        onSelectYoutubeChannel={handleSelectYoutubeChannel}
        onPersistYoutube={handlePersistYoutube}
        onRefreshYoutube={handleRefreshYoutube}
        libraryTransferStatus={libraryTransferStatus}
        isLibraryTransferBusy={isLibraryTransferBusy}
        youtubeResults={youtubeResults}
        youtubeStatus={youtubeStatus}
        youtubeMessage={youtubeMessage}
        youtubeImportingVideoId={youtubeImportingVideoId}
        currentTime={currentTime}
        duration={duration}
        sectionStart={sectionStart}
        isPlaying={isPlaying}
        isCapturing={isCapturing}
        showCommitControls={showCommitControls}
        isBackendProcessing={isBackendProcessing}
        isSectionMode={isSectionMode}
        isSectionFinishing={isSectionFinishing}
        isTranslationRangePlaying={isTranslationRangePlaying}
        transcriptSourceSummary={transcriptSourceSummary}
        translationSourceSummary={translationSourceSummary}
        canCommit={canCommit}
        nextCommitAt={nextCommitAtDisplay}
        autoCommitAt={autoCommitAtDisplay}
        commitProgress={commitProgress}
        manualCommitMarks={manualCommitMarks}
        scribeMessage={statusTitle}
        commitFeedback={statusDetail}
        onSliderChange={handleSliderChange}
        onToggleSectionMode={handleToggleSectionMode}
        onTransportClick={handleTransportClick}
      />
      <input
        ref={importInputRef}
        type="file"
        accept=".ndjson,application/x-ndjson,text/plain"
        className="hidden"
        data-control="true"
        onChange={handleImportLibraryFile}
      />

      {/* Theme Switcher Button */}
      <div className="fixed right-4 top-4 z-40 flex items-center gap-2" data-control="true">
        <button
          type="button"
          className={`flex items-center gap-2 rounded-full px-4 py-1.5 font-display text-[0.88rem] font-bold shadow-md backdrop-blur-md transition active:scale-95 ${
            theme === "signal-bloom"
              ? "border border-cyan-400/40 bg-neutral-900/90 text-cyan-300 shadow-cyan-500/20 hover:border-cyan-400"
              : "border border-ink-blueprint/25 bg-paper-light/95 text-ink-graphite shadow-black/10 hover:border-ink-blueprint"
          }`}
          onClick={() => {
            const next = theme === "sketchbook" ? "signal-bloom" : "sketchbook";
            setTheme(next);
            if (typeof window !== "undefined") {
              window.localStorage.setItem("visualizer_theme", next);
            }
          }}
          title="Toggle Visualizer Theme: Living Sketchbook vs Signal Bloom"
        >
          <Palette size={14} className={theme === "signal-bloom" ? "text-cyan-400" : "text-amber-600"} />
          <span>{theme === "signal-bloom" ? "Signal Bloom" : "Living Sketchbook"}</span>
        </button>
      </div>

      <div
        ref={stageContainerRef}
        className={`stage-shell grid h-[100svh] w-full place-items-stretch transition-colors duration-500 ${
          theme === "signal-bloom" ? "theme-signal-bloom bg-[#08090c]" : "bg-[#f4eee1]"
        }`}
        aria-label="Visualizer stage"
      >
        <section className="stage pointer-events-none relative h-[100svh] w-full" tabIndex={0}>
          <canvas id="visualizer-canvas" className="absolute inset-0 z-[2] h-full w-full"></canvas>

          <div
            className="stage-meta pointer-events-none absolute top-[30px] z-10 flex justify-between gap-4 opacity-45 mix-blend-multiply transition-opacity"
            style={{
              left: "calc(max(50px, 4vw) + max(24px, 5vw))",
              right: "max(24px, 5vw)",
            }}
          >
            <span className="max-w-[55%] truncate font-display text-[clamp(1.4rem,4vw,2rem)] text-ink-graphite">
              {song?.name || (theme === "signal-bloom" ? "Signal Bloom" : "Living Sketchbook")}
            </span>
            <span className="meta-clock whitespace-nowrap font-display text-[clamp(1.4rem,4vw,2rem)] text-ink-blueprint">
              {formatPreciseClock(currentTime)}
            </span>
          </div>

          <div
            className="lyric-wrap pointer-events-none absolute z-20 flex flex-col items-center text-center"
            style={{
              perspective: "1000px",
              top: "38vh",
              left: "calc(max(50px, 4vw) + max(24px, 5vw))",
              right: "max(24px, 5vw)",
            }}
          >
            {displaySegment ? (
              <div className={`music-lyrics-cue ${cueExiting ? "exiting" : ""}`}>
                <div ref={primaryRef} className="music-lyrics-primary pointer-events-auto">
                  {renderTimedWords(displaySegment, currentTime, seekToTime)}
                </div>

                {displaySegment.translation || displaySegment.secondary ? (
                  <div ref={translationRef} className="music-lyrics-translation pointer-events-none">
                    {displaySegment.translation || displaySegment.secondary}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="music-lyrics-primary opacity-60">
                <span>{song ? cleanTitle(song.name) : "Drop an audio or video file to start"}</span>
              </div>
            )}
          </div>
        </section>
      </div>

    </section>
  );
}
