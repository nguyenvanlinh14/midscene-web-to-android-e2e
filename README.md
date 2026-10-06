# Midscene Push E2E Demo

Gherkin test-cases drive a **web console** and an **Android emulator** with [Midscene.js](https://midscenejs.com):
the web page sends a Web Push notification, and the test verifies it arrives in the Android notification shade.

```
features/*.feature ─> Runner (src/) ─┬─ Playwright + Midscene ─> Notification Console (public/, functions/)
                                     └─ adb + Midscene        <─ Chrome on Android emulator (push)
```

## Writing test-cases

Each step is prefixed with the device that runs it: `[web]` or `[android]`.
`Given/When` steps run as `aiAct`; `Then` steps run as `aiAssert` (web) or `aiWaitFor` (android, push is async).
Placeholders: `{receiverUrl}`, `{consoleUrl}`, `{pairingCode}` (read from the Android screen automatically).

See [features/push-notification.feature](features/push-notification.feature). Tag filter: `npm run test:smoke`.

## Prerequisites (macOS)

- Node 20+, JDK 17, Android SDK (`emulator`, `platform-tools`) and an AVD named `push-demo`
  using a **Google Play** image (needed for Chrome push).
- Chrome on the emulator must be past its first-run screens and have notifications allowed.

## Run locally

```bash
npm install
npx playwright install chromium
npm run setup:keys        # generates VAPID keys into .dev.vars (gitignored)
cp .env.example .env      # then add your own Gemini API key
npm run dev               # terminal 1: console on http://localhost:8788
emulator -avd push-demo   # terminal 2
npm test                  # terminal 3
```

The runner runs `adb reverse` so the emulator reaches `localhost:8788` (a secure context, required for push).
Reports: each Midscene agent writes an HTML report under `midscene_run/report`; results are in `reports/summary.json`.

## Notes

- Free stack: Cloudflare Pages/Workers/KV, Web Push (VAPID), Android emulator, Gemini free tier.
- Deploying: create a KV namespace, put its id in `wrangler.toml`, set `VAPID_*` as secrets.

## QA page and caching

`npm run qa` starts the QA Test Runner at http://localhost:3000: QC pastes Gherkin, clicks Run, watches the live log and opens the reports.

AI planning is cached per scenario in `midscene_run/cache/`. The cache id includes a hash of the scenario steps:
- unchanged scenario → `aiAct` plans are replayed from cache (no planning calls);
- edited scenario → new hash → planned by AI again;
- `aiAssert` / `aiQuery` / `aiString` are never cached by Midscene, so they still call the model.

Set `NO_CACHE=true` to force full AI runs. Each run prints `AI calls: N` per scenario.
The pairing code is prefilled through `/?code=...` so it never ends up inside a cached plan.

## Built-in (deterministic) steps

Some step phrasings run without the AI — faster, no tokens, no fixed sleeps:

| Step text | What runs |
|---|---|
| `[web] open <url>` / `open {consoleUrl}` | Playwright `page.goto` |
| `[web] enter the pairing code shown on the phone` | code read from the Android UI tree (uiautomator), filled with Playwright |
| `[android] ... Home screen ...` | clear old notifications (verified via `cmd notification list`), go Home, wait until the launcher is on screen |
| `[android] open ... <url> ...` | `am start` the URL in Chrome |
| `[any] wait until <condition>` | Midscene `aiWaitFor` (condition-based, polling) |

Everything else goes to Midscene (`aiAct` for Given/When, `aiAssert`/`aiWaitFor` for Then).
The runner also starts the `push-demo` AVD automatically if no emulator is running.

## Demo video

`scripts/tts.py` (Gemini TTS, key from `.env`) + `scripts/record-demo.ts` (records the QA page) produce
`video/part1.webm` and `video/timeline.json`. Start the QA server with `DEMO_STEP_PAUSE_MS=3000` while recording
so viewers can read each Gherkin line (demo-only, off by default).
