import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import express from "express";
import ffmpeg from "ffmpeg-static";
import { registerLocalSuno } from "../server/localSuno";

test("Gemini video import extracts only audio with no Python or Whisper configured", async () => {
  const prior = { ...process.env };
  process.env.NODE_ENV = "test";
  process.env.LOCAL_MEDIA_IMPORT = "true";
  process.env.LOCAL_LYRICS_PYTHON = "missing-test-python";
  process.env.LOCAL_WHISPER_MODEL = "missing-test-model";
  const app = express();
  registerLocalSuno(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const fixture = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=32x32:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050", "-t", "1", "-c:v", "mpeg4", "-c:a", "aac",
      "-f", "mp4", "-movflags", "frag_keyframe+empty_moov", "pipe:1"], { windowsHide: true });
    assert.equal(fixture.status, 0, fixture.stderr.toString());
    const forbidden = await fetch(`${base}/api/local/suno?audioOnly=1`, {
      method: "POST", headers: { Origin: "https://foreign.example", "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: fixture.stdout,
    });
    assert.equal(forbidden.status, 403);
    const response = await fetch(`${base}/api/local/suno?audioOnly=1`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: fixture.stdout,
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.timing, undefined);
    assert.equal(data.mimeType, "audio/mp4");
    const probe = spawnSync(ffmpeg!, ["-hide_banner", "-i", "pipe:0", "-f", "null", "-"], {
      input: Buffer.from(data.audioBase64, "base64"), windowsHide: true,
    });
    assert.equal(probe.status, 0, probe.stderr.toString());
    assert.match(probe.stderr.toString(), /Audio: aac/);
    assert.doesNotMatch(probe.stderr.toString(), /Video:/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of ["NODE_ENV", "LOCAL_MEDIA_IMPORT", "LOCAL_LYRICS_PYTHON", "LOCAL_WHISPER_MODEL"]) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  }
});
