import express, { type Express, type Request } from "express";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractPreservedAudio } from "./audioPreservation";

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
  const tempRoot = path.resolve(os.tmpdir());
  let busy = false;
  app.use("/api/local", (req, res, next) => {
    if (!isLocalImportRequest(req)) { res.status(403).json({ error: "Local import requires a same-origin loopback connection." }); return; }
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/local/capabilities", (_req, res) => {
    res.json({ audioExtraction: true, busy });
  });
  // Reserve the single worker before buffering the upload, including concurrent requests.
  app.post("/api/local/suno", (req, res, next) => {
    if (busy) { res.status(409).json({ error: "A local video import is already running." }); return; }
    if (req.headers["x-local-import"] !== "suno") { res.sendStatus(400); return; }
    busy = true;
    next();
  }, express.raw({ type: "application/octet-stream", limit: "768mb" }), async (req, res) => {
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
      const preserved = await extractPreservedAudio(input, directory, controller.signal);
      const audio = await readFile(preserved.output);
      res.json({ audioBase64: audio.toString("base64"), mimeType: preserved.mimeType, extension: preserved.extension });
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
    res.status(error.status || 400).json({ error: error.type === "entity.too.large" ? "Video exceeds the 768 MB import limit." : "Could not read video upload." });
  });
}
