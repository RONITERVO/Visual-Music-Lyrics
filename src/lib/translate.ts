/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { buildApiUrl, getApiRequestHeaders } from './api';

export interface TranslationResult {
  segments: any[];
  translationSource: string;
  translationModel?: string;
  translationRequestMode?: string;
  translationBatchCount?: number;
}

export async function translateSegments(options: {
  segments: any[];
  sourceLanguage?: string;
  targetLanguage: string;
}): Promise<TranslationResult> {
  const body: Record<string, any> = {
    segments: options.segments,
    sourceLanguage: options.sourceLanguage || "",
    targetLanguage: options.targetLanguage,
  };

  const response = await fetch(buildApiUrl("/api/translate/gemini"), {
    method: "POST",
    headers: getApiRequestHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Translation failed");
  }
  if (!Array.isArray(data?.segments)) {
    throw new Error("Translation failed");
  }

  return {
    segments: data.segments,
    translationSource: data?.translationSource || "gemini",
    translationModel: data?.translationModel || "",
    translationRequestMode: data?.translationRequestMode || "",
    translationBatchCount: Number(data?.translationBatchCount) || 0,
  };
}
