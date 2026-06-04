# Living Sketchbook Music

A local music visualizer for synced bilingual lyrics.

The app pipeline is:

```txt
YouTube video -> manual YouTube captions, when available -> letter-timed source lyrics -> optional Gemini Flash Lite -> synced playback
Audio file or captionless YouTube video -> ElevenLabs Scribe Realtime -> letter-timed source lyrics -> optional Gemini Flash Lite -> synced playback
```

You can paste a YouTube video or channel URL into the same library search box. Video imports first try server-side manual YouTube caption extraction with no YouTube Data API key and no ElevenLabs call. If readable manual captions exist, the imported song is saved as already synced with word and character timing. YouTube automatic captions are used only when the `YouTube automatic captions` setting is enabled. If captions are missing, blocked, or automatic-only while that setting is off, the audio still imports and the existing ElevenLabs Scribe flow remains the fallback. Channel URLs use the YouTube Data API when configured, or the backend downloader when the key is blank.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and set:

   ```env
   ELEVENLABS_API_KEY=
   GEMINI_API_KEYS=
   GEMINI_KEY_MAX_CONCURRENCY=1
   GEMINI_KEY_REQUESTS_PER_MINUTE=12
   GEMINI_KEY_REQUESTS_PER_DAY=0
   GEMINI_USER_REQUESTS_PER_MINUTE=6
   GEMINI_USER_REQUESTS_PER_DAY=120
   YOUTUBE_API_KEY=
   YOUTUBE_COOKIES_BASE64=
   ```

   Gemini uses `gemini-flash-lite-latest`. Configure `GEMINI_API_KEYS` on the server as one key or a comma/newline-separated pool from projects you own. The backend assigns users to available keys, cools down keys after quota/auth failures, and returns a clean rate-limit response when server capacity is busy.

   `YOUTUBE_API_KEY` is optional. Video imports and manual caption extraction can run without it. Channel/video metadata can also resolve without it through the backend downloader. If YouTube blocks anonymous downloader or caption requests on a cloud host, export a browser `cookies.txt` file in Netscape format, base64 encode it, and set `YOUTUBE_COOKIES_BASE64` on the backend.

3. Run locally:

   ```bash
   npm run dev
   ```

## Checks

```bash
npm run lint
npm run build
```

## License

Apache-2.0. See [LICENSE](LICENSE).

## GitHub Pages

GitHub Pages can host the frontend bundle, but it cannot run the Node server in `server.ts`. That means lyric transcription and Gemini translation still need a deployed backend.

1. Keep this repository on `main`. The included GitHub Actions workflow publishes the frontend automatically.
2. If you only want the static shell, push to GitHub and enable Pages to use GitHub Actions as the source.
3. If you want transcription and translation to work from Pages, deploy the existing server separately and set the repository variable `VITE_API_BASE_URL` to that backend URL.
4. Make sure `APP_URL` on the backend matches your Pages origin, for example `https://ronitervo.github.io`, so browser requests from the site are accepted.

For a local Pages-style build, run:

```bash
npm run build:pages
```

## Render Backend

The repository now includes [render.yaml](render.yaml), so Render can pick up the backend service settings automatically.

1. Open Render and click `New +`.
2. Click `Web Service`.
3. Connect this GitHub repository.
4. Render should detect [render.yaml](render.yaml). Keep the generated service settings.
5. The blueprint sets `APP_URL=https://ronitervo.github.io` for this Pages site. Change it if you deploy a fork, custom domain, or different frontend origin.
6. Set `GEMINI_API_KEYS` on the backend so nontechnical users can translate without bringing their own Gemini key.
   If you want users to supply their own ElevenLabs key, leave `ELEVENLABS_API_KEY` empty.
   Leave `YOUTUBE_API_KEY` empty for no-key YouTube imports. Videos with manual captions can sync without user-provided ElevenLabs or YouTube keys.
   If Render gets YouTube's bot check, set `YOUTUBE_COOKIES_BASE64` to a base64 encoded Netscape `cookies.txt` export from a YouTube-signed-in browser.
   Keep `YOUTUBE_MAX_CONCURRENT_JOBS=1` on Render's free tier so YouTube imports do not overlap multiple `yt-dlp` processes.
7. Click `Create Web Service`.
8. After the deploy finishes, copy the backend URL Render gives you.

## GitHub Setup Clicks

To connect GitHub Pages to that backend:

1. Open the repository on GitHub.
2. Click `Settings`.
3. In the left sidebar, click `Secrets and variables`, then `Actions`.
4. Click the `Variables` tab.
5. Click `New repository variable`.
6. Set the name to `VITE_API_BASE_URL`.
7. Paste your Render backend URL as the value.
8. Click `Add variable`.
9. Still in `Settings`, click `Pages` in the left sidebar.
10. Under `Build and deployment`, set `Source` to `GitHub Actions`.
11. Push to `main`, or open the `Actions` tab and rerun the Pages workflow.

With that setup, the frontend is hosted on GitHub Pages, the backend runs on Render, and Gemini translation uses the server key pool.

The frontend now warms the backend on page load and keeps sending light health checks while the tab stays open. That removes most first-upload cold starts on Render free instances, but the backend can still sleep again after the tab closes or if the browser heavily throttles background work.
