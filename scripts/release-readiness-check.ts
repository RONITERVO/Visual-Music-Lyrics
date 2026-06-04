/* SPDX-FileCopyrightText: 2026 Roni Tervo
 * SPDX-License-Identifier: Apache-2.0 */

import { existsSync, readFileSync } from "node:fs";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path: string) {
  return readFileSync(path, "utf8");
}

function assert(condition: any, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hasRewriteToFunction(firebaseJson: any, source: string) {
  return firebaseJson.hosting?.rewrites?.some((rewrite: any) => (
    rewrite.source === source &&
    rewrite.function?.functionId === "api" &&
    rewrite.function?.region === "europe-west1"
  ));
}

function hasRewriteToRun(firebaseJson: any, source: string) {
  return firebaseJson.hosting?.rewrites?.some((rewrite: any) => (
    rewrite.source === source &&
    rewrite.run?.serviceId === "visual-music-media" &&
    rewrite.run?.region === "europe-west1" &&
    rewrite.run?.pinTag === true
  ));
}

function assertNoMatch(paths: string[], pattern: RegExp, label: string) {
  for (const path of paths) {
    const text = readText(path);
    assert(!pattern.test(text), `${label} found in ${path}`);
  }
}

const packageJson = readJson("package.json");
const functionsPackageJson = readJson("functions/package.json");
const firebaseJson = readJson("firebase.json");
const envExample = readText(".env.example");
const apiSource = readText("src/lib/api.ts");
const liveScribeSource = readText("src/lib/liveScribe.ts");
const serverSource = readText("server.ts");
const functionsSource = readText("functions/src/index.ts");
const firestoreRules = readText("firestore.rules");
const cloudBuildMedia = readText("cloudbuild.media.yaml");

assert(!existsSync("render.yaml"), "render.yaml must not be part of the production release");
assert(!existsSync(".github/workflows/deploy-pages.yml"), "GitHub Pages workflow must not be part of the production release");
assert(existsSync("cloudbuild.media.yaml"), "Cloud Run media deployment must have a Cloud Build config");

assert(packageJson.scripts?.build === "npm run build:app && npm run build:server && npm run build:functions", "root build must build app, media server, and functions");
assert(packageJson.scripts?.["check:release"], "package.json must expose check:release");
assert(packageJson.dependencies?.firebase, "root app must depend on Firebase Web SDK");
assert(packageJson.dependencies?.["firebase-admin"], "Cloud Run media service must depend on Firebase Admin SDK");
assert(!packageJson.dependencies?.stripe, "Stripe must live in the Functions package, not the Cloud Run/root runtime");
assert(!packageJson.dependencies?.["firebase-functions"], "firebase-functions must live in the Functions package, not the Cloud Run/root runtime");

assert(functionsPackageJson.dependencies?.stripe, "Functions package must depend on Stripe");
assert(functionsPackageJson.dependencies?.["firebase-functions"], "Functions package must depend on firebase-functions");
assert(existsSync("functions/package-lock.json"), "Functions package must have its own lockfile");

assert(hasRewriteToRun(firebaseJson, "/api/health"), "media health must rewrite to Cloud Run");
assert(hasRewriteToRun(firebaseJson, "/api/youtube/**"), "YouTube routes must rewrite to Cloud Run");
assert(!hasRewriteToRun(firebaseJson, "/api/elevenlabs/**"), "live Scribe WebSocket must not depend on Firebase Hosting rewrites");
assert(hasRewriteToFunction(firebaseJson, "/api/translate/**"), "Gemini route must rewrite to Cloud Functions");
assert(hasRewriteToFunction(firebaseJson, "/api/billing/**"), "billing routes must rewrite to Cloud Functions");
assert(hasRewriteToFunction(firebaseJson, "/api/webhooks/**"), "webhook routes must rewrite to Cloud Functions");
assert(hasRewriteToFunction(firebaseJson, "/api/entitlements/**"), "entitlement routes must rewrite to Cloud Functions");

assert(/VITE_FIREBASE_API_KEY=/.test(envExample), ".env.example must include Firebase web config");
assert(/VITE_MEDIA_WS_BASE_URL=/.test(envExample), ".env.example must include direct Cloud Run WebSocket origin");
assert(/STRIPE_SECRET_KEY=/.test(envExample), ".env.example must include Stripe secret config");
assert(/ELEVENLABS_PRICE_CENTS_PER_HOUR=100/.test(envExample), ".env.example must encode 1 EUR per hour default");
assert(/FIREBASE_AUTH_REQUIRED=true/.test(envExample), ".env.example must require Firebase auth on Cloud Run");

assert(/VITE_MEDIA_WS_BASE_URL/.test(apiSource), "API helper must support direct media WebSocket origin");
assert(/Set VITE_MEDIA_WS_BASE_URL/.test(apiSource), "production Scribe WebSockets must fail closed when media origin is missing");
assert(!/apiKey\?:/.test(liveScribeSource), "browser Scribe client must not accept provider API keys");
assert(!/apiKey: options\.apiKey/.test(liveScribeSource), "browser Scribe client must not send provider API keys");
assert(!/body\.apiKey/.test(serverSource), "media service must not accept browser provider API keys");
assert(/reserveElevenLabsSeconds/.test(serverSource), "media service must reserve paid Scribe seconds");
assert(/settleElevenLabsSeconds/.test(serverSource), "media service must settle paid Scribe seconds");
assert(/function mediaLog/.test(serverSource), "media service must use structured Cloud Run logs");
assert(/media\.http_request/.test(serverSource), "media service must log request status and duration");
assert(/youtube\.job_completed/.test(serverSource), "media service must log completed yt-dlp jobs");
assert(/youtube\.job_failed/.test(serverSource), "media service must log failed yt-dlp jobs");
assert(/scribe\.seconds_reserved/.test(serverSource), "media service must log Scribe second reservations");
assert(/scribe\.seconds_settled/.test(serverSource), "media service must log Scribe second settlements");
assert(/scribe\.session_error/.test(serverSource), "media service must log Scribe session failures");
assert(/function controlLog/.test(functionsSource), "Functions control plane must use structured Firebase logs");
assert(/gemini\.translation_completed/.test(functionsSource), "Functions must log Gemini translation completions");
assert(/billing\.checkout_session_created/.test(functionsSource), "Functions must log checkout creation");
assert(/billing\.webhook_received/.test(functionsSource), "Functions must log Stripe webhook receipt");
assert(/billing\.seconds_granted/.test(functionsSource), "Functions must log ElevenLabs second grants");

assert(/allow write: if false/.test(firestoreRules), "Firestore client writes must be denied for server-owned state");
assert(/--memory\s+[\s\S]*2Gi/.test(cloudBuildMedia), "Cloud Run media service must reserve 2Gi memory");
assert(/--cpu\s+[\s\S]*"2"/.test(cloudBuildMedia), "Cloud Run media service must reserve 2 CPU");
assert(/--concurrency\s+[\s\S]*"4"/.test(cloudBuildMedia), "Cloud Run media service must use bounded concurrency");
assert(/--timeout\s+[\s\S]*"3600"/.test(cloudBuildMedia), "Cloud Run media service must allow long Scribe WebSockets");
assert(/YOUTUBE_MAX_CONCURRENT_JOBS=1/.test(cloudBuildMedia), "Cloud Run media service must keep yt-dlp concurrency capped");

assertNoMatch([
  "README.md",
  "docs/production-architecture.md",
  "src/lib/api.ts",
], /Render free|build:pages|getPagesBackendMessage|Deploy GitHub Pages/i, "legacy deployment reference");

console.log("release readiness check ok");
