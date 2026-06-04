# Production Architecture

## Verdict

The target architecture is not stupid. It is the right direction for a production MVP, with one required correction: Google Pay is only a wallet/token flow on the web, not the merchant-of-record or payment processor. Use Stripe or another payment service provider, then enable Google Pay through that provider.

## Release Shape

Firebase Hosting is the only web hosting target for the static app. HTTP APIs use same-origin `/api/*` rewrites, so there is no GitHub Pages backend URL split in production.

Live Scribe WebSockets connect directly to the Cloud Run media origin through `VITE_MEDIA_WS_BASE_URL`. Cloud Run supports WebSockets directly, while Firebase Hosting dynamic rewrites are HTTP request proxies with a request timeout, so long-lived Scribe streams should not depend on Hosting rewrites.

Cloud Functions owns short, auth-bound control-plane routes:

- `GET /api/control/health`
- `GET /api/entitlements/me`
- `POST /api/translate/gemini`
- `POST /api/billing/elevenlabs/payment-intent`
- `POST /api/billing/elevenlabs/checkout-session`
- `POST /api/webhooks/stripe`

Cloud Run owns media/data-plane routes:

- `GET /api/health`
- `POST /api/youtube/channel-suggestions`
- `POST /api/youtube/resolve`
- `POST /api/youtube/captions`
- `POST /api/youtube/download`
- `WS /api/elevenlabs/scribe-live` through `VITE_MEDIA_WS_BASE_URL`

Firestore stores durable state:

- `users/{uid}`: profile and Stripe customer id
- `entitlements/{uid}`: ElevenLabs paid, reserved, used, and remaining seconds
- `billingEvents/{eventId}`: Stripe webhook idempotency records
- `usage/{uid}/scribeSessions/{sessionId}`: Scribe reservation and settlement records

## Billing Model

The app should not charge a card once per second. That would be expensive and brittle because payment rails have minimum amounts, fees, asynchronous failures, and chargeback surface.

The MVP should sell prepaid Scribe seconds and meter usage per second internally:

- Default public price: `1 EUR / hour`
- Default configured value: `ELEVENLABS_PRICE_CENTS_PER_HOUR=100`
- Default minimum purchase: `ELEVENLABS_MIN_PURCHASE_SECONDS=3600`
- Entitlement decrement source: Cloud Run Scribe completion/usage accounting

Stripe is the PSP. Google Pay is enabled through Stripe payment method domains and automatic payment methods.

## Gemini

Gemini stays server-side. The Function owns the key pool, per-key cooldowns, per-user limits, and clean retry responses. Client-provided Gemini keys are intentionally not part of the production release.

## Media Workloads

Cloud Run is the correct home for `yt-dlp`, downloads, captions, WebSocket Scribe, and `ffmpeg` because those workloads need long request windows, child processes, streaming, and adjustable memory/concurrency. The release media profile in `cloudbuild.media.yaml` is `2Gi` memory, `2` CPU, concurrency `4`, max instances `20`, and a `3600` second timeout. Keep `YOUTUBE_MAX_CONCURRENT_JOBS=1`.

## Release Guard

`npm run check:release` verifies the deployment split, dependency boundaries, Firestore write policy, direct Cloud Run WebSocket requirement, structured media/control-plane logs, and absence of legacy Render/GitHub Pages release paths.

## Operational Signals

Cloud Run media logs are structured JSON events under the `visual-music-media` service name. Required events include HTTP status/duration, yt-dlp job completion/failure, YouTube fallback failures, Scribe reservation/settlement/release, Scribe session errors, and ffmpeg decode failures.

Cloud Functions logs use `firebase-functions/logger` under the `living-sketchbook-control-plane` service name. Required events include Gemini translation completion, entitlement reads, Stripe checkout/payment-intent creation, webhook receipt, webhook duplicates, and ElevenLabs second grants.

## What Still Requires External Setup

- Register the Firebase Hosting domain in Stripe for Google Pay.
- Create Cloud Logging dashboards and alert policies from the structured events.
- Deploy against real Firebase, Stripe, Gemini, ElevenLabs, and Cloud Run project secrets before accepting paid traffic.
