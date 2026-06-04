/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { buildWebSocketUrl } from './api';
import { getAudioMimeType } from "./utils";

export interface LiveScribeCallbacks {
  onStatus?: (status: string, message?: string) => void;
  onProgress?: (audioSecondsSent: number) => void;
  onCommitAccepted?: (mark: number) => void;
  onCommitRejected?: (mark: number, reason: string, nextAllowedAt: number) => void;
  onFinishRejected?: (mark: number, reason: string, nextAllowedAt: number) => void;
  onResult?: (payload: any) => void;
  onError?: (message: string) => void;
}

export interface LiveScribeSession {
  commit: (markSeconds: number) => void;
  finish: (markSeconds: number) => void;
  close: () => void;
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

function getLiveScribeUrl() {
  return buildWebSocketUrl('/api/elevenlabs/scribe-live');
}

export function createLiveScribeSession(options: {
  file: File;
  apiKey?: string;
  sourceLanguage?: string;
  previousText?: string;
  keyterms?: string[];
  startSeconds?: number;
}, callbacks: LiveScribeCallbacks = {}): LiveScribeSession {
  const ws = new WebSocket(getLiveScribeUrl());
  const pendingCommits: number[] = [];
  let pendingFinish: number | null = null;
  let startSent = false;
  let intentionallyClosed = false;
  let finished = false;

  const sendJson = (payload: Record<string, any>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const sendCommit = (markSeconds: number) => {
    if (!Number.isFinite(markSeconds)) return;
    if (!startSent || ws.readyState !== WebSocket.OPEN) {
      pendingCommits.push(markSeconds);
      return;
    }
    sendJson({ type: "commit", at: markSeconds });
  };

  ws.addEventListener("open", async () => {
    callbacks.onStatus?.("preparing", "Preparing audio");
    try {
      const audioBase64 = await fileToBase64(options.file);
      if (intentionallyClosed) return;

      sendJson({
        type: "start",
        audioBase64,
        mimeType: getAudioMimeType(options.file),
        fileName: options.file.name,
        apiKey: options.apiKey || "",
        sourceLanguage: options.sourceLanguage || "",
        previousText: options.previousText || "Song lyrics",
        keyterms: options.keyterms || [],
        startSeconds: Number.isFinite(options.startSeconds) ? options.startSeconds : 0,
      });
      startSent = true;

      while (pendingCommits.length) {
        sendCommit(pendingCommits.shift()!);
      }
      if (pendingFinish != null) {
        sendJson({ type: "finish", at: pendingFinish });
        pendingFinish = null;
      }
    } catch (error: any) {
      callbacks.onError?.(String(error?.message || error || "Could not prepare audio"));
      ws.close();
    }
  });

  ws.addEventListener("message", (event) => {
    let payload: any = null;
    try {
      payload = JSON.parse(String(event.data || "{}"));
    } catch {
      return;
    }

    if (payload.type === "status") {
      callbacks.onStatus?.(String(payload.status || "streaming"), payload.message);
      return;
    }

    if (payload.type === "progress") {
      callbacks.onProgress?.(Number(payload.audioSecondsSent) || 0);
      return;
    }

    if (payload.type === "commit-accepted") {
      callbacks.onCommitAccepted?.(Number(payload.at) || 0);
      return;
    }

    if (payload.type === "commit-rejected") {
      callbacks.onCommitRejected?.(
        Number(payload.at) || 0,
        String(payload.reason || "Commit was too close to the previous mark."),
        Number(payload.nextAllowedAt) || 0
      );
      return;
    }

    if (payload.type === "finish-rejected") {
      callbacks.onFinishRejected?.(
        Number(payload.at) || 0,
        String(payload.reason || "Section is too short."),
        Number(payload.nextAllowedAt) || 0
      );
      return;
    }

    if (payload.type === "result") {
      finished = true;
      callbacks.onResult?.(payload);
      ws.close();
      return;
    }

    if (payload.type === "error") {
      callbacks.onError?.(String(payload.error || "Scribe transcription failed"));
    }
  });

  ws.addEventListener("error", () => {
    if (!intentionallyClosed && !finished) {
      callbacks.onError?.("Could not connect to the local Scribe stream.");
    }
  });

  ws.addEventListener("close", () => {
    if (!intentionallyClosed && !finished) {
      callbacks.onError?.("Scribe stream closed before it finished.");
    }
  });

  return {
    commit: sendCommit,
    finish: (markSeconds: number) => {
      if (!Number.isFinite(markSeconds)) return;
      if (!startSent || ws.readyState !== WebSocket.OPEN) {
        pendingFinish = markSeconds;
        return;
      }
      sendJson({ type: "finish", at: markSeconds });
    },
    close: () => {
      intentionallyClosed = true;
      if (ws.readyState === WebSocket.OPEN) {
        sendJson({ type: "cancel" });
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}
