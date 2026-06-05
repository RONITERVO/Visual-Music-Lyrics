/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { createId } from "./utils";
import { useStore } from "./store";
import { loadSongSegments } from "./fileHandlers";

const SCRIBE_SOURCE = "elevenlabs-scribe-v2";

function getTimingSource(text: string, fallback = SCRIBE_SOURCE) {
  try {
    const data = JSON.parse(text);
    return String(data?.transcriptionSource || data?.source || fallback) || fallback;
  } catch {
    return fallback;
  }
}

function getTimingFileSuffix(source: string) {
  if (/youtube-captions/i.test(source)) return "youtube-captions";
  return "scribe";
}

export function createTimingItem(song: any, text: string) {
  const existing = song.timing || {};
  const source = getTimingSource(text, existing.source || SCRIBE_SOURCE);
  const suffix = getTimingFileSuffix(source);
  return {
    id: existing.id || createId("transcript"),
    key: existing.key || `${song.key}:${suffix}-timing`,
    file: null,
    name: existing.name || `${song.base || song.name}.${suffix}.json`,
    base: song.base,
    status: "ready",
    segments: null,
    error: "",
    source,
    persistedId: existing.persistedId || "",
    textCache: text,
    updatedAt: Date.now(),
    kind: "timed",
    title: existing.title || "",
  };
}

export function buildGeneratedTimingText(options: {
  segments: any[];
  sourceLanguage: string;
  targetLanguage: string;
  translationEnabled: boolean;
  translationSource: string;
  translationError?: string;
  transcriptionSource?: string;
  commitStrategy?: string;
  manualCommitMarks?: number[];
  youtubeCaptionTrack?: {
    videoId?: string;
    requestedLanguage?: string;
    languageCode?: string;
    trackKind?: string;
    trackName?: string;
    extractorSource?: string;
    automaticCaptionsAllowed?: boolean;
    translationLanguageCode?: string;
    translationTrackKind?: string;
    translationTrackName?: string;
    translationSource?: string;
  };
}) {
  const transcriptionSource = options.transcriptionSource || SCRIBE_SOURCE;
  return JSON.stringify({
    source: transcriptionSource,
    transcriptionSource,
    translationSource: options.translationSource,
    commitStrategy: options.commitStrategy || "manual",
    manualCommitMarks: options.manualCommitMarks || [],
    sourceLanguage: options.sourceLanguage || "auto",
    targetLanguage: options.translationEnabled ? options.targetLanguage : "",
    generatedAt: new Date().toISOString(),
    ...(options.youtubeCaptionTrack ? { youtubeCaptionTrack: options.youtubeCaptionTrack } : {}),
    ...(options.translationError ? { translationError: options.translationError } : {}),
    segments: options.segments,
  }, null, 2);
}

function getSegmentBounds(segment: any) {
  const start = Number(segment?.start);
  const end = Number(segment?.end);
  return {
    start: Number.isFinite(start) ? start : NaN,
    end: Number.isFinite(end) ? end : NaN,
  };
}

export function replaceSegmentsInRange(existingSegments: any[], replacementSegments: any[], startSeconds: number, endSeconds: number) {
  const start = Math.max(0, Math.min(startSeconds, endSeconds));
  const end = Math.max(start, Math.max(startSeconds, endSeconds));

  const kept = (Array.isArray(existingSegments) ? existingSegments : []).filter((segment) => {
    const bounds = getSegmentBounds(segment);
    if (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end)) return true;
    return bounds.end <= start || bounds.start >= end;
  });

  return [...kept, ...(Array.isArray(replacementSegments) ? replacementSegments : [])]
    .sort((left, right) => {
      const leftStart = Number(left?.start);
      const rightStart = Number(right?.start);
      if (Number.isFinite(leftStart) && Number.isFinite(rightStart) && leftStart !== rightStart) {
        return leftStart - rightStart;
      }
      return Number(left?.order || 0) - Number(right?.order || 0);
    })
    .map((segment, order) => ({ ...segment, order }));
}

export async function saveSongTiming(songId: string, timingText: string) {
  const state = useStore.getState();
  let nextSong: any = null;
  const audioFiles = state.audioFiles.map((song) => {
    if (song.id !== songId) return song;
    nextSong = {
      ...song,
      timing: createTimingItem(song, timingText),
      recoveryStatus: "",
    };
    return nextSong;
  });

  useStore.setState({ audioFiles });

  if (nextSong) {
    await loadSongSegments(songId);
  }

  return nextSong;
}
