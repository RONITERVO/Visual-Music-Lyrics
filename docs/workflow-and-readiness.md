# Workflow, feature ownership and readiness

Audited 2026-10-10 against merged [PR #8](https://github.com/RONITERVO/Visual-Music-Lyrics/pull/8), main commit `d822a3a`, and this follow-up. No deployment or paid provider call was made during this audit. This is the current guide; [the October 2 audit](visualizer-import-audit.md) is historical.

## What exists and where it runs

“Local” below means `npm run dev:local` on the same desktop, bound to loopback. This mode bypasses cloud sign-in in development and does not automatically send songs to transcription. Normal hosted operation has separate Firebase/provider requirements. Running an API server on your PC does not make requests to ElevenLabs or Google offline.

| Capability | Where it runs / data sent | Origin and current status |
| --- | --- | --- |
| Audio library, player JSON/LRC/SRT/VTT, seeking, browser persistence and library transfer | Browser, local or hosted; imported files in browser storage | Existing before #8. Preserve backups using Export library; browser storage is not a durable backup. |
| Living Sketchbook and Signal Bloom listening visuals | Browser, local or hosted | Themes existed before #8; #8 restored source visual behavior, bilingual word clocks, handwriting, reflections and responsive layouts. |
| Firebase sign-in and hosted service entitlements | Firebase/cloud | Existing before #8; not live-tested in this audit. Local development bypass is excluded from production. |
| YouTube import / captions | Hosted media service and YouTube | Existing before #8; live external availability not revalidated. |
| ElevenLabs transcription | Existing `/api/elevenlabs/scribe`; sends the song to ElevenLabs Scribe v2 using server credentials and entitlement checks | Existing before #8. This audit has not verified the provider account, balance, permissions or a paid request. Not automatically called in `dev:local`. |
| Gemini translation | Existing authenticated translation API; text sent to Google | Existing before #8. Default configured model is `gemini-flash-lite-latest`; this is not an integrated Gemini 3.1 Pro video-transcription or correction pipeline. Not live-tested here. |
| Gemini video analysis and word JSON | You attach the video to Gemini outside the app | Manual workflow introduced in #8. The chosen Google product/account handles usage and billing. |
| Gemini prompt, JSON conversion, phrase guide, independent sung-language timings | Entirely in the browser, local or hosted; conversion sends no provider request | Added in #8. Original timestamps are preserved; validation does not establish vocal accuracy. |
| Suno video + JSON pairing and audio extraction | Desktop local server using bundled FFmpeg; no cloud upload | Added in #8. This follow-up preserves source codecs/sample data and makes video-alone import audio-only. No Python/OCR/Whisper prerequisite. |
| Visualizer video export, cancel, download, both themes and three shapes | Desktop local FFmpeg + browser canvas; local API disabled in production | Added in #8. This follow-up fixes English-only export placement, separates audio quality from video quality, and disables development auto-reload by default in the dedicated local launcher. |
| Stream-preserving audio import/export, PCM/FLAC masters | Desktop local | Added in this follow-up. Preserve is default; publishing AAC conversion is explicit. |
| Stripe top-ups, payment webhooks and Scribe balances | Hosted Stripe/Firebase | Billing existed before #8. #8 paused new purchases by default and added status UI; existing balances and webhook handling remain. Live payment/entitlement flows are not certified here. |
| Android recording overlay, delayed start/automatic stop, PCM/FLAC capture, phone playback/export, PC job queue | Separate NoFocus Android app and paired PC companion | Work from the same broader project, in [NoFocus PR #4](https://github.com/RONITERVO/NoFocus-Player/pull/4), not this repository. |
| Persistent queue, pause/retry, hardware WebCodecs path and phone-to-PC handoff | NoFocus PC companion | Implemented there, not ported into this desktop exporter. Do not attribute its benchmark or queue controls to this app. |
| Automatic ElevenLabs → Gemini wording review → reviewed alignment pipeline | Not implemented | Recommended future direction, using the existing two providers. Current Gemini JSON workflow is manual. |

Legacy `scripts/visual_lyrics_extractor.py` remains optional historical tooling. The app no longer invokes it, and normal setup requires neither Whisper nor its Python dependencies. No new transcription provider is needed.

## Audio quality contract

1. Capture a NoFocus MKV master and the same-timeline MP4 reference. Send the MP4 reference to Gemini; keep the original master for import. An original Suno audio download is preferable when available, but replacing the capture audio requires matching its timeline before reusing timings.
2. Import the master with reviewed JSON. The first audio stream is used. AAC, MP3, FLAC, Opus and Vorbis are copied; supported native PCM is kept in WAV, ALAC is decoded into lossless integer PCM, and other decodable formats use floating-point PCM. Sample rate and channels are not intentionally reduced. Browser codec support still determines playback/visual analysis compatibility.
3. Choose **Preserve source audio** at export. AAC + H.264 uses MP4; other preserved audio uses MKV. Lossless RGB video also uses MKV. Source audio is muxed separately from the resampled audio used to calculate visual motion.
4. **AAC 320 kbps** copies existing AAC rather than encoding it again. Other codecs receive one lossy conversion. Increasing the bitrate cannot restore missing source detail. Keep a master even when a publishing service needs MP4.

The verified guarantee is no additional loss for the tested AAC/PCM/FLAC paths. It is not a claim of bit identity to Suno's original studio master: Suno's stream, Android mixing/capture policy, and the original recording may already introduce changes. Extraction keeps source audio, not the full source video. Capture offset and caption accuracy still require listening review.

Local limits: 768 MB video import, one extraction at a time; 256 MB audio / 20 minutes per export; one active export; up to two retained outputs with ten-minute inactivity expiry. Keep the tab open and download promptly. These are not durable queued jobs. UI export is 720p/1080p at 30 fps; lowering video resolution never lowers preserved audio quality.

## Timing workflow and observed failure cases

The recommended division of work is **ElevenLabs for an initial timing anchor, Gemini for contextual wording review, then listening review**. The user has obtained excellent ElevenLabs timing on tested songs while seeing misheard words, including common words interpreted as names. Gemini has helped recover the intended wording but can misplace its timing. Neither provider is guaranteed correct for all music.

The user's Gemini tests found particularly unreliable timings with:

- strongly robotic or processed vocals;
- instrumental-only sections longer than roughly eight seconds;
- songs starting to exceed roughly three minutes;
- prompts/runs around a 20k total token budget.

These are observed review triggers, not documented model limits, universal failure thresholds or an exhaustive list. The output can appear to follow the visible lyric cards instead of vocal onsets; this does not establish the model's internal attention behavior. Similarly, there is no evidence here that Scribe sees only past context: the app submits the full audio in a batch request. Giving Gemini full lyrics provides useful context but does not guarantee every word will be right.

For the current manual workflow:

1. Keep the raw ElevenLabs response and original Gemini response alongside the audio. Use the original recording's time origin; do not trim silence without recording the offset.
2. Give Gemini the reference lyrics and reviewed transcription to check spelling, names, language and repeated phrases. For a one-to-one wording correction, preserve the existing start/end times. The current import accepts final timing JSON; it does not automatically merge provider responses.
3. For insertions, deletions, split/merged words or uncertain timing, review that passage against the audio. Do not redistribute timestamps evenly or adopt a caption appearance time as a sung-word onset.
4. Check first/last vocals, re-entry after instrumental breaks, repeated choruses, whispers and overlaps. Seek around the suspect passage and compare listening with the visible word reveal. Structural JSON validation and duration bounds cannot detect semantically wrong timing.
5. Keep the master audio and approved timing revision when transferring the library to NoFocus or another device.

[ElevenLabs Scribe documentation](https://elevenlabs.io/docs/overview/capabilities/speech-to-text) describes word timestamps and optional keyterm guidance; neither is a music-accuracy guarantee. [ElevenLabs forced alignment](https://elevenlabs.io/docs/overview/capabilities/forced-alignment) could align a corrected transcript in a future workflow. That endpoint is not integrated or verified for this account: an earlier experiment received `401 missing_permissions`. It must not silently become a required or billed fallback.

## Cost and longer-term priorities

1. **Review and provenance first.** Add an editable waveform timeline, stable word IDs, separate wording/timing confidence, source media hash/duration/offset, and reversible transcript revisions. Flag questionable spans; never shift an entire song to conceal a gap or renderer bug.
2. **Build on the two existing providers.** Retain Scribe's reviewed timing as the anchor and ask Gemini for wording patches. Escalate only insertions/deletions and disputed spans to alignment/manual review. Preserve absolute offsets and overlap context if processing sections. Do not add Whisper as a setup burden.
3. **Bound cost before automating calls.** Estimate usage, require an explicit per-job budget, cache by media/model/prompt revision, record actual usage, and avoid resending an entire video or regenerating a full JSON document for a small correction. Benchmark a cheaper Gemini model on reviewed songs before routing easy cases to it; keep Pro for cases where it measurably helps.
4. **Share the renderer and job protocol.** Version the common NoFocus/desktop renderer and test the same timing fixtures in both. Consider reusing the companion's bounded queue and hardware path here after visual/audio parity and recovery tests. Faster encoding alone does not solve browser canvas readback and frame transfer cost.
5. **Then harden hosted production.** Verify auth, transcription permissions, credits, translation, payment webhooks, YouTube availability and physical mobile browser playback in staging before enabling purchases/deploying. Track remaining dependency advisories separately from local export correctness.

At the time of this audit, [Google's Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) lists Gemini 3.1 Pro Preview Standard at $2/M input tokens and $12/M output tokens (including thinking) for prompts up to 200k tokens, with higher rates above that. A 20k-input + 5k-billed-output example is $0.10, not a quote for a particular song; video/audio and repeated attempts affect actual usage. External Gemini chat subscriptions have different billing. [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) depends on plan and options; the app's prepaid retail price is not the provider's wholesale cost. Store provider usage and measured quality rather than assuming one service is always cheaper.

## Validation and release scope

Checks completed on Windows with Node 25.4.0 and installed Edge. Cloud Functions targets Node 22; compilation passed, with the expected local Node-version warning. A deployed Node 22 smoke test remains part of staging validation:

| Check | Result and coverage |
| --- | --- |
| `npm run lint` | Pass: TypeScript across app/server/tests. |
| `npm test` | 29 passed: timing conversion/pairing, waveform response, origin/production guards, billing-pause routes, real FFmpeg import/export, cancellation/sequence validation and exact audio/video checks. |
| `npm run test:browser` | 19 passed: both themes at five viewport sizes, lyric clocks/seek/persistence, waterline and ink regressions including English-only export, Gemini conversion, video-alone audio import without paid calls, supplied timing import, purchase-status UI, MP4 download/cancel and 1080p lossless MKV. Provider responses in browser billing/import tests are mocked; real FFmpeg APIs have separate Node coverage. |
| `npm run check:release` | Pass: deployment exclusions, development-only routes and operational hooks. |
| `npm run build` | Pass: Vite app, media server bundle and Cloud Functions compilation. |
| Audio preservation | Real 48 kHz stereo FLAC/float-PCM capture → import → compressed-video export retains all 48,017 test samples, including the tail beyond the frame-duration boundary. AAC import retains encoded packet bytes. Lossless export retains decoded RGB pixels and PCM samples. |

Passing these checks verifies the covered local behavior and regressions from #8, not all provider features or a production deployment.

### Dependency audit

Compatible lockfile updates remediate the newly reported `proxy-addr`, `@fastify/busboy` and `source-map-js` advisories. No major framework/provider migration is hidden in this PR.

| `npm audit` on 2026-10-10 | Before | After |
| --- | --- | --- |
| Root | 1 critical, 6 high, 8 moderate | 0 critical, 4 high, 8 moderate |
| Cloud Functions | 1 critical, 1 high, 9 moderate | 0 critical, 0 high, 9 moderate |

The four remaining high entries are the same `@grpc/grpc-js` finding propagated through Firebase/Firestore packages, not four separate confirmed exploit paths. The Firebase client package pins the older gRPC minor line; the Admin dependency has a newer gRPC version. Moderate entries trace through the Google/Firebase Admin dependency graph (including `uuid`). These pre-existing findings remain open for a dependency compatibility and reachability review; this audit does not establish exploitability or declare them harmless. Do not use `npm audit fix --force` to downgrade Firebase or perform an untested Admin major migration. Live service validation and dependency review remain release gates.

### Full-song measurement

The existing 198.016-second Amor Digital fixture exported at 720×1280 / 30 fps, Living Sketchbook, H.264 CRF 17 and preserved AAC in **88 seconds (2.2× playback speed)** on this PC. The MP4 downloaded successfully, and its complete AAC packet stream matched the input byte-for-byte. This is not the separate NoFocus hardware/60-fps benchmark, and does not predict 1080p, other themes or other machines.

An initial run was interrupted: its export dialog disappeared and its encoder waited for more frames. Direct FFmpeg encoding with the same audio passed. The successful isolated run used development hot reload disabled; `dev:local` now defaults to that setting to prevent file edits from replacing an in-progress export page. Normal `npm run dev` retains hot reload. Closing/reloading the page still interrupts export; durable recovery belongs to future queue work.

The canvas scene engines and lyric clock are shared with listening playback, but canvas-exported text is not a pixel-identical screenshot of browser CSS. The local exporter remains a CPU FFmpeg/frame-batch path. A measured full-song benchmark is useful for readiness, not proof that every machine/theme/resolution is optimal.

No live paid Scribe/Gemini calls, Firebase login, Stripe payment, production deployment or physical mobile-browser check was performed in this audit. Existing NoFocus native-phone testing does not substitute for hosted Android Chrome/iOS Safari testing.

### Post-merge import review (2026-10-10)

The follow-up to #9 streams extracted audio as a binary response instead of base64 JSON, holding the temporary file and import reservation until transfer finishes or is canceled. The browser receives a Blob. A real 20-minute 48 kHz stereo ALAC fixture expands to more than 460 MB of WAV and imports successfully without a whole-file server Buffer or base64 string. Mixed batches explicitly report both videos with supplied lyrics and videos without timings.

Validation: 30 Node tests, 20 Edge browser tests, TypeScript checks, app and media-server builds passed. The Cloud Functions code is unchanged. No provider calls or deployment were performed.
