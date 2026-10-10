# Visualizer and Suno import review — 2026-10-02

> Historical audit: its test counts, dependency advisories and OCR/Whisper workflow describe the October 2 state. See [the October 10 follow-up](workflow-and-readiness.md) for current behavior and validation.

**Release decision: local preview is available; production readiness is not established.** No deployment was performed.

## Fidelity to Kestrel

Compared against the local Kestrel checkout at `D:\Projects\Local-LLM-only-best-harnesses\kestrel-local\apps\desktop\src\features\studio\music`.

| Area | Evidence |
| --- | --- |
| Living Sketchbook canvas engine | Kestrel reactivity/events retained. The horizon clamp is shared with the DOM reflection layout; opaque paper masks keep the sun behind terrain and water. |
| Signal Bloom canvas engine | Exact source match, including trails, sparks, pulses and audio-driven focus. |
| Audio-reactivity core | Same Kestrel algorithm; additions only measure this app's lyric elements. FFT 1024, smoothing 0.68, -92/-12 dB limits match. |
| Integration before fixes | Imported `word`/`text` fields did not match the renderer's `value`; English was static; playback used sparse `timeupdate`; Signal Bloom inherited multiply compositing; cue exit was unreachable. |
| Integration after fixes | Normalized word contracts, independent sung-English timeline, 30 Hz media-clock updates, theme-specific compositing, English active-word focus, functioning cue exit. Signal Bloom keeps Kestrel's serif reading face; Living Sketchbook restores main-branch Caveat handwriting, graphite words, pencil reveal/erase and the blue water-reflection translation. Sketchbook uses multiply blending for its original warm paper colors; Signal Bloom uses normal blending. |
| Phone adaptation | Smaller type, wrapping, narrower notebook margin, separated header controls, independently timed sung-English row, file picker. Composition naturally differs from Kestrel's desktop aspect ratio. |

Signal Bloom's rendering module is an exact copy. Sketchbook shares its horizon calculation with the reflection layout and restores opaque terrain/water occlusion before applying the watercolor washes. This is not a percentage estimate of the entire user experience. No physical Android/iPhone GPU or audio-route comparison was performed.

Caveat and Patrick Hand are bundled locally with their SIL Open Font licenses, so the original handwriting does not depend on Google Fonts being reachable.

## Verified

- TypeScript, frontend build, media-server bundle, and Cloud Functions compilation.
- Five Node regressions covering word imports, bilingual timing, malformed timing, audio transients/silence, English visual focus, and local import isolation (some checks share a test).
- Five Edge browser scenarios: 320×568, 390×844, 430×932, 844×390, 1280×720. Both themes, Spanish then English, seek boundaries, live AudioContext and energy decay to silence, IndexedDB restore.
- Two reflection regressions (normal and reduced motion) compare text position against the actual canvas water fill across short, wrapped and English-only cues, viewport changes, and word seeking. The moving horizon is preserved; the reflection is anchored and clipped to its water region.
- A browser pixel comparison at 390×844 and 844×390 with maximum bass/transient/beat input confirmed zero sun leakage through terrain or water. The sun stays visible in the sky and its separately drawn water reflection remains.
- Three Python regressions: wrapped sentence assembly, conservative audio-assisted word repair, non-overlapping uncertain word timing.
- Real local HTTP import of `Amor Digital.mp4`: successful response, 198.016-second AAC-only M4A, approximately 4.94 MB; 56 lyric groups and 308 word entries. The audio plus timing files were loaded into the player and displayed at 390×844. No video stream is stored in the generated M4A.
- Original MP4 is preserved. Request upload copies are temporary and removed after processing. Local import rejects remote peers, foreign origins and non-loopback Host headers; it is unavailable in production.

## Remaining blockers and limits

1. **Timing/text quality:** 47 of the sample's 56 groups were flagged for review. These flags include OCR confidence and forced-alignment uncertainty; they are not a measured error rate. Some source-video Spanish fragments are missing; some recognizer words disagree with captions. The output is a reviewable draft, not publication-approved karaoke. Review original text, missing words, instrumental entrances and low-confidence word spans against the audio. `estimated` explicitly marks timing repairs.
2. **Dependencies:** compatible audit fixes removed the critical advisory and many other findings. Remaining root dependency advisories include four high-severity and eight moderate entries in Firebase/gRPC and Firebase Admin dependency trees; Functions has nine moderate entries. The package manager proposes breaking Firebase/Admin changes. Those migrations and associated integration tests were not applied blindly.
3. **Hosted services:** Google auth, Stripe/Google Pay, entitlement reservation/settlement, webhook delivery, Scribe, translation and YouTube extraction still need live staging verification. Compilation does not prove these services are configured or functioning.
4. **Devices:** verify iOS Safari and Android Chrome on physical phones, headphones/Bluetooth, foreground/background transitions and portrait/landscape changes before promising desktop-equivalent performance. Automated layout checks used desktop Edge viewports; builds ran on local Node 25, not the Node 22 production container.

Firebase Hosting now excludes `dist/server.cjs` and source maps. The development auth-disable flag is ignored in production builds. Local OCR/model caches and imported song artifacts are excluded from Git and container uploads.

## Local artifacts

Generated sample audio, timing JSON, browser screenshots and diagnostic outputs are in `.artifacts/amor-import/` and `.artifacts/`. They are intentionally untracked. Start `npm run dev:local`, then use **Add songs** for an MP4 import, or select the matching `Amor Digital.m4a` and `Amor Digital.json` pair for immediate playback. Importing a video may take several minutes.
