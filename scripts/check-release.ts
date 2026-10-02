import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const hosting = JSON.parse(readFileSync("firebase.json", "utf8")).hosting;
assert.ok(hosting.ignore.includes("**/*.cjs") && hosting.ignore.includes("**/*.map"), "Hosting must exclude server bundles and source maps.");
const media = readFileSync("server.ts", "utf8");
const local = readFileSync("server/localSuno.ts", "utf8");
assert.ok(local.includes('process.env.NODE_ENV === "production"'), "Local extraction must stay disabled in production.");
for (const event of ["media.server_started", "media.auth_failed", "youtube.download_stream_error", "scribe.batch_error", "gemini.translation_error"]) {
  assert.ok(media.includes(event), `Missing operational event ${event}`);
}
assert.ok(!hosting.rewrites.some((route: { source: string }) => route.source.startsWith("/api/local")), "Local extraction must not have a hosted backend rewrite.");
console.log("Release configuration checks passed. Live auth, billing, media APIs and real-device playback still require staging verification.");
