import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTranscript, normalizeWords } from "../src/lib/parser";
import { musicLyricDisplaySegmentAt, wordProgress } from "../src/lib/graphics/MusicLyricsTiming";
import { MusicLyricReactivity, measureLyricLayout } from "../src/lib/graphics/MusicLyricReactivity";
import { isLocalImportRequest } from "../server/localSuno";

test("word, text and Kestrel value imports all retain visible words", () => {
  for (const key of ["word", "text", "value"]) {
    const { segments } = parseTranscript(JSON.stringify({ segments: [{ start: 1, end: 5, primary: "Hola", translation: "Hello",
      words: [{ [key]: "Hola", start: 1, end: 2 }], translationWords: [{ [key]: "Hello", start: 3, end: 4 }], translationTiming: "sung" }] }), "json");
    assert.equal(segments[0].words[0].value, "Hola");
    assert.equal(segments[0].translationWords?.[0].value, "Hello");
    assert.equal(segments[0].translationTiming, "sung");
    assert.equal(wordProgress(3, 4, 2), 0);
    assert.equal(wordProgress(3, 4, 3.5), .5);
    assert.equal(wordProgress(1, 2, 3.5), 1);
    assert.equal(musicLyricDisplaySegmentAt(segments, 3.5)?.primary, "Hola");
    assert.equal(musicLyricDisplaySegmentAt(segments, 5.5), undefined);
  }
});

test("malformed word timing cannot introduce NaN style values", () => {
  assert.deepEqual(normalizeWords([{ value: "bad", start: 0, end: null }, { value: "bad", start: "abc", end: 2 }, { value: "bad", start: 2, end: 1 }]), []);
});

test("audio silence, bass and transients drive the shared Kestrel frame", () => {
  const frequency = new Uint8Array(512), waveform = new Uint8Array(1024);
  let signal = false;
  const analyser = {
    getByteFrequencyData(output: Uint8Array) { output.fill(0); if (signal) output.fill(240, 1, 8); },
    getByteTimeDomainData(output: Uint8Array) { for (let i=0;i<output.length;i++) output[i] = 128 + (signal ? Math.sin(i*.2)*80 : 0); },
  } as AnalyserNode;
  const reactivity = new MusicLyricReactivity();
  const quiet = reactivity.sample(analyser, frequency, waveform, 0, { horizon: 300 }, 100);
  signal = true;
  const hit = reactivity.sample(analyser, frequency, waveform, .5, { horizon: 300 }, 117);
  assert.equal(quiet.energy, 0);
  assert.ok(hit.energy > .1 && hit.bass > .5 && hit.rms > .5);
  assert.ok(hit.transient > 0 && hit.beatTrigger);
  signal = false;
  for (let i=0;i<150;i++) reactivity.sample(analyser, frequency, waveform, .5, { horizon: 300 }, 134 + i*17);
  const settled = reactivity.sample(analyser, frequency, waveform, .5, { horizon: 300 }, 2700);
  assert.ok(settled.beat < .001 && settled.energy === 0);
});

test("active English word supplies the visualizer focus", () => {
  const rect = { left: 10, right: 60, top: 100, bottom: 120, width: 50, height: 20 };
  const primary = { getBoundingClientRect: () => rect, querySelector: () => null } as unknown as HTMLElement;
  const translation = { getBoundingClientRect: () => rect, querySelector: () => ({ getBoundingClientRect: () => rect }) } as unknown as HTMLElement;
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }) } as HTMLCanvasElement;
  assert.deepEqual(measureLyricLayout(canvas, primary, translation).activeWord, { left:10,right:60,top:100,bottom:120 });
});

test("local video import rejects remote clients, DNS rebinding and foreign origins", () => {
  const request = (remoteAddress: string, host: string, origin?: string) => ({ socket: { remoteAddress }, headers: { host, origin } }) as any;
  assert.equal(isLocalImportRequest(request("127.0.0.1", "localhost:4552", "http://localhost:4552")), true);
  assert.equal(isLocalImportRequest(request("192.168.1.10", "localhost:4552")), false);
  assert.equal(isLocalImportRequest(request("127.0.0.1", "attacker.example")), false);
  assert.equal(isLocalImportRequest(request("127.0.0.1", "localhost:4552", "https://attacker.example")), false);
});
