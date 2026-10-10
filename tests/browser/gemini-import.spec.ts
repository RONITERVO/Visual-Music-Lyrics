import { test, expect } from "@playwright/test";

function silentAudio() {
  const samples = 22050 * 8, data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  return data;
}
const raw = [
  { text: "Hola", start: 1.1, end: 2.15, uncertain: false },
  { text: "mundo", start: 2.15, end: 3.2, uncertain: true },
  { text: "Hello", start: 3.1, end: 3.6, uncertain: false },
  { text: "world", start: 3.6, end: 4.2, uncertain: false },
];

test("phone Gemini file import, explicit song choice, download, playback and persistence", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [], paidRequests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (/\/api\/(translate|elevenlabs|local\/suno)/.test(request.url())) paidRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByLabel("Add audio, Suno video or lyric timing files").setInputFiles([
    { name: "song.wav", mimeType: "audio/wav", buffer: silentAudio() },
    { name: "ai_studio_code.txt", mimeType: "text/plain", buffer: Buffer.from(`\x60\x60\x60json\n${JSON.stringify(raw)}\n\x60\x60\x60`) },
  ]);
  const dialog = page.getByRole("dialog", { name: "Import Gemini lyrics" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Use lyrics", exact: true })).toBeDisabled();
  await dialog.getByLabel("Suno lyrics / phrase guide", { exact: false }).fill("Hola mundo (Hello world)");
  await expect(dialog.getByLabel("Conversion preview")).toContainText("4 timed entries · 1 cue");
  await expect(dialog.getByLabel("Song", { exact: true })).toHaveValue("file:0");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download timing JSON" }).click();
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toBe("song.json");
  const chunks: Buffer[] = [];
  for await (const chunk of (await downloaded.createReadStream())!) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString());
  expect(exported.segments[0].words[1].uncertain).toBe(true);
  expect(exported.segments[0].translationWords[0].start).toBe(3.1);
  await page.screenshot({ path: ".artifacts/gemini-import-phone.png" });
  await dialog.getByRole("button", { name: "Use lyrics", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("Gemini lyrics added: 4 timed entries");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("audio")!.readyState >= 2);
  await page.evaluate(() => { const audio = document.querySelector("audio")!; audio.pause(); audio.currentTime = 3.15; });
  await expect(page.locator(".music-lyrics-primary button.active")).toContainText("mundo");
  await expect(page.locator(".music-lyrics-translation button.active")).toContainText("Hello");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("audio")!.readyState >= 2);
  await page.evaluate(() => { const audio = document.querySelector("audio")!; audio.pause(); audio.currentTime = 3.15; });
  await expect(page.locator(".music-lyrics-translation button.active")).toContainText("Hello");
  expect(errors).toEqual([]);
  expect(paidRequests).toEqual([]);
});

test("invalid JSON timings cannot overwrite a selected song; cancel preserves it", async ({ page }) => {
  await page.goto("/");
  const picker = page.getByLabel("Add audio, Suno video or lyric timing files");
  await picker.setInputFiles([
    { name: "existing.wav", mimeType: "audio/wav", buffer: silentAudio() },
    { name: "existing.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ segments: [{ start: 1, end: 5, primary: "Keep these lyrics" }] })) },
  ]);
  await expect(page.getByRole("status")).toContainText("Files added");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await picker.setInputFiles({ name: "gemini.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([
    { text: "Bad", start: 2, end: 2, language: "en", uncertain: false },
  ])) });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("end after start");
  await expect(dialog.getByText("Using these lyrics will replace", { exact: false })).toContainText("existing.wav");
  await expect(dialog.getByRole("button", { name: "Use lyrics", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => { const audio = document.querySelector("audio")!; audio.pause(); audio.currentTime = 2; });
  await expect(page.locator(".music-lyrics-primary .music-lyrics-word-ghost")).toHaveText(["Keep", "these", "lyrics"]);
});

test("dropping a video with converted JSON skips OCR and preserves bilingual playback", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  await page.route("**/api/local/suno**", async route => {
    requests.push(route.request().url());
    if (new URL(route.request().url()).searchParams.get("audioOnly") !== "1") {
      await route.fulfill({ status: 500, json: { error: "OCR must not run with supplied timings" } });
      return;
    }
    await route.fulfill({ json: { audioBase64: silentAudio().toString("base64"), mimeType: "audio/mp4" } });
  });
  const converted = { segments: [{ start: 1.1, end: 4.2, primary: "Hola mundo", translation: "Hello world", translationTiming: "sung",
    words: [{ value: "Hola", start: 1.1, end: 2.15 }, { value: "mundo", start: 2.15, end: 3.2, uncertain: true }],
    translationWords: [{ value: "Hello", start: 3.1, end: 3.6 }, { value: "world", start: 3.6, end: 4.2 }],
  }] };
  await page.goto("/");
  await page.evaluate(converted => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["video fixture"], "Suno song.mp4", { type: "video/mp4" }));
    dataTransfer.items.add(new File([JSON.stringify(converted)], "converted-review.json", { type: "application/json" }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true }));
  }, converted);
  await expect(page.getByRole("status")).toContainText("Audio and supplied lyrics added. Review the timings");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toContain("audioOnly=1");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("audio")!.readyState >= 2);
  await page.evaluate(() => { const audio = document.querySelector("audio")!; audio.pause(); audio.currentTime = 3.15; });
  await expect(page.locator(".music-lyrics-primary button.active")).toContainText("mundo");
  await expect(page.locator(".music-lyrics-translation button.active")).toContainText("Hello");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("audio")!.readyState >= 2);
  await page.evaluate(() => { const audio = document.querySelector("audio")!; audio.pause(); audio.currentTime = 3.15; });
  await expect(page.locator(".music-lyrics-translation button.active")).toContainText("Hello");
  expect(requests).toHaveLength(1);
});


test("video alone adds preserved audio without automatic transcription", async ({ page }) => {
  const paidRequests: string[] = [];
  page.on("request", request => {
    if (/\/api\/(translate|elevenlabs)/.test(request.url())) paidRequests.push(request.url());
  });
  await page.route("**/api/local/suno**", route => route.fulfill({ json: {
    audioBase64: silentAudio().toString("base64"), mimeType: "audio/wav", extension: "wav",
  } }));
  await page.goto("/");
  await page.getByLabel("Add audio, Suno video or lyric timing files").setInputFiles({
    name: "Audio only.mkv", mimeType: "video/x-matroska", buffer: Buffer.from("video fixture"),
  });
  await expect(page.getByRole("status")).toContainText("Original audio added. Add Gemini timing JSON");
  await page.waitForFunction(() => document.querySelector("audio")!.readyState >= 2);
  await page.evaluate(() => document.querySelector("audio")!.play());
  await expect.poll(() => page.evaluate(() => document.querySelector("audio")!.currentTime)).toBeGreaterThan(.1);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("audio")!.readyState >= 2);
  const song = await page.evaluate(async () => {
    const module = "/src/lib/store.ts";
    const { useStore } = await import(/* @vite-ignore */ module);
    const stored = useStore.getState().audioFiles[0];
    return { name: stored.name, type: stored.file.type, timing: stored.timing };
  });
  expect(song.name).toBe("Audio only.wav");
  expect(song.type).toBe("audio/wav");
  expect(song.timing).toBeNull();
  expect(paidRequests).toEqual([]);
});
