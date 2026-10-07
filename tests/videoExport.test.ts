import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { OfflineSpectrum } from "../src/lib/video/OfflineSpectrum";
import { registerLocalVideo, validateVideoConfig } from "../server/localVideo";

function wav() {
  const samples = 44100, data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(44100, 24); data.writeUInt32LE(88200, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 44100) * 12000), 44 + i * 2);
  return data;
}

test("offline spectrum follows audio content and media time", () => {
  const channel = Float32Array.from({ length: 44100 }, (_, i) => i < 22050 ? 0 : .4 * Math.sin(i * 2 * Math.PI * (44100 * 10 / 1024) / 44100));
  const spectrum = new OfflineSpectrum([channel], 44100);
  spectrum.at(.2);
  assert.ok(spectrum.frequency.every(value => value === 0));
  assert.ok(spectrum.waveform.every(value => value === 128));
  spectrum.at(.6);
  assert.equal(spectrum.frequency.indexOf(Math.max(...spectrum.frequency)), 10);
  assert.ok(spectrum.waveform.some(value => value > 170));
  const second = new OfflineSpectrum([channel], 44100);
  second.at(.2); second.at(.6);
  assert.deepEqual(second.frequency, spectrum.frequency);
});

test("video config bounds dimensions, duration and format", () => {
  const valid = { width: 720, height: 1280, fps: 30, duration: 198.016, mode: "publish" };
  assert.deepEqual(validateVideoConfig(valid), valid);
  for (const invalid of [{ width: 721 }, { height: 4096 }, { duration: Infinity }, { duration: 1201 }, { fps: 1000 }, { mode: "../output" }]) {
    assert.throws(() => validateVideoConfig({ ...valid, ...invalid }));
  }
});

test("production never registers video export", async () => {
  const environment = process.env.NODE_ENV, enabled = process.env.LOCAL_MEDIA_IMPORT;
  process.env.NODE_ENV = "production"; process.env.LOCAL_MEDIA_IMPORT = "true";
  const app = express(); registerLocalVideo(app);
  if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
  if (enabled === undefined) delete process.env.LOCAL_MEDIA_IMPORT; else process.env.LOCAL_MEDIA_IMPORT = enabled;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/local/video/capabilities`)).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("local export encodes MP4 and pixel/audio-exact lossless video, rejects incomplete frames, and cancels", { timeout: 60_000 }, async () => {
  const previous = process.env.LOCAL_MEDIA_IMPORT;
  process.env.LOCAL_MEDIA_IMPORT = "true";
  const app = express(); registerLocalVideo(app);
  if (previous === undefined) delete process.env.LOCAL_MEDIA_IMPORT; else process.env.LOCAL_MEDIA_IMPORT = previous;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/local/video`;
  const ids: string[] = [];
  const request = (url: string, init: RequestInit = {}) => fetch(base + url, { ...init, headers: { "X-Local-Export": "video", ...init.headers } });
  const audio = wav();
  const rgba = Buffer.alloc(320 * 320 * 4), rgb = Buffer.alloc(320 * 320 * 3);
  for (let i = 0; i < 320 * 320; i++) {
    rgba[i * 4] = rgb[i * 3] = i % 256;
    rgba[i * 4 + 1] = rgb[i * 3 + 1] = Math.floor(i / 320) % 256;
    rgba[i * 4 + 2] = rgb[i * 3 + 2] = 193; rgba[i * 4 + 3] = 255;
  }
  try {
    assert.equal((await request("/capabilities", { headers: { Origin: "https://example.com" } })).status, 403);
    assert.equal((await fetch(base + "/jobs", { method: "POST" })).status, 400);
    for (const mode of ["lossless", "publish"] as const) {
      const created = await request("/jobs", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Export-Config": JSON.stringify({ width: 320, height: 320, duration: 1, fps: 30, mode }) }, body: audio });
      assert.equal(created.status, 200, await created.clone().text());
      const { id } = await created.json(); ids.push(id);
      assert.equal((await request(`/jobs/${id}/finish`, { method: "POST" })).status, 409);
      assert.equal((await request(`/jobs/${id}/frames?start=1`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: rgba })).status, 409);
      for (let frame = 0; frame < 30; frame += 3) {
        const response = await request(`/jobs/${id}/frames?start=${frame}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.concat([rgba, rgba, rgba]) });
        assert.equal(response.status, 200, await response.text());
      }
      assert.equal((await request(`/jobs/${id}/finish`, { method: "POST" })).status, 200);
      let state = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        const status = await (await request(`/jobs/${id}`)).json();
        assert.notEqual(status.state, "error", status.error); state = status.state;
        if (state === "ready") break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(state, "ready");
      const video = Buffer.from(await (await request(`/jobs/${id}/file`)).arrayBuffer());
      assert.ok(video.length > 1000);
      const decode = (args: string[]) => {
        const result = spawnSync(ffmpeg!, ["-v", "error", "-i", "pipe:0", ...args, "pipe:1"], { input: video, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        assert.equal(result.status, 0, result.stderr.toString()); return result.stdout;
      };
      const pixels = decode(["-an", "-f", "rawvideo", "-pix_fmt", "rgb24"]);
      assert.equal(pixels.length, rgb.length * 30);
      const samples = decode(["-vn", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "44100"]);
      assert.ok(samples.length >= 44100 * 2);
      if (mode === "lossless") {
        assert.deepEqual(pixels, Buffer.concat(Array(30).fill(rgb)));
        assert.deepEqual(samples, audio.subarray(44));
      }
      await request(`/jobs/${id}`, { method: "DELETE" });
      assert.equal((await request(`/jobs/${id}`)).status, 404);
    }
    const pending = await request("/jobs", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Export-Config": JSON.stringify({ width: 320, height: 320, fps: 30, duration: 1, mode: "publish" }) }, body: audio });
    const { id } = await pending.json(); ids.push(id);
    assert.equal((await request(`/jobs/${id}`, { method: "DELETE" })).status, 204);
    assert.equal((await (await request("/capabilities")).json()).busy, false);
  } finally {
    for (const id of ids) await request(`/jobs/${id}`, { method: "DELETE" });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
