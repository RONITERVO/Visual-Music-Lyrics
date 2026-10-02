/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

export interface SongFile {
  id: string;
  key: string;
  file: File | null;
  name: string;
  base: string;
  size: number;
  type: string;
  lastModified: number;
  relativePath: string;
  folderHandleId: string;
  folderLabel: string;
  fileHandleId: string;
  fileLabel: string;
  timing: TranscriptItem | null;
  recoveryStatus: string;
  needsRecovery: boolean;
  url: string;
}

export interface TranscriptItem {
  id: string;
  key: string;
  file: File | null;
  name: string;
  base: string;
  status: string;
  segments: Segment[] | null;
  error: string;
  source: string;
  persistedId: string;
  textCache: string;
  updatedAt: number;
  kind?: "timed";
  title?: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  primary: string;
  translation: string;
  secondary: string;
  raw: string;
  speaker: string;
  section: string;
  role: string;
  kind?: string;
  words: any[];
  translationWords?: MusicLyricWord[];
  translationTiming?: "sung";
  timingQuality?: string;
  characterTimeline?: any[];
  order: number;
  source?: string;
  translationSource?: string;
  language_code?: string;
}

export interface MusicLyricWord {
  value: string;
  start: number;
  end: number;
  uncertain?: boolean;
  sourceIndex?: number;
}

export type MusicLyricTheme = "sketchbook" | "signal-bloom";
