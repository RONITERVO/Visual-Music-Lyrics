import type { MusicLyricTheme, Segment } from "../../types";
import { isLoopbackApp } from "../localSuno";
import { createVideoRenderer } from "./VideoRenderer";
import { OfflineSpectrum } from "./OfflineSpectrum";

export interface VideoExportOptions {
  file: File; title: string; segments: Segment[]; theme: MusicLyricTheme;
  width: number; height: number; fps: number; mode: "publish" | "lossless";
  audio?: "preserve" | "aac";
}
export interface VideoExportProgress { phase: string; frames: number; total: number; elapsed: number }

export async function exportVideo(options: VideoExportOptions, signal: AbortSignal, onProgress: (value: VideoExportProgress) => void) {
  if (!isLoopbackApp()) throw new Error("Fast video export runs in the local desktop app. Open your library there to export.");
  const started = performance.now();
  let id = "", renderer: Awaited<ReturnType<typeof createVideoRenderer>> | undefined;
  const progress = (phase: string, frames = 0, total = 0) => onProgress({ phase, frames, total, elapsed: (performance.now() - started) / 1000 });
  const checkCanceled = () => { if (signal.aborted) throw new DOMException("Export canceled", "AbortError"); };
  const request = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(`/api/local/video${url}`, { ...init, signal, headers: { "X-Local-Export": "video", ...init.headers } });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error || "Restart the local app to enable video export.");
    return data;
  };
  try {
    progress("Preparing audio");
    await request("/capabilities");
    if (options.file.size > 256 * 1024 * 1024) throw new Error("Video export supports audio files up to 256 MB.");
    const context = new OfflineAudioContext(2, 1, 44100);
    const audio = await context.decodeAudioData(await options.file.arrayBuffer());
    checkCanceled();
    if (audio.duration > 1200) throw new Error("Export up to 20 minutes per video.");
    const total = Math.ceil(audio.duration * options.fps);
    const spectrum = new OfflineSpectrum(Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)), audio.sampleRate);
    renderer = await createVideoRenderer({ ...options, duration: audio.duration });
    checkCanceled();
    const config = { width: options.width, height: options.height, fps: options.fps, mode: options.mode, audio: options.audio || "preserve", duration: audio.duration };
    const job = await request("/jobs", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Export-Config": JSON.stringify(config) }, body: options.file });
    id = job.id;
    const batchSize = Math.max(1, Math.min(4, Math.floor(24 * 1024 * 1024 / (options.width * options.height * 4))));
    for (let frame = 0; frame < total;) {
      const first = frame, chunks: BlobPart[] = [];
      while (frame < total && chunks.length < batchSize) {
        checkCanceled(); renderer.draw(frame / options.fps, spectrum);
        chunks.push(renderer.pixels().buffer as ArrayBuffer); frame++;
      }
      await request(`/jobs/${id}/frames?start=${first}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Blob(chunks) });
      progress("Rendering video", frame, total);
    }
    progress("Finishing video", total, total);
    await request(`/jobs/${id}/finish`, { method: "POST" });
    for (;;) {
      checkCanceled();
      const state = await request(`/jobs/${id}`);
      if (state.state === "error") throw new Error(state.error || "Video encoding failed.");
      if (state.state === "ready") break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    progress("Video ready", total, total);
    return { id, url: `/api/local/video/jobs/${id}/file?name=${encodeURIComponent(options.title)}`, extension: job.extension || (options.mode === "lossless" ? "mkv" : "mp4"), elapsed: (performance.now() - started) / 1000,
      duration: audio.duration, frames: total };
  } catch (error) {
    if (id) await removeVideoExport(id).catch(() => {});
    throw error;
  } finally { renderer?.destroy(); }
}

export async function removeVideoExport(id: string) {
  await fetch(`/api/local/video/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Local-Export": "video" } });
}
