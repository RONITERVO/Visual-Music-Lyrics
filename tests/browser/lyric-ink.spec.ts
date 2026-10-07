import { test, expect } from "@playwright/test";

const primary = "Brillan en mi cara El tiempo se detiene";
const translation = "Shine on my face Time stops";
const words = (text: string) => text.split(" ").map((value, i) => ({ value, start: 1 + i * .2, end: 1.2 + i * .2 }));
const segment = { id: "ink", start: 1, end: 8, primary, translation, words: words(primary), translationWords: words(translation), translationTiming: "sung" };

test("finished handwriting matches unclipped ink in playback without changing word positions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.evaluate(async segment => {
    const module = "/src/lib/store.ts";
    const { useStore } = await import(/* @vite-ignore */ module);
    useStore.setState({ segments: [segment] });
    const audio = document.querySelector("audio")!;
    // A small WAV keeps the normal media clock and lyric renderer in use.
    const bytes = new ArrayBuffer(44 + 8000 * 10 * 2), view = new DataView(bytes);
    const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, bytes.byteLength - 44, true);
    audio.src = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); audio.load();
  }, segment);
  await page.waitForFunction(() => document.querySelector("audio")!.readyState >= 2);
  await page.evaluate(() => { document.querySelector("audio")!.currentTime = 6; });
  await expect(page.locator(".music-lyrics-primary button.written")).toHaveCount(8);
  // Isolate ink from the moving canvas; typography and layout are untouched.
  await page.addStyleTag({ content: "#visualizer-canvas,.paper-grain-overlay { visibility:hidden!important; }" });
  await page.evaluate(() => document.fonts.ready);
  const positions = () => page.locator(".music-lyrics-word-ink").evaluateAll(elements => elements.map(el => {
    const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
  }));
  const before = await positions();
  const primaryInk = await page.locator(".lyric-wrap").screenshot();
  const reflectedInk = await page.locator(".water-reflection").screenshot();
  await page.addStyleTag({ content: ".theme-sketchbook .music-lyrics-word-ink { clip-path:none!important; }" });
  expect((await page.locator(".lyric-wrap").screenshot()).equals(primaryInk)).toBe(true);
  expect((await page.locator(".water-reflection").screenshot()).equals(reflectedInk)).toBe(true);
  expect(await positions()).toEqual(before);
});

test("export preserves complete letter strokes and reflection blur", async ({ page }) => {
  await page.goto("/");
  const difference = await page.evaluate(async segment => {
    const rendererModule = "/src/lib/video/VideoRenderer.ts", spectrumModule = "/src/lib/video/OfflineSpectrum.ts";
    const { createVideoRenderer } = await import(/* @vite-ignore */ rendererModule);
    const { OfflineSpectrum } = await import(/* @vite-ignore */ spectrumModule);
    const options = { width: 720, height: 1280, theme: "sketchbook", title: "Ink regression", segments: [segment], duration: 10, fps: 30 };
    const actual = await createVideoRenderer(options), reference = await createVideoRenderer(options);
    // Reference keeps the water boundary but never crops individual letter strokes.
    const ctx = reference.canvas.getContext("2d")!, rect = ctx.rect, clip = ctx.clip;
    let waterBoundary = false;
    ctx.rect = (x, y, width, height) => { waterBoundary = x === 0 && width === 390; rect.call(ctx, x, y, width, height); };
    ctx.clip = () => { if (waterBoundary) clip.call(ctx); };
    actual.draw(6, new OfflineSpectrum([new Float32Array(44100 * 10)], 44100));
    reference.draw(6, new OfflineSpectrum([new Float32Array(44100 * 10)], 44100));
    const a = actual.pixels(), b = reference.pixels();
    let changed = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
    actual.destroy(); reference.destroy(); return changed;
  }, segment);
  expect(difference).toBe(0);
});
