import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import express from "express";
import ffmpeg from "ffmpeg-static";
import { registerLocalSuno } from "../server/localSuno";

for (const suffix of ["", "?audioOnly=1"]) test(`video import ${suffix || "without JSON"} extracts only audio with no Python or Whisper configured`, async () => {
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
    const forbidden = await fetch(`${base}/api/local/suno${suffix}`, {
      method: "POST", headers: { Origin: "https://foreign.example", "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: fixture.stdout,
    });
    assert.equal(forbidden.status, 403);
    const response = await fetch(`${base}/api/local/suno${suffix}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: fixture.stdout,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "audio/mp4");
    assert.equal(response.headers.get("X-Audio-Extension"), "m4a");
    const audio = Buffer.from(await response.arrayBuffer());
    const packets = (input: Buffer) => {
      const result = spawnSync(ffmpeg!, ["-v", "error", "-i", "pipe:0", "-map", "0:a:0", "-c:a", "copy", "-f", "adts", "pipe:1"], { input, windowsHide: true });
      assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
    };
    assert.deepEqual(packets(audio), packets(fixture.stdout), "AAC packets must survive import without another lossy encode");
    const probe = spawnSync(ffmpeg!, ["-hide_banner", "-i", "pipe:0", "-f", "null", "-"], {
      input: audio, windowsHide: true,
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

test("20-minute ALAC import streams WAV beyond the base64 string limit", { timeout: 120_000 }, async () => {
  const previous = process.env.LOCAL_MEDIA_IMPORT;
  process.env.LOCAL_MEDIA_IMPORT = "true";
  const app = express(); registerLocalSuno(app);
  if (previous === undefined) delete process.env.LOCAL_MEDIA_IMPORT; else process.env.LOCAL_MEDIA_IMPORT = previous;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    // Silence compresses to a small source, but decodes to 460 MB of exact PCM.
    const fixture = spawnSync(ffmpeg!, ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-t", "1200", "-c:a", "alac", "-f", "matroska", "pipe:1"], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    assert.equal(fixture.status, 0, fixture.stderr.toString());
    const response = await fetch(base + "/api/local/suno", { method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Local-Import": "suno" }, body: fixture.stdout });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "audio/wav");
    assert.equal(response.headers.get("X-Audio-Extension"), "wav");
    let bytes = 0;
    const reader = response.body!.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
    }
    assert.ok(bytes >= 1200 * 48000 * 2 * 4);
    assert.equal(bytes, Number(response.headers.get("Content-Length")));
    // The worker is released only once transfer and temporary-file cleanup finish.
    for (let i = 0; i < 100; i++) {
      if (!(await (await fetch(base + "/api/local/capabilities")).json()).busy) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Import worker was not released");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
