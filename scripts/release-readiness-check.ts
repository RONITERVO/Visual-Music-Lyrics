/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import fs from "fs";
import path from "path";

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertReady(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNotContains(relativePath: string, patterns: RegExp[]) {
  const text = read(relativePath);
  for (const pattern of patterns) {
    assertReady(!pattern.test(text), `${relativePath} still matches ${pattern}`);
  }
}

const server = read("server.ts");
assertReady(server.includes('app.post("/api/elevenlabs/scribe"'), "Missing batch Scribe HTTP route.");
assertReady(server.includes('const ELEVENLABS_SCRIBE_MODEL = "scribe_v2"'), "Scribe must use batch scribe_v2.");
assertReady(server.includes('form.append("tag_audio_events", "true")'), "Scribe audio-event tagging must stay enabled.");
assertReady(server.includes('form.append("timestamps_granularity", "character")'), "Scribe character timestamps must stay enabled.");
assertReady(server.includes("resolveLrclibKeytermsForScribe"), "LRCLIB keyterm lookup must stay in the Scribe path.");
assertReady(server.includes("reserveElevenLabsSeconds"), "Scribe reservation accounting is missing.");
assertReady(server.includes("settleElevenLabsSeconds"), "Scribe settlement accounting is missing.");

const removedRealtimePatterns = [
  /scribe_v2_realtime/,
  /elevenlabs-scribe-v2-realtime/,
  /\/api\/elevenlabs\/scribe-live/,
  /VITE_MEDIA_WS_BASE_URL/,
  /buildWebSocketUrl/,
];

for (const file of [
  "server.ts",
  "src/lib/api.ts",
  "src/components/PlayerView.tsx",
  "src/lib/timing.ts",
  ".env.example",
  "README.md",
  "docs/production-architecture.md",
]) {
  assertNotContains(file, removedRealtimePatterns);
}

console.log("Release readiness checks passed.");
