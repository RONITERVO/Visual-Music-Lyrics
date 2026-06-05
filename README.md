# Visual Music Lyrics

A production-oriented React/Vite music visualizer for synced bilingual lyrics.

The release architecture is Firebase-first:

```txt
Firebase Hosting
  -> static React app
  -> /api/translate, /api/billing, /api/webhooks, /api/entitlements -> Cloud Functions
  -> /api/youtube, /api/elevenlabs/scribe -> Cloud Run media service

Firestore
  -> user profile records
  -> ElevenLabs paid/reserved/used seconds
  -> Stripe webhook idempotency records
  -> Scribe usage session records
```

The core product pipeline is:

```txt
YouTube video -> manual captions when readable -> optional Gemini translation -> synced playback
Audio file or captionless YouTube video -> ElevenLabs Scribe -> optional Gemini translation -> synced playback
```

## Architecture Decision

The idea is directionally right, but not as originally phrased:

- Firebase Hosting with same-origin rewrites is the correct default for the web app.
- Cloud Functions are a good fit for auth-bound control-plane APIs: Gemini translation, entitlement reads, billing session creation, and Stripe webhooks.
- Cloud Run is the right place for media/data-plane work: `yt-dlp`, caption extraction, audio downloads, and batch ElevenLabs Scribe transcription.
- Scribe uses `POST /api/elevenlabs/scribe` over HTTP. The frontend does not need a websocket media origin.
- Google Pay is not a billing backend. Use Stripe or another PSP, then enable Google Pay through that provider. This repo uses Stripe because it supports Google Pay for web payment flows and gives reliable webhooks.
- Do not bill every second as a separate card charge. The MVP sells prepaid ElevenLabs seconds, then meters usage per second internally. The default price is `100` cents per hour with a minimum top-up of `3600` seconds.

See [docs/production-architecture.md](docs/production-architecture.md) for the detailed release model.

## Local Development

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env` and fill only the services you need locally.

Run the local all-in-one development server:

```bash
npm run dev
```

Local dev still uses `server.ts` so the frontend, media routes, and Gemini route can be exercised without deploying. Production does not use this as a monolith.

## Production Build

```bash
npm run lint
npm run build
```

`npm run build` builds:

- the Firebase Hosting app in `dist/`
- the Cloud Run media server bundle in `dist/server.cjs`
- the Cloud Functions control-plane bundle in `functions/lib/`

## Firebase Setup

1. Create a Firebase project.
2. Enable Firebase Authentication with Google as a provider.
3. Enable Firestore in production mode.
4. Create a Firebase Web App and copy its config into the `VITE_FIREBASE_*` variables.
5. Deploy Firestore rules and Hosting/Functions with the Firebase CLI:

```bash
firebase deploy --only firestore,functions,hosting
```

## Cloud Run Media Service

Build and deploy the media service container from the repository root:

```bash
gcloud builds submit --config cloudbuild.media.yaml
```

Set the Cloud Run secrets/env vars from `.env.example`, especially `ELEVENLABS_API_KEY`, YouTube settings, and Firebase Admin service identity access.

The media deployment profile is fixed in [cloudbuild.media.yaml](cloudbuild.media.yaml): `2Gi` memory, `2` CPU, concurrency `4`, max instances `20`, and a `3600` second request timeout for media jobs.

## Stripe and Google Pay

Use Stripe as the payment service provider:

1. Create a Stripe account.
2. Register the Firebase Hosting domain in Stripe payment method domains.
3. Enable Google Pay in Stripe payment methods.
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` on Cloud Functions.
5. Point the Stripe webhook endpoint at:

```txt
https://YOUR_FIREBASE_HOSTING_DOMAIN/api/webhooks/stripe
```

The webhook grants prepaid ElevenLabs seconds in Firestore after `payment_intent.succeeded`.

## Operational Signals

Cloud Run and Cloud Functions emit structured production events for request duration, yt-dlp job completion/failure, Scribe second reservation/settlement, Scribe batch errors, Gemini translation completion, checkout creation, and Stripe webhook grants. `npm run check:release` fails if those release-critical logging hooks are removed.

Create Cloud Logging dashboards and alert policies for high error rates, repeated yt-dlp failures, Scribe entitlement failures, missing webhook grants, and unusual Scribe seconds used.

## Checks

```bash
npm run lint
npm run check:release
npm run build
npm run test:backend
npm run test:youtube-captions
npm run test:translation
```

## License

Apache-2.0. See [LICENSE](LICENSE).
