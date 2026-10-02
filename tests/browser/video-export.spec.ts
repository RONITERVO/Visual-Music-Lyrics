import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";

function toneAudio() {
  const samples = 22050 * 4, data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 110 / 22050) * (i % 11025 < 4000 ? 16000 : 1000)), 44 + i * 2);
  return data;
}

test("portrait export includes lyrics and timer, downloads video, and can cancel without changing the song", async ({ page }) => {
  test.setTimeout(120_000);
  await mkdir(".artifacts/video-export", { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("Add audio, Suno video or lyric timing files").setInputFiles([
    { name: "Export demo.wav", mimeType: "audio/wav", buffer: toneAudio() },
    { name: "Export demo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ segments: [{
      start: .2, end: 3.8, primary: "Hola mundo", translation: "Hello world", translationTiming: "sung",
      words: [{ value: "Hola", start: .2, end: 1.1 }, { value: "mundo", start: 1.1, end: 1.8 }],
      translationWords: [{ value: "Hello", start: 2, end: 2.8 }, { value: "world", start: 2.8, end: 3.8 }],
    }] })) },
  ]);
  await expect(page.getByRole("status")).toContainText("Files added");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByRole("button", { name: "Open library and playback controls" }).click();
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export video", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Video shape")).toHaveValue("portrait");
  await expect(dialog.getByLabel("Video resolution")).toHaveValue("720");
  await dialog.getByRole("button", { name: "Export video", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "Download MP4" })).toBeVisible({ timeout: 90_000 });
  await expect(dialog.getByRole("status")).toContainText("Video ready");
  await page.screenshot({ path: ".artifacts/video-export/dialog-phone.png" });
  const download = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download MP4" }).click();
  const downloaded = await download;
  expect(downloaded.suggestedFilename()).toBe("Export demo.mp4");
  await downloaded.saveAs(".artifacts/video-export/smoke.mp4");
  await dialog.getByRole("button", { name: "Export again" }).click();
  await dialog.getByRole("button", { name: "Cancel export" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Export canceled.");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Close search" }).click();
  await page.evaluate(() => { const audio = document.querySelector("audio")!; audio.pause(); audio.currentTime = 3.2; });
  await expect(page.locator(".music-lyrics-translation button.active")).toContainText("world");
  expect(errors).toEqual([]);
});

test("Signal Bloom exports a 1080p landscape lossless master", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.getByLabel("Add audio, Suno video or lyric timing files").setInputFiles([
    { name: "Signal demo.wav", mimeType: "audio/wav", buffer: toneAudio() },
    { name: "Signal demo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ segments: [{
      start: .2, end: 3.8, primary: "Hola mundo", translation: "Hello world",
      words: [{ value: "Hola", start: .2, end: 1.1 }, { value: "mundo", start: 1.1, end: 1.8 }],
      translationWords: [{ value: "Hello", start: 2, end: 2.8 }, { value: "world", start: 2.8, end: 3.8 }], translationTiming: "sung",
    }] })) },
  ]);
  await expect(page.getByRole("status")).toContainText("Files added");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.getByTitle("Toggle Visualizer Theme: Living Sketchbook vs Signal Bloom").click();
  await page.getByRole("button", { name: "Open library and playback controls" }).click();
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export video", exact: true });
  await dialog.getByLabel("Video format").selectOption("lossless");
  await dialog.getByLabel("Video shape").selectOption("landscape");
  await dialog.getByLabel("Video resolution").selectOption("1080");
  await dialog.getByRole("button", { name: "Export video", exact: true }).click();
  const link = dialog.getByRole("link", { name: "Download MKV" });
  await expect(link).toBeVisible({ timeout: 90_000 });
  const download = page.waitForEvent("download"); await link.click();
  await (await download).saveAs(".artifacts/video-export/signal-1080.mkv");
});
