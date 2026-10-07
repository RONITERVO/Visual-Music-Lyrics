/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

// This converter is deliberately offline. The reference lyrics only identify
// phrases/languages; all displayed text and all word boundaries come from JSON.
type Language = "es" | "en";
type Row = Record<string, any>;
interface Word {
  value: string;
  start: number;
  end: number;
  uncertain: boolean;
  sourceIndex: number;
  language?: Language;
  phraseId?: string;
}
interface Phrase { language: Language; words: Word[] }
interface Pair { es: Word[]; en: Word[] }

export function readGeminiJson(text: string): any {
  let source = text.replace(/^\uFEFF/, "").trim();
  const fences = [...source.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  if (fences.length > 1) throw new Error("Keep only the final Gemini JSON response, not several revisions.");
  if (fences.length === 1) source = fences[0][1].trim();
  try { return JSON.parse(source); }
  catch { throw new Error("Could not read Gemini JSON. Export or paste the complete JSON response."); }
}

function wordRows(data: any): Row[] | null {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.words)) return data.words;
  if (Array.isArray(data?.phrases)) {
    return data.phrases.flatMap((phrase: Row, index: number) => {
      if (!phrase || !Array.isArray(phrase.words) || !phrase.words.length) {
        throw new Error(`Phrase ${index + 1} needs word-level timings.`);
      }
      return phrase.words.map((word: Row) => ({ ...word,
        language: word?.language ?? phrase.language ?? phrase.language_code,
        phrase_id: `phrase-${index}`,
      }));
    });
  }
  return null;
}

/** Distinguish word exports from existing player documents and caption arrays. */
export function isGeminiWordJson(text: string): boolean {
  try {
    const data = readGeminiJson(text);
    if (data?.phrases || data?.words) return true;
    if (!Array.isArray(data) || !data.length) return false;
    if (data.some(row => !row || row.words || row.primary !== undefined || row.translation !== undefined)) return false;
    return data.some(row => "uncertain" in row || "language" in row || "language_code" in row || "lang" in row || "phrase_id" in row || "phraseId" in row)
      || data.every(row => typeof row.text === "string" && row.start !== undefined && row.end !== undefined
        && row.text.trim().split(/\s+/u).length <= 2);
  } catch {
    // Route incomplete/fenced word JSON to the editor instead of importing the
    // model's JSON source code as plain, untimed lyrics.
    return /"start"\s*:/.test(text) && /"end"\s*:/.test(text) && /"(?:text|word|value)"\s*:/.test(text);
  }
}

function timestamp(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return NaN;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (!/^(?:\d+:)?\d{1,2}:[0-5]\d(?:[.,]\d+)?$/.test(text)) return NaN;
  const parts = text.replace(",", ".").split(":").map(Number);
  if (parts.length === 3 && parts[1] >= 60) return NaN;
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

function language(value: unknown): Language | undefined {
  if (value == null || value === "") return undefined;
  const code = String(value).toLowerCase().trim();
  if (/^(es(?:-.*)?|spanish|español)$/.test(code)) return "es";
  if (/^(en(?:-.*)?|english|inglés)$/.test(code)) return "en";
  throw new Error(`Unsupported language “${value}”. Use es for Spanish or en for English.`);
}

function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function readGuide(text: string): Map<string, Set<Language>> {
  const guide = new Map<string, Set<Language>>();
  const add = (text: string, lang: Language) => {
    const key = normalize(text);
    if (!key) return;
    if (!guide.has(key)) guide.set(key, new Set());
    guide.get(key)!.add(lang);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const explicit = line.match(/^\[(es|en)\]\s*(.+)$/i);
    if (explicit) { add(explicit[2], explicit[1].toLowerCase() as Language); continue; }
    if (!line || line.startsWith("[")) continue;
    for (const match of line.matchAll(/\(([^)]+)\)/g)) add(match[1], "en");
    add(line.replace(/\([^)]*\)/g, ""), "es");
  }
  return guide;
}

