import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import express from "express";
import ffmpeg from "ffmpeg-static";
import { registerLocalSuno } from "../server/localSuno";
import { registerLocalVideo } from "../server/localVideo";
import { exportAudioPlan, extractionFormat } from "../server/audioPreservation";

function ff(args: string[], input?: Buffer) {
  const result = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", ...args],
    { input, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
}

test("audio quality and container are independent of video quality", () => {
  for (const mode of ["publish", "lossless"] as const) {
    for (const codec of ["aac", "flac", "pcm_s16le", "mp3", "alac"]) {
      assert.equal(exportAudioPlan(codec, mode, "preserve").copy, true);
      assert.equal(exportAudioPlan(codec, mode, "preserve").extension, mode === "publish" && codec === "aac" ? "mp4" : "mkv");
    }
  }
  assert.deepEqual(exportAudioPlan("flac", "publish", "aac").args, ["-c:a", "aac", "-b:a", "320k"]);
  assert.equal(exportAudioPlan("aac", "publish", "aac").copy, true);
  assert.equal(extractionFormat("pcm_s24le").encoder, "pcm_s24le");
  assert.equal(extractionFormat("pcm_f32le").encoder, "pcm_f32le");
  assert.equal(extractionFormat("flac").encoder, "copy");
});

for (const floating of [false, true]) test(`capture ${floating ? "float PCM" : "FLAC"} video → Gemini import → compressed-video export retains every stereo sample`, { timeout: 60_000 }, async () => {
  const previous = process.env.LOCAL_MEDIA_IMPORT;
  process.env.LOCAL_MEDIA_IMPORT = "true";
  const app = express(); registerLocalSuno(app); registerLocalVideo(app);
  if (previous === undefined) delete process.env.LOCAL_MEDIA_IMPORT; else process.env.LOCAL_MEDIA_IMPORT = previous;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  let id = "";
  const samples = Buffer.alloc(48017 * (floating ? 8 : 4));
  for (let i = 0; i < 48017; i++) {
    if (floating) {
      samples.writeFloatLE(Math.sin(i * 0.4321) * .33333334, i * 8);
      samples.writeFloatLE(Math.cos(i * 0.1234) * .12345678, i * 8 + 4);
    } else {
      samples.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 701 / 48000) * 27000), i * 4);
      samples.writeInt16LE((i * 7919 % 65536) - 32768, i * 4 + 2);
    }
  }
  const decode = (data: Buffer) => ff(["-i", "pipe:0", "-map", "0:a:0", "-c:a", floating ? "pcm_f32le" : "pcm_s16le", "-f", floating ? "f32le" : "s16le", "pipe:1"], data);
  const source = ff(["-f", floating ? "f32le" : "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-f", "lavfi", "-i", "color=size=320x320:rate=30",
    "-map", "1:v:0", "-map", "0:a:0", "-t", String(48017 / 48000), "-c:v", "libx264", "-c:a", floating ? "pcm_f32le" : "flac", "-f", "matroska", "pipe:1"], samples);
  const request = (url: string, init: RequestInit = {}) => fetch(base + "/api/local/video" + url,
    { ...init, headers: { "X-Local-Export": "video", ...init.headers } });
  try {
    const imported = await fetch(base + "/api/local/suno?audioOnly=1", { method: "POST", headers: {
      "Content-Type": "application/octet-stream", "X-Local-Import": "suno",
    }, body: source });
    const payload = await imported.json(); assert.equal(imported.status, 200, JSON.stringify(payload));
    assert.equal(payload.extension, floating ? "wav" : "flac"); assert.equal(payload.mimeType, floating ? "audio/wav" : "audio/flac");
    const audio = Buffer.from(payload.audioBase64, "base64"); assert.deepEqual(decode(audio), samples);
    const created = await request("/jobs", { method: "POST", headers: { "Content-Type": "application/octet-stream",
      "X-Export-Config": JSON.stringify({ width: 320, height: 320, fps: 30, duration: 1, mode: "publish", audio: "preserve" }) }, body: audio });
    const job = await created.json(); assert.equal(created.status, 200, JSON.stringify(job)); id = job.id;
    assert.equal(job.extension, "mkv");
    const frames = Buffer.alloc(320 * 320 * 4 * 3, 127);
    for (let n = 0; n < 30; n += 3) assert.equal((await request(`/jobs/${id}/frames?start=${n}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: frames,
    })).status, 200);
    assert.equal((await request(`/jobs/${id}/finish`, { method: "POST" })).status, 200);
    let ready = false;
    for (let n = 0; n < 100; n++) {
      const state = await (await request(`/jobs/${id}`)).json();
      assert.notEqual(state.state, "error", state.error);
      if (state.state === "ready") { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready);
    const output = Buffer.from(await (await request(`/jobs/${id}/file`)).arrayBuffer());
    assert.deepEqual(decode(output), samples);
  } finally {
    if (id) await request(`/jobs/${id}`, { method: "DELETE" });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
