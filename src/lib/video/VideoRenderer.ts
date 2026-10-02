import type { MusicLyricTheme, MusicLyricWord, Segment } from "../../types";
import { createMusicLyricVisualizer } from "../graphics/MusicLyricVisualizers";
import { MusicLyricReactivity, resolveSketchbookHorizon, type MusicLyricBounds } from "../graphics/MusicLyricReactivity";
import { estimatedMusicLyricWords, musicLyricDisplaySegmentAt, wordProgress } from "../graphics/MusicLyricsTiming";
import { formatPreciseClock } from "../utils";
import { OfflineSpectrum } from "./OfflineSpectrum";

interface PlacedWord extends MusicLyricWord { x: number; y: number; width: number }
interface TextLayout { words: PlacedWord[]; font: string; size: number; height: number; top: number }
export interface VideoRenderOptions { width: number; height: number; theme: MusicLyricTheme; title: string; segments: Segment[]; duration: number; fps: number }

/** Frame renderer: same visualizer engines and lyric clock, with a canvas text
 * compositor so export never has to screen-record, seek playback, or omit DOM lyrics. */
export async function createVideoRenderer(options: VideoRenderOptions) {
  await document.fonts.load('700 42px "Caveat"');
  await document.fonts.ready;
  const output = document.createElement("canvas");
  output.width = options.width; output.height = options.height;
  const context = output.getContext("2d", { alpha: false, willReadFrequently: true })!;
  const scene = document.createElement("canvas");
  const width = options.width > options.height ? 844 : 390;
  const scale = options.width / width, height = options.height / scale;
  const sketch = options.theme === "sketchbook";
  const engine = await createMusicLyricVisualizer(options.theme, scene, { width, height, pixelRatio: scale });
  const reactivity = new MusicLyricReactivity();
  const frequency = new Uint8Array(512), waveform = new Uint8Array(1024);
  const marginLeft = width <= 600 ? 34 : 92, marginRight = width <= 600 ? 18 : 42;
  const usable = width - marginLeft - marginRight;
  const center = marginLeft + usable / 2;
  const layoutCache = new Map<Segment, { primary: TextLayout; translation: TextLayout }>();

  const textLayout = (words: MusicLyricWord[], requestedSize: number, top: number, maxHeight: number): TextLayout => {
    let size = requestedSize, lines: PlacedWord[][] = [], font = "";
    for (;;) {
      font = `700 ${size}px ${sketch ? '"Caveat"' : 'Georgia, serif'}`;
      context.font = font;
      const space = context.measureText(" ").width;
      lines = [[]]; let used = 0, longest = 0;
      for (const word of words) {
        const wordWidth = context.measureText(word.value).width;
        longest = Math.max(longest, wordWidth);
        if (used && used + space + wordWidth > usable) { lines.push([]); used = 0; }
        if (used) used += space;
        lines[lines.length - 1].push({ ...word, x: used, y: 0, width: wordWidth });
        used += wordWidth;
      }
      if (size <= 14 || (lines.length * size * 1.14 <= maxHeight && longest <= usable)) break;
      size -= 1;
    }
    const placed: PlacedWord[] = [];
    lines.forEach((line, index) => {
      const extent = line.length ? line[line.length - 1].x + line[line.length - 1].width : 0;
      for (const word of line) placed.push({ ...word, x: center - extent / 2 + word.x, y: top + index * size * 1.14 });
    });
    return { words: placed, size, font, height: words.length ? lines.length * size * 1.14 : 0, top };
  };
  const getLayout = (segment: Segment) => {
    const existing = layoutCache.get(segment);
    if (existing) return existing;
    const primaryWords = segment.words?.length ? segment.words : estimatedMusicLyricWords(segment.primary, segment.start, segment.end);
    const translationWords = segment.translationWords?.length ? segment.translationWords
      : segment.translationTiming === "sung" ? [] : estimatedMusicLyricWords(segment.translation || segment.secondary, segment.start, segment.end);
    const primary = textLayout(primaryWords, width > 600 ? 42 : sketch ? 38 : 30, height * .37, height * .22);
    const horizon = resolveSketchbookHorizon(primary.top + primary.height + 7, height);
    const translationTop = sketch ? horizon + 15 : primary.top + primary.height + 20;
    const translation = textLayout(translationWords, width > 600 ? 34 : sketch ? 32 : 24, translationTop,
      sketch ? (height - translationTop - 24) / .65 : height - translationTop - 35);
    const result = { primary, translation }; layoutCache.set(segment, result); return result;
  };
  const bounds = (layout: TextLayout): MusicLyricBounds | undefined => layout.words.length ? {
    left: Math.min(...layout.words.map(w => w.x)), right: Math.max(...layout.words.map(w => w.x + w.width)),
    top: layout.top, bottom: layout.top + layout.height,
  } : undefined;

  const paintText = (layout: TextLayout, seconds: number, translation: boolean, alpha: number, activeScale: number) => {
    context.font = layout.font; context.textBaseline = "top";
    for (const word of layout.words) {
      const progress = wordProgress(word.start, word.end, seconds);
      const active = seconds >= word.start && seconds < word.end;
      const color = sketch ? translation ? "#184ba5" : "#231e1c" : translation ? "#c084fc" : active ? "#00e5ff" : "#f0f4f8";
      context.save();
      if (!sketch && active) {
        context.translate(word.x + word.width / 2, word.y + layout.size / 2 - 2);
        context.scale(activeScale, activeScale); context.translate(-word.x - word.width / 2, -word.y - layout.size / 2);
      }
      context.fillStyle = color;
      if (!sketch) {
        context.globalAlpha = alpha * (seconds < word.start ? .04 : .18);
        context.fillText(word.value, word.x, word.y);
        context.shadowColor = translation ? "#c084fc" : "#00e5ff";
        context.shadowBlur = active ? 18 * scale : 7 * scale;
      }
      if (progress > 0) {
        context.globalAlpha = alpha;
        // Handwritten strokes extend beyond the advance width used for layout.
        // Once written, omit the mask so strokes and reflection blur stay intact.
        if (progress < 1) {
          const inkPadding = layout.size * (sketch ? .22 : .12) * progress;
          context.beginPath(); context.rect(word.x - layout.size * .12, word.y - layout.size * .2,
            word.width * progress + layout.size * .12 + inkPadding, layout.size * 1.6); context.clip();
        }
        context.fillText(word.value, word.x, word.y);
        if (!sketch && active) context.fillRect(word.x, word.y + layout.size * 1.03, word.width * progress, layout.size * .055);
      }
      context.restore();
    }
  };

  return {
    canvas: output,
    draw(seconds: number, spectrum: OfflineSpectrum) {
      spectrum.at(seconds);
      const segment = musicLyricDisplaySegmentAt(options.segments, seconds);
      const layout = segment ? getLayout(segment) : undefined;
      const primary = layout ? bounds(layout.primary) : undefined;
      const translation = layout ? bounds(layout.translation) : undefined;
      const active = layout && [...layout.primary.words, ...layout.translation.words].find(w => seconds >= w.start && seconds < w.end);
      const frame = reactivity.sample(spectrum as unknown as AnalyserNode, frequency, waveform, seconds / options.duration, {
        horizon: resolveSketchbookHorizon(primary ? primary.bottom + 7 : undefined, height), primary, translation,
        activeWord: active ? { left: active.x, right: active.x + active.width, top: active.y, bottom: active.y + (layout?.primary.size || 30) } : undefined,
      }, (seconds + 1 / options.fps) * 1000);
      engine.draw(frame);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1; context.filter = "none"; context.globalCompositeOperation = "source-over";
      context.fillStyle = sketch ? "#f4eee1" : "#08090c"; context.fillRect(0, 0, output.width, output.height);
      context.globalCompositeOperation = sketch ? "multiply" : "source-over";
      context.drawImage(scene, 0, 0); context.globalCompositeOperation = "source-over";
      context.save(); context.scale(scale, scale);
      if (sketch) {
        const spine = width <= 600 ? 22 : 50;
        const shade = context.createLinearGradient(0, 0, spine, 0);
        shade.addColorStop(0, "#0005"); shade.addColorStop(1, "#0000"); context.fillStyle = shade;
        context.fillRect(0, 0, spine, height); context.strokeStyle = "#231e1c66"; context.setLineDash([4, 3]);
        context.beginPath(); context.moveTo(spine, 0); context.lineTo(spine, height); context.stroke(); context.setLineDash([]);
        for (let y = 90; y < height; y += height / 7) { context.fillStyle = "#090909"; context.beginPath(); context.arc(spine / 2, y, 3.5, 0, 2 * Math.PI); context.fill(); }
      }
      context.font = '500 19px "Caveat"'; context.textBaseline = "top";
      context.globalAlpha = sketch ? .65 : .9;
      const clock = formatPreciseClock(seconds), clockWidth = context.measureText(clock).width;
      let title = options.title;
      while (title.length && context.measureText(title).width > usable - clockWidth - 20) title = title.slice(0, -1);
      context.fillStyle = sketch ? "#231e1c" : "#a8d6f2";
      context.fillText(title + (title !== options.title ? "…" : ""), marginLeft, 40);
      context.fillStyle = sketch ? "#184ba5" : "#00e5ff";
      context.fillText(clock, width - marginRight - clockWidth, 40);
      context.globalAlpha = 1;
      if (layout && segment) {
        const exit = Math.max(0, Math.min(1, (seconds - segment.end) / .42));
        const fade = (sketch ? 1 : Math.min(1, (seconds - segment.start) / .42)) * (1 - exit);
        context.save(); context.translate(0, -frame.energy * 4.5);
        paintText(layout.primary, seconds, false, fade, 1.01 + frame.transient * .036 + frame.beat * .018);
        context.restore();
        context.save();
        if (sketch) {
          context.beginPath(); context.rect(0, frame.layout.horizon, width, height - frame.layout.horizon); context.clip();
          context.translate(center, layout.translation.top);
          context.transform(1, 0, Math.sin(seconds * Math.PI / 4) * .022, .62, 0, Math.sin(seconds * Math.PI / 4) * 2);
          context.translate(-center, -layout.translation.top); context.filter = `blur(${2.1 * scale}px)`;
        } else context.translate(0, -frame.lowMid * 5);
        paintText(layout.translation, seconds, true, fade * (sketch ? .45 : 1), 1.01 + frame.transient * .036);
        context.restore();
      }
      context.restore();
      return frame;
    },
    pixels() { return context.getImageData(0, 0, output.width, output.height).data; },
    destroy() { engine.destroy?.(); output.width = output.height = scene.width = scene.height = 1; },
  };
}
