import assert from "node:assert/strict";
import { test } from "node:test";
import { convertGeminiJson, isGeminiWordJson } from "../src/lib/geminiImport";
import { parseTranscript } from "../src/lib/parser";
import { musicLyricSegmentAt } from "../src/lib/graphics/MusicLyricsTiming";

const word = (text: string, start: number | string, end: number | string, extra: object = {}) => ({ text, start, end, uncertain: false, ...extra });

test("unlabeled bilingual words use a guide without adding absent lyrics or changing boundaries", () => {
  const rows = [word("...", 0, 1, { uncertain: true }), word("Bajo", 2, 2.4), word("la", 2.4, 2.55),
    word("luna", 2.55, 3.1), word("Under", 3, 3.35), word("the", 3.35, 3.5), word("moon", 3.5, 4),
    word("Ven", 3.8, 4.3), word("Come", 4.2, 4.8, { uncertain: true })];
  const result = convertGeminiJson(JSON.stringify(rows), {
    lyrics: "[Verse 1]\nBajo la luna (Under the moon)\nVen (Come)\nUna frase ausente (An absent line)", duration: 10,
  });
  assert.equal(result.segments.length, 1); // overlapping cues must not hide either language
  assert.equal(result.segments[0].primary, "Bajo la luna Ven");
  assert.equal(result.segments[0].translation, "Under the moon Come");
  assert.equal(result.reviewNotes.spanishEntries, 4);
  assert.equal(result.reviewNotes.englishEntries, 4);
  assert.equal(result.reviewNotes.placeholders.length, 1);
  assert.equal(result.reviewNotes.uncertainEntries, 1);
  const actual = result.segments.flatMap(s => [...s.words, ...s.translationWords]).sort((a, b) => a.sourceIndex - b.sourceIndex);
  assert.deepEqual(actual.map(w => [w.value, w.start, w.end]), rows.slice(1).map(w => [w.text, w.start, w.end]));
  const parsed = parseTranscript(JSON.stringify(result), "json");
  assert.equal(parsed.segments[0].words[0].sourceIndex, 1);
  assert.equal(parsed.segments[0].translationWords?.[3].uncertain, true);
  assert.equal(musicLyricSegmentAt(parsed.segments, 3.9)?.translation, "Under the moon Come");
});

test("labeled phrases work alone, retain English-only intros, and accept timestamp strings", () => {
  const input = JSON.stringify({ title: "Song", phrases: [
    { language: "en", words: [word("Listen", "00:01.25", "00:02.10")] },
    { language: "es", words: [word("Hola", "00:03.2", "00:04.1")] },
    { language: "en", words: [word("Hello", 4.2, 5)] },
  ] });
  const result = parseTranscript(`Here is the JSON:\n\n\x60\x60\x60json\n${input}\n\x60\x60\x60`, "txt");
  assert.equal(result.title, "Song");
  assert.equal(result.segments[0].primary, "");
  assert.equal(result.segments[0].translation, "Listen");
  assert.equal(result.segments[0].translationWords?.[0].start, 1.25);
  assert.equal(result.segments[1].translationTiming, "sung");
  assert.equal(result.segments[1].words[0].end, 4.1);
});

test("phrase IDs restore interleaved voices without globally forcing non-overlap", () => {
  const rows = [word("Mi", 1, 1.3, { language: "es", phrase_id: 1 }),
    word("My", 1.2, 1.5, { language: "en", phrase_id: 2 }),
    word("marca", 1.3, 2, { language: "es", phrase_id: 1 }),
    word("mark", 1.5, 2.3, { language: "en", phrase_id: 2 })];
  const result = convertGeminiJson(JSON.stringify(rows));
  assert.equal(result.segments[0].primary, "Mi marca");
  assert.equal(result.segments[0].translation, "My mark");
  assert.equal(result.segments[0].translationWords[0].start, 1.2);
});

test("unknown/improvised phrases require explicit labels instead of a vocabulary guess", () => {
  const input = JSON.stringify([word("Luz", 1, 2), word("Shine", 2, 3)]);
  assert.throws(() => convertGeminiJson(input), /Cannot place entry 1/);
  const result = convertGeminiJson(input, { lyrics: "[es] Luz\n[en] Shine" });
  assert.equal(result.segments[0].translation, "Shine");
  assert.throws(() => convertGeminiJson(JSON.stringify([word("solo", 1, 2)]), { lyrics: "[es] solo\n[en] solo" }), /Cannot place/);
});

test("combined word spans are preserved; missing phrase IDs are disclosed", () => {
  const result = convertGeminiJson(JSON.stringify([word("en la", 1.1, 1.5, { language: "es", uncertain: true })]));
  assert.equal(result.reviewNotes.combinedEntries.length, 1);
  assert.equal(result.reviewNotes.inferredPhraseCount, 1);
  assert.equal(result.segments[0].words.length, 1);
  assert.deepEqual([result.segments[0].words[0].start, result.segments[0].words[0].end], [1.1, 1.5]);
});

test("bad timings and wrong media are rejected instead of repaired or dropped", () => {
  for (const [start, end] of [[0, 0], [2, 1], [-1, 2], [null, 2], ["", 2], ["00:75", 80], [true, 2], [0, Infinity]]) {
    assert.throws(() => convertGeminiJson(JSON.stringify([{ text: "Hola", start, end, language: "es" }])), /valid start\/end/);
  }
  assert.throws(() => convertGeminiJson(JSON.stringify([word("Hola", 2, 10, { language: "es" })]), { duration: 4 }), /ends after this audio/);
  assert.throws(() => convertGeminiJson(JSON.stringify([word("Hola", 1, 2, { language: "es", uncertain: "false" })])), /true or false/);
  assert.throws(() => convertGeminiJson(JSON.stringify([word("Bonjour", 1, 2, { language: "fr" })])), /Unsupported language/);
});

test("recognizes word exports without hijacking existing player JSON or sentence captions", () => {
  assert.equal(isGeminiWordJson(JSON.stringify([word("Hola", 1, 2)])), true);
  assert.equal(isGeminiWordJson('[{"text":"Hola","start":1,"end":'), true);
  assert.equal(isGeminiWordJson(JSON.stringify({ segments: [{ primary: "Hola", words: [word("Hola", 1, 2)] }] })), false);
  assert.equal(isGeminiWordJson(JSON.stringify([{ start: 1, end: 4, text: "This is a caption sentence" }])), false);
  assert.throws(() => convertGeminiJson('```json\n[]\n```\n```json\n[]\n```'), /final Gemini JSON/);
});
