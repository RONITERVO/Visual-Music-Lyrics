import express, { type Express } from "express";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import ffmpeg from "ffmpeg-static";
import { isLocalImportRequest } from "./localSuno";
import { firstAudioCodec, exportAudioPlan } from "./audioPreservation";

export interface VideoConfig {
  width: number; height: number; fps: number; duration: number;
  mode: "publish" | "lossless";
  audio?: "preserve" | "aac";
}
export function validateVideoConfig(value: any): VideoConfig {
  if (!value || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || value.width < 320 || value.height < 320 || value.width > 1920 || value.height > 1920
    || value.width % 2 || value.height % 2 || ![24, 30, 60].includes(value.fps)
    || typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 1200
    || (value.audio !== undefined && !["preserve", "aac"].includes(value.audio))
    || !["publish", "lossless"].includes(value.mode)) throw new Error("Invalid video size, frame rate, duration or format (maximum 20 minutes).");
  return { width: value.width, height: value.height, fps: value.fps, duration: value.duration, mode: value.mode, ...(value.audio === undefined ? {} : { audio: value.audio }) };
}

interface Job {
  id: string; directory: string; output: string; config: VideoConfig; child: ChildProcessWithoutNullStreams;
  frames: number; total: number; uploading: boolean; state: "rendering" | "encoding" | "ready" | "error";
  error: string; done: Promise<void>; timer?: NodeJS.Timeout;
}

