import assert from "node:assert/strict";
import { beforeEach, test, type TestContext } from "node:test";
import { handleGlobalDroppedFiles } from "../src/lib/fileHandlers";
import { useStore } from "../src/lib/store";

const timing = (primary = "Hola", title = "") => ({ title, segments: [{
  id: "pair", start: 1.1, end: 4.2, primary, translation: "Hello", translationTiming: "sung",
  words: [{ value: primary, start: 1.1, end: 2.15, uncertain: true }],
  translationWords: [{ value: "Hello", start: 3.1, end: 4.2 }],
}] });
const json = (name: string, value: unknown) => new File([JSON.stringify(value)], name, { type: "application/json" });
const video = (name: string) => new File([name], name, { type: "video/mp4" });
const songs = () => useStore.getState().audioFiles;

beforeEach(() => {
  for (const song of songs()) if (song.url) URL.revokeObjectURL(song.url);
  useStore.setState({ audioFiles: [], orphanTextItems: [], selectedAudioId: null, segments: [] });
});

function mockExtractor(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    const name = await (options.body as File).text();
    return Response.json({ audioBase64: Buffer.from(name).toString("base64"),
      ...(url.includes("audioOnly=1") ? {} : { timing: timing("Aligned") }) });
  });
  // The importer deliberately restricts video processing to the local app.
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hostname: "127.0.0.1" } } });
  t.after(() => {
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return () => (fetch as any).mock.calls.map((call: any) => call.arguments[0]);
}

for (const reversed of [false, true]) {
  test(`converted timing JSON skips alignment regardless of file order (${reversed})`, async t => {
    const requests = mockExtractor(t);
    await handleGlobalDroppedFiles([
      new File(["existing"], "existing.wav", { type: "audio/wav" }), json("existing.json", timing("Keep")),
    ]);
    const inputs = [video("Amor Digital.mp4"), json("review-export.json", timing())];
    if (reversed) inputs.reverse();
    const result = await handleGlobalDroppedFiles(inputs);
    assert.deepEqual(requests(), ["/api/local/suno?audioOnly=1"]);
    assert.equal(result.alignedVideos, 0);
    assert.equal(result.reusedVideoTimings, 1);
    assert.equal(songs()[0].timing.segments[0].primary, "Keep");
    const segment = songs()[1].timing.segments[0];
    assert.equal(segment.primary, "Hola");
    assert.equal(segment.words[0].start, 1.1);
    assert.equal(segment.words[0].end, 2.15);
    assert.equal(segment.words[0].uncertain, true);
    assert.deepEqual(segment.translationWords, timing().segments[0].translationWords);
    assert.equal(segment.translationTiming, "sung");
  });
}

test("batch imports pair by filename or title and align only videos without timings", async t => {
  const requests = mockExtractor(t);
  const result = await handleGlobalDroppedFiles([
    video("First.mp4"), video("Second.mp4"), video("Third.mp4"),
    json("export.json", timing("Segundo", "Second")), json("First_timings.json", timing("Primero")),
  ]);
  assert.deepEqual(requests(), ["/api/local/suno?audioOnly=1", "/api/local/suno?audioOnly=1", "/api/local/suno"]);
  assert.equal(result.reusedVideoTimings, 2);
  assert.equal(result.alignedVideos, 1);
  assert.deepEqual(songs().map(song => [song.name, song.timing.segments[0].primary]), [
    ["First.m4a", "Primero"], ["Second.m4a", "Segundo"], ["Third.m4a", "Aligned"],
  ]);
});

test("video alone and untimed lyrics retain local alignment", async t => {
  const requests = mockExtractor(t);
  await handleGlobalDroppedFiles([video("Solo.mp4")]);
  await handleGlobalDroppedFiles([video("Other.mp4"), json("Other.json", { segments: [{ primary: "Untimed" }] })]);
  assert.deepEqual(requests(), ["/api/local/suno", "/api/local/suno"]);
  assert.equal(songs()[1].timing.segments[0].primary, "Aligned");
});

test("ambiguous timing files stop before any video processing", async t => {
  const requests = mockExtractor(t);
  await assert.rejects(handleGlobalDroppedFiles([
    video("Song.mp4"), json("Song_timings.json", timing()), json("Song_lyrics.json", timing()),
  ]), /Multiple timing files match/);
  assert.deepEqual(requests(), []);
  assert.deepEqual(songs(), []);
});

test("a timing file cannot silently pair with two different videos", async t => {
  const requests = mockExtractor(t);
  await assert.rejects(handleGlobalDroppedFiles([
    video("Song take one.mp4"), video("Song take two.mp4"), json("Song.json", timing()),
  ]), /matches more than one video/);
  assert.deepEqual(requests(), []);
});

test("malformed timing JSON fails before starting OCR", async t => {
  const requests = mockExtractor(t);
  await assert.rejects(handleGlobalDroppedFiles([
    video("Song.mp4"), new File(['{"segments": ['], "Song.json", { type: "application/json" }),
  ]));
  assert.deepEqual(requests(), []);
});
