/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { create } from "zustand";
import { getBrowserLanguageCode } from "./utils";

export interface GlobalState {
  audioFiles: any[];
  orphanTextItems: any[];
  selectedAudioId: string | null;
  segments: any[];
  currentSegmentIndex: number;
  sourceLanguage: string;
  targetLanguage: string;
  translationEnabled: boolean;
  allowAutomaticYoutubeCaptions: boolean;
  scribeStatus: "idle" | "preparing" | "transcribing" | "translating" | "saved" | "error";
  scribeMessage: string;
  manualCommitMarks: number[];
  lastManualCommitAt: number;
  commitFeedback: string;

  // Audio state
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  sourceNode: MediaElementAudioSourceNode | null;
  dataFrequency: Uint8Array | null;
  dataTime: Uint8Array | null;
  objectUrl: string | null;
  seekLock: boolean;
  lastRenderSecond: number;
}

export const useStore = create<GlobalState>((set) => ({
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
  
  audioContext: null,
  analyser: null,
  sourceNode: null,
  dataFrequency: null,
  dataTime: null,
  objectUrl: null,
  seekLock: false,
  lastRenderSecond: -1,
}));