/** No user-controlled file paths, remote URLs, or production registration. */
export function registerLocalVideo(app: Express) {
  if (process.env.NODE_ENV === "production" || process.env.LOCAL_MEDIA_IMPORT !== "true") return;
  const jobs = new Map<string, Job>();
  const tempRoot = path.resolve(os.tmpdir());
  let creating = false;
  const cleanDirectory = async (directory: string) => {
    if (path.dirname(path.resolve(directory)) !== tempRoot || !path.basename(directory).startsWith("visual-music-video-")) throw new Error("Invalid export workspace.");
    await rm(directory, { recursive: true, force: true });
  };
  const cleanup = async (job: Job) => {
    clearTimeout(job.timer); jobs.delete(job.id);
    if (job.state === "rendering" || job.state === "encoding") job.child.kill();
    await job.done.catch(() => {});
    await cleanDirectory(job.directory);
  };
  const touch = (job: Job) => {
    if (jobs.get(job.id) !== job) return;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => { void cleanup(job).catch(() => {}); }, 10 * 60_000);
    job.timer.unref();
  };
  const router = express.Router();
  app.use("/api/local/video", router);
  router.use((req, res, next) => {
    if (!isLocalImportRequest(req)) { res.status(403).json({ error: "Video export requires the same-origin local app." }); return; }
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.headers["x-local-export"] !== "video") { res.sendStatus(400); return; }
    next();
  });
  router.get("/capabilities", (_req, res) => res.json({ available: true, busy: creating || [...jobs.values()].some(j => j.state === "rendering" || j.state === "encoding") }));
  router.post("/jobs", (req, res, next) => {
    if (creating || [...jobs.values()].some(j => j.state === "rendering" || j.state === "encoding")) {
      res.status(409).json({ error: "Finish or cancel the current video export first." }); return;
    }
    try { res.locals.config = validateVideoConfig(JSON.parse(String(req.headers["x-export-config"] || ""))); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    creating = true;
    next();
  }, express.raw({ type: "application/octet-stream", limit: "256mb" }), async (req, res) => {
    let directory = "";
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error("Choose an audio file.");
      // Keep the most recent download available, without blocking future exports.
      while (jobs.size >= 2) await cleanup(jobs.values().next().value!);
      const config: VideoConfig = res.locals.config;
      directory = await mkdtemp(path.join(tempRoot, "visual-music-video-"));
      const input = path.join(directory, "audio");
      await writeFile(input, req.body); req.body = undefined;
      const audioPlan = exportAudioPlan(await firstAudioCodec(input), config.mode, config.audio || "preserve");
      const output = path.join(directory, `visualizer.${audioPlan.extension}`);
      const total = Math.ceil(config.duration * config.fps);
      const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pixel_format", "rgba",
        "-video_size", `${config.width}x${config.height}`, "-framerate", String(config.fps), "-i", "pipe:0",
        "-protocol_whitelist", "file,pipe", "-i", input, "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", config.mode === "lossless" ? "libx264rgb" : "libx264", "-preset", "ultrafast", "-crf", config.mode === "lossless" ? "0" : "17",
        "-pix_fmt", config.mode === "lossless" ? "rgb24" : "yuv420p", "-threads", "4",
        ...audioPlan.args,
        // The frame pipe bounds video; never truncate original audio to Web Audio's resampled duration.
        ...(audioPlan.extension === "mp4" ? ["-movflags", "+faststart"] : []), output];
      const child = spawn(process.env.FFMPEG_PATH || ffmpeg || "ffmpeg", args, { windowsHide: true, timeout: 30 * 60_000, stdio: ["pipe", "pipe", "pipe"] });
      const job: Job = { id: crypto.randomUUID(), directory, output, config, child, frames: 0, total,
        uploading: false, state: "rendering", error: "", done: Promise.resolve() };
      let diagnostic = "";
      child.stdout.resume();
      child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-3000); });
      child.stdin.on("error", () => {});
      job.done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => code === 0 && job.frames === job.total ? resolve() : reject(new Error(diagnostic.trim() || "Video encoding stopped before all frames arrived.")));
      });
      void job.done.then(() => { job.state = "ready"; touch(job); }, error => { job.state = "error"; job.error = error.message; touch(job); });
      jobs.set(job.id, job); touch(job);
      if (res.destroyed) await cleanup(job); else res.json({ id: job.id, totalFrames: total, extension: audioPlan.extension });
    } catch (error) {
      if (directory) await cleanDirectory(directory).catch(() => {});
      if (!res.destroyed) res.status(422).json({ error: (error as Error).message });
    } finally { creating = false; }
  }, (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    creating = false; res.status(error.status || 400).json({ error: "Could not read audio (256 MB maximum)." });
  });
  router.use("/jobs/:id", (req, res, next) => {
    const job = jobs.get(req.params.id);
    if (!job) { res.status(404).json({ error: "Video export expired or was canceled." }); return; }
    res.locals.job = job; touch(job); next();
  });
  router.post("/jobs/:id/frames", express.raw({ type: "application/octet-stream", limit: "32mb" }), async (req, res) => {
    const job: Job = res.locals.job;
    const bytes = job.config.width * job.config.height * 4;
    const count = Buffer.isBuffer(req.body) ? req.body.length / bytes : 0;
    if (job.state !== "rendering" || job.uploading || Number(req.query.start) !== job.frames || !Number.isInteger(count) || count < 1 || count > 4 || job.frames + count > job.total) {
      res.status(409).json({ error: job.error || "Frames must arrive once, in order, at the chosen video size." }); return;
    }
    job.uploading = true;
    try {
      await new Promise<void>((resolve, reject) => job.child.stdin.write(req.body, error => error ? reject(error) : resolve()));
      job.frames += count;
      res.json({ frames: job.frames });
    } catch (error) { res.status(422).json({ error: job.error || (error as Error).message }); }
    finally { job.uploading = false; }
  });
  router.post("/jobs/:id/finish", (req, res) => {
    const job: Job = res.locals.job;
    if (job.state === "error" || job.frames !== job.total || job.uploading) { res.status(409).json({ error: job.error || "Not all frames have arrived." }); return; }
    if (job.state === "rendering") { job.state = "encoding"; job.child.stdin.end(); }
    res.json({ state: job.state });
  });
  router.get("/jobs/:id", (_req, res) => {
    const job: Job = res.locals.job;
    res.json({ state: job.state, frames: job.frames, totalFrames: job.total, error: job.error });
  });
  router.get("/jobs/:id/file", (req, res) => {
    const job: Job = res.locals.job;
    if (job.state !== "ready") { res.status(409).json({ error: job.error || "Video is still encoding." }); return; }
    const name = (typeof req.query.name === "string" ? req.query.name : "visualizer").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120).trim() || "visualizer";
    res.download(job.output, name + path.extname(job.output));
  });
  router.delete("/jobs/:id", async (_req, res) => {
    try { await cleanup(res.locals.job); res.sendStatus(204); }
    catch { res.status(500).json({ error: "Could not remove export temporary files." }); }
  });
  router.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 400).json({ error: "Could not read video frame data." }));
}
