import express, { type Express, type Request } from "express";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

export function isLocalImportRequest(req: Pick<Request, "socket" | "headers">) {
  const peer = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer || "")) return false;
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)) return false;
    return !req.headers.origin || new URL(req.headers.origin).host === host.host;
  } catch { return false; }
}

/** Deliberately absent from production and Cloud Run. Accept file bytes, never paths. */
export function registerLocalSuno(app: Express) {
  if (process.env.NODE_ENV === "production" || process.env.LOCAL_MEDIA_IMPORT !== "true") return;
  const python = process.env.LOCAL_LYRICS_PYTHON || path.resolve(".venv-lyrics", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const model = process.env.LOCAL_WHISPER_MODEL || "";
  const tempRoot = path.resolve(os.tmpdir());
  let busy = false;
  app.use("/api/local", (req, res, next) => {
    if (!isLocalImportRequest(req)) { res.status(403).json({ error: "Local import requires a same-origin loopback connection." }); return; }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/local/capabilities", (_req, res) => {
    res.json({ suno: existsSync(python) && existsSync(model), busy });
  });
  // Reserve the single worker before buffering the upload, including concurrent requests.
  app.post("/api/local/suno", (req, res, next) => {
    if (busy) { res.status(409).json({ error: "A local video import is already running." }); return; }
    if (!existsSync(python) || !existsSync(model)) {
      res.status(503).json({ error: "Configure LOCAL_LYRICS_PYTHON and LOCAL_WHISPER_MODEL for local Suno import." }); return;
    }
    if (req.headers["x-local-import"] !== "suno") { res.sendStatus(400); return; }
    busy = true;
    next();
  }, express.raw({ type: "application/octet-stream", limit: "100mb" }), async (req, res) => {
    let directory = "";
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", onClose);
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error("Choose a video file.");
      directory = await mkdtemp(path.join(tempRoot, "visual-music-suno-"));
      const input = path.join(directory, "source.mp4");
      await writeFile(input, req.body);
      req.body = undefined;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(python, [path.resolve("scripts/visual_lyrics_extractor.py"), input,
          "--output-dir", directory, "--model", model, "--ffmpeg", process.env.FFMPEG_PATH || ffmpeg || "ffmpeg"], {
          windowsHide: true, signal: controller.signal, timeout: 15 * 60_000,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" }, stdio: ["ignore", "pipe", "pipe"],
        });
        let diagnostic = "";
        child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-5000); });
        child.stdout.on("data", () => {});
        child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(
          `Local lyric extraction failed. ${diagnostic.split(/\r?\n/).filter(Boolean).slice(-1)[0] || "Check Python dependencies and the Whisper model."}`)));
      });
      const timing = JSON.parse(await readFile(path.join(directory, "timing.json"), "utf8"));
      const audio = await readFile(path.join(directory, "audio.m4a"));
      res.json({ timing, audioBase64: audio.toString("base64"), mimeType: "audio/mp4" });
    } catch (error) {
      if (!res.destroyed) res.status(422).json({ error: error instanceof Error ? error.message : "Local import failed." });
    } finally {
      res.off("close", onClose);
      // This directory is exclusively created by mkdtemp for this request.
      try {
        if (directory && path.dirname(path.resolve(directory)) === tempRoot && path.basename(directory).startsWith("visual-music-suno-")) {
          await rm(directory, { recursive: true, force: true });
        }
      } finally { busy = false; }
    }
  }, (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    busy = false;
    res.status(error.status || 400).json({ error: error.type === "entity.too.large" ? "Video exceeds the 100 MB import limit." : "Could not read video upload." });
  });
}
