import { test, expect } from "@playwright/test";

function tone() {
  const rate = 22050, samples = rate * 10, buffer = Buffer.alloc(44 + samples*2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length-8,4); buffer.write("WAVEfmt ",8);
  buffer.writeUInt32LE(16,16); buffer.writeUInt16LE(1,20); buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(rate,24); buffer.writeUInt32LE(rate*2,28); buffer.writeUInt16LE(2,32); buffer.writeUInt16LE(16,34);
  buffer.write("data",36); buffer.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++) buffer.writeInt16LE(Math.round(Math.sin(i/rate*110*Math.PI*2)*20000*(Math.floor(i/rate*4)%2 ? .2:1)),44+i*2);
  return buffer;
}
const timing = { segments: [{ id: "pair", start: 1, end: 7, primary: "Caminando por la calle", translation: "Walking down the street", language_code: "es", translationTiming: "sung",
  words: ["Caminando", "por", "la", "calle"].map((word, i) => ({ word, start: 1+i*.5, end: 1.5+i*.5 })),
  translationWords: ["Walking", "down", "the", "street"].map((value, i) => ({ value, start: 4+i*.5, end: 4.5+i*.5 })) }] };

for (const viewport of [{width:320,height:568},{width:390,height:844},{width:430,height:932},{width:844,height:390},{width:1280,height:720}]) {
  test(`bilingual playback and both themes at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.getByLabel("Add audio, Suno video or lyric timing files").setInputFiles([
      {name:"fixture.wav",mimeType:"audio/wav",buffer:tone()},
      {name:"fixture.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(timing))},
    ]);
    await expect(page.getByRole("status")).toContainText("Files added.");
    await page.getByRole("button",{name:"Dismiss",exact:true}).click();
    await page.evaluate(() => { const audio = document.querySelector("audio")!; audio.pause(); audio.currentTime=2; });
    await expect(page.locator(".music-lyrics-primary button")).toHaveCount(4);
    await expect(page.locator(".music-lyrics-primary button").first()).toContainText("Caminando");
    await expect(page.locator(".music-lyrics-translation button.written")).toHaveCount(0);
    await page.evaluate(() => { document.querySelector("audio")!.currentTime=4.2; });
    await expect(page.locator(".music-lyrics-translation button.active")).toContainText("Walking");
    await expect(page.locator(".music-lyrics-primary button.written")).toHaveCount(4);
    for (const selector of [".music-lyrics-primary", ".music-lyrics-translation"]) {
      const box = await page.locator(selector).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x+box!.width).toBeLessThanOrEqual(viewport.width+1);
      expect(box!.y+box!.height).toBeLessThan(viewport.height-20);
    }
    const upper = await page.locator(".music-lyrics-primary").boundingBox();
    const lower = await page.locator(".music-lyrics-translation").boundingBox();
    expect(lower!.y).toBeGreaterThan(upper!.y+upper!.height);
    await expect(page.locator("#visualizer-canvas")).toHaveAttribute("data-theme","sketchbook");
    await page.screenshot({path:`.artifacts/sketchbook-${viewport.width}.png`, animations:"disabled"});
    await page.getByRole("button",{name:"Living Sketchbook",exact:true}).click();
    await expect(page.locator(".stage-shell")).toHaveClass(/theme-signal-bloom/);
    await expect(page.locator("#visualizer-canvas")).toHaveCSS("mix-blend-mode","normal");
    await expect(page.locator("#visualizer-canvas")).toHaveAttribute("data-theme","signal-bloom");
    await page.screenshot({path:`.artifacts/signal-bloom-${viewport.width}.png`, animations:"disabled"});
    // User gesture connects/resumes the actual Web Audio graph.
    await page.locator(".stage-shell").click({position:{x:150,y:130}});
    await expect.poll(() => page.evaluate(async () => {
      const storePath = "/src/lib/store.ts";
      const { useStore } = await import(/* @vite-ignore */ storePath);
      return useStore.getState().audioContext?.state;
    })).toBe("running");
    await expect.poll(() => page.evaluate(() => Number(document.querySelector<HTMLElement>(".stage-shell")!.style.getPropertyValue("--lyric-energy")))).toBeGreaterThan(.01);
    await page.evaluate(() => { const audio=document.querySelector("audio")!; audio.pause(); audio.currentTime=8; });
    await expect.poll(() => page.evaluate(() => Number(document.querySelector<HTMLElement>(".stage-shell")!.style.getPropertyValue("--lyric-energy")))).toBeLessThan(.001);
    await expect(page.locator(".music-lyrics-cue")).toHaveCount(0);
    await page.reload();
    await page.getByRole("button",{name:"Open library and playback controls"}).click();
    await expect(page.getByText("fixture.wav",{exact:true}).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