export function convertGeminiJson(text: string, options: { title?: string; lyrics?: string; duration?: number } = {}) {
  const data = readGeminiJson(text);
  const rows = wordRows(data);
  if (!rows?.length) throw new Error("Expected an array of timed words, { words: [...] }, or { phrases: [...] }.");
  if (rows.length > 20_000) throw new Error("Too many timed entries. Import one song at a time.");
  if (options.duration !== undefined && (!Number.isFinite(options.duration) || options.duration <= 0)) {
    throw new Error("Could not read the song duration.");
  }
  const placeholders: Word[] = [];
  const words: Word[] = [];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Entry ${index + 1} is not a timed word.`);
    const value = String(row.text ?? row.word ?? row.value ?? "").trim();
    const start = timestamp(row.start), end = timestamp(row.end);
    if (!value || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`Entry ${index + 1} (“${value || "empty"}”) needs valid start/end times with end after start. Timings will not be invented.`);
    }
    if (options.duration !== undefined && end > options.duration + .05) {
      throw new Error(`Entry ${index + 1} (“${value}”) ends after this audio. Check that the JSON belongs to this song.`);
    }
    if (row.uncertain !== undefined && typeof row.uncertain !== "boolean") {
      throw new Error(`Entry ${index + 1}: uncertain must be true or false.`);
    }
    const lang = language(row.language ?? row.language_code ?? row.lang);
    const phrase = row.phrase_id ?? row.phraseId;
    const word: Word = { value, start, end, uncertain: row.uncertain ?? true, sourceIndex: index,
      ...(lang ? { language: lang } : {}), ...(phrase != null ? { phraseId: String(phrase) } : {}),
    };
    if (normalize(value)) words.push(word); else placeholders.push(word);
  }
  if (!words.length) throw new Error("The JSON contains no lyric words.");

  const guide = readGuide(options.lyrics || "");
  const longestGuideKey = Math.max(0, ...[...guide.keys()].map(key => key.length));
  const phrases: Phrase[] = [];
  const explicitPhrases = new Map<string, Phrase>();
  let inferredPhraseCount = 0;
  for (let index = 0; index < words.length;) {
    const word = words[index];
    if (word.language && word.phraseId !== undefined) {
      const key = `${word.language}:${word.phraseId}`;
      let phrase = explicitPhrases.get(key);
      if (!phrase) {
        phrase = { language: word.language, words: [] };
        explicitPhrases.set(key, phrase);
        phrases.push(phrase);
      }
      phrase.words.push(word);
      index++;
      continue;
    }

    // Longest exact phrase match, as in the successful Gemini 6 conversion.
    // Never add absent guide words or borrow their timing from another verse.
    let match: { length: number; language: Language } | undefined;
    let key = "";
    for (let end = index; end < words.length; end++) {
      const candidate = words[end];
      if (candidate.phraseId !== undefined && candidate.language) break;
      key += normalize(candidate.value);
      if (key.length > longestGuideKey) break;
      const labels = guide.get(key);
      if (!labels) continue;
      const compatible = [...labels].filter(lang => words.slice(index, end + 1).every(w => !w.language || w.language === lang));
      if (compatible.length === 1) match = { length: end - index + 1, language: compatible[0] };
    }
    if (match) {
      phrases.push({ language: match.language, words: words.slice(index, index + match.length) });
      index += match.length;
      continue;
    }
    if (!word.language) {
      const context = words.slice(index, index + 7).map(w => w.value).join(" ");
      throw new Error(`Cannot place entry ${word.sourceIndex + 1}: “${context}…”. Paste the Suno lyrics below. For improvised lines, add the actual phrase as [es] Spanish or [en] English, or give each JSON word a language and phrase_id.`);
    }
    // Labeled exports without phrase IDs can still play. Phrase boundaries are
    // inferred for layout only; the original word boundaries stay untouched.
    const phrase: Phrase = { language: word.language, words: [word] };
    index++;
    while (index < words.length && phrase.words.length < 12) {
      const next = words[index], previous = phrase.words[phrase.words.length - 1];
      if (next.language !== phrase.language || next.phraseId !== undefined
        || next.start - previous.end > .8 || /[.!?]$/.test(previous.value)) break;
      phrase.words.push(next);
      index++;
    }
    phrases.push(phrase);
    inferredPhraseCount++;
  }

  const startOf = (words: Word[]) => Math.min(...words.map(w => w.start));
  phrases.sort((a, b) => startOf(a.words) - startOf(b.words));
  const pairs: Pair[] = [];
  for (const phrase of phrases) {
    if (phrase.language === "es" || !pairs.length) pairs.push({ es: [], en: [] });
    pairs[pairs.length - 1][phrase.language].push(...phrase.words);
  }
  const bounds = (pair: Pair) => ({ start: startOf([...pair.es, ...pair.en]), end: Math.max(...[...pair.es, ...pair.en].map(w => w.end)) });
  const groups: Pair[] = [];
  let mergedCueCount = 0;
  for (const pair of pairs) {
    const previous = groups[groups.length - 1];
    if (previous && bounds(pair).start < bounds(previous).end) {
      previous.es.push(...pair.es); previous.en.push(...pair.en); mergedCueCount++;
    } else groups.push(pair);
  }
  const outputWords = (list: Word[]) => [...list].sort((a, b) => a.start - b.start || a.sourceIndex - b.sourceIndex)
    .map(({ language: _language, phraseId: _phraseId, ...word }) => word);
  const segments = groups.map((group, index) => {
    const primaryWords = outputWords(group.es), translationWords = outputWords(group.en);
    return { id: `gemini-${index + 1}`, ...bounds(group),
      primary: primaryWords.map(w => w.value).join(" "), translation: translationWords.map(w => w.value).join(" "),
      words: primaryWords, translationWords, translationTiming: "sung" as const,
      language_code: "es", timingQuality: "review", source: "gemini-import",
    };
  });
  return {
    title: options.title || data.title || "Gemini lyrics",
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
    source: "gemini-import", reviewRequired: true,
    reviewNotes: {
      timedEntries: words.length, spanishEntries: segments.reduce((count, s) => count + s.words.length, 0),
      englishEntries: segments.reduce((count, s) => count + s.translationWords.length, 0),
      uncertainEntries: words.filter(w => w.uncertain).length, placeholders,
      combinedEntries: words.filter(w => w.value.split(/\s+/u).length > 1),
      mergedCueCount, inferredPhraseCount,
    },
    segments,
  };
}

export type GeminiTiming = ReturnType<typeof convertGeminiJson>;
