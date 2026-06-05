/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { buildApiUrl, getAuthorizedApiRequestHeaders } from "./api";
import { getAudioMimeType } from "./utils";

export interface ScribeTranscriptRequest {
  file: File;
  sourceLanguage?: string;
  estimatedDurationSeconds?: number;
  songName?: string;
  songBase?: string;
  youtubeTitle?: string;
  youtubeChannelTitle?: string;
}

export interface ScribeTranscriptResult {
  source: string;
  model: string;
  languageCode: string;
  segments: any[];
  streamStartSeconds?: number;
  streamEndSeconds?: number;
  billing?: {
    provider: string;
    usedSeconds: number;
    reservedSeconds: number;
  };
  lrclib?: {
    status: string;
    selectedTrack?: string;
    selectedArtist?: string;
    keytermCount?: number;
  };
}

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop()! : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getErrorMessage(data: any, fallback: string) {
  return String(data?.error || data?.message || fallback);
}

function getNetworkErrorMessage(error: any, fallback: string) {
  const message = String(error?.message || error || "").trim();
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    const origin = typeof window !== "undefined" ? window.location.origin : "this site";
    return `${fallback}. The hosted media service could not be reached from ${origin}.`;
  }
  return message || fallback;
}

export async function createScribeTranscript(
  options: ScribeTranscriptRequest,
  signal?: AbortSignal,
): Promise<ScribeTranscriptResult> {
  const audioBase64 = await fileToBase64(options.file);

  let response: Response;
  try {
    response = await fetch(buildApiUrl("/api/elevenlabs/scribe"), {
      method: "POST",
      headers: await getAuthorizedApiRequestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        audioBase64,
        mimeType: getAudioMimeType(options.file),
        fileName: options.file.name,
        sourceLanguage: options.sourceLanguage || "",
        estimatedDurationSeconds: Number.isFinite(options.estimatedDurationSeconds)
          ? options.estimatedDurationSeconds
          : 0,
        songName: options.songName || options.file.name,
        songBase: options.songBase || "",
        youtubeTitle: options.youtubeTitle || "",
        youtubeChannelTitle: options.youtubeChannelTitle || "",
      }),
      signal,
    });
  } catch (error) {
    throw new Error(getNetworkErrorMessage(error, "Scribe transcription failed"));
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getErrorMessage(data, `Scribe transcription failed (${response.status})`));
  }
  if (!Array.isArray(data?.segments) || !data.segments.length) {
    throw new Error("Scribe did not return lyric segments for this audio.");
  }

  return {
    source: String(data.source || "elevenlabs-scribe-v2"),
    model: String(data.model || "scribe_v2"),
    languageCode: String(data.languageCode || data.language_code || ""),
    segments: data.segments,
    streamStartSeconds: Number.isFinite(Number(data.streamStartSeconds)) ? Number(data.streamStartSeconds) : undefined,
    streamEndSeconds: Number.isFinite(Number(data.streamEndSeconds)) ? Number(data.streamEndSeconds) : undefined,
    billing: data.billing,
    lrclib: data.lrclib,
  };
}
