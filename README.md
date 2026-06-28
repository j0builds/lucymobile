# lucy-mobile

iOS + Android voice-first capture client for Lucy. Talk to the phone, the phone talks back, the words land in your team brain.

The mobile companion to [KSaxena-233/lucy](https://github.com/KSaxena-233/lucy). This repo is the client; the brain lives there.

## Why this exists

`POST /v1/capture` already works on the server. What was missing was a frictionless way to *put text into it* from anywhere. Typing on a laptop is the slow path. Voice on a phone is the fast path. This app is that path.

## How it talks to Lucy

```
phone mic
   |
   v
on-device transcription          (iOS Speech / Android SpeechRecognizer)
   |    Whisper-free, no API key, BYO-model invariant intact
   v
final transcript (text only)
   |
   v
POST /v1/capture                 (Bearer token, Lucy's existing endpoint)
   |
   v
ingestCapture() in lucy/src/capture.ts
   |
   v
redact -> extract -> evidence-gate -> draft skill
```

The phone never holds, hosts, or transmits an LLM key. Transcription is on the device. The server does the cognition work using the tenant's configured BYO-model. Nothing about the architecture changes.

## Run it locally

Requires Node 22+, Xcode 26+ (for iOS sim), Android Studio (for Android), and CocoaPods (`brew install cocoapods`).

```bash
git clone https://github.com/j0builds/lucymobile
cd lucymobile
npm install
npx expo prebuild              # generates ios/ and android/ (gitignored)
npx expo run:ios               # iPhone 17 Pro sim by default
# or
npx expo run:ios --device      # pick a connected real iPhone
# or
npx expo run:android           # connected device / emulator
```

First native compile takes 5-10 min cold. After that, edits hot-reload via Metro.

> The simulator has no microphone by default. Enable it: sim menu bar -> Device -> Microphone -> On.

## Configuration

Two things to point this at a real Lucy backend:

**1. Backend URL** in `app.json`:

```json
"extra": {
  "lucyApiUrl": "https://your-lucy-host.example.com"
}
```

Empty string = local-only mode (captures stay on device, no network call, status pill goes gray).

**2. Sign in.** Tap "sign in with github" on the welcome screen, or call `login(email, password)`. Either path stores a session token pair in SecureStore and the app auto-refreshes on `401`.

For staging you can still seed a bearer manually:

```ts
import { setApiKey } from '@/lib/api';
await setApiKey('<bearer-token-from-staticTenantResolver-or-prod>');
```

The token (or manual key) is sent as `Authorization: Bearer <token>` against your resolver.

## What's in this repo

```
src/app/index.tsx     the single-screen orb + camera + TTS loop + github sign-in + push routing
src/app/_layout.tsx   Stack root, dark theme, no tabs
src/lib/api.ts        token store, authed request() w/ 401-refresh-retry, act(), login(), logout(), registerDevice(), captureText() fallback
src/lib/config.ts     reads LUCY_API_URL from app.json extra
src/lib/push.ts       expo-notifications: permission + push token + registerDevice + payload parsing
src/lib/github.ts     GitHub OAuth via expo-web-browser + deep-link token capture
src/lib/response.ts   offline/degraded fallback reply crafter
app.json              expo config, plugins (incl. expo-notifications), permission strings, bundle ids
```

Bundle id: `ai.lamlab.lucy` for both iOS and Android.

## What's wired

- **Lucy's reply** comes from `POST /v1/mobile/act` (`act()` in `src/lib/api.ts`). The orb speaks the server's `spokenReply`. If the server returns `needsConfirm`, the orb speaks the prompt and the next utterance re-calls `act(text, true)`. `src/lib/response.ts` is now only the offline/degraded fallback.
- **Auth** has email/password (`login()`) and a rotating-refresh session: `request()` retries once on `401` by calling `POST /v1/auth/refresh`, swapping **both** tokens (the server rotates the refresh token), and replaying the request. If refresh fails, tokens are cleared and a logged-out event fires (`onLoggedOut`). The legacy manual `setApiKey` bearer still works as a fallback.
- **GitHub login** (`src/lib/github.ts`): "sign in with github" opens `/v1/auth/oauth/github/start` in an auth session via `expo-web-browser`, then captures `token` + `refreshToken` from the deep-link redirect (`lucymobile://auth/github`) into SecureStore. See the TODO below.
- **Push notifications** (`src/lib/push.ts`): after sign-in the app requests permission, fetches the Expo push token, and calls `POST /v1/devices/register`. A response listener routes `data.{type,id}` (`reinforce` / `needs_you` / `interception`).

## Still stubbed / TODO

- **GitHub deep-link glue**: `loginWithGithub()` assumes the server redirects back with `?token=&refreshToken=`. If the server instead returns a one-time `code` to exchange, add the exchange POST where marked `// TODO` in `src/lib/github.ts`. The redirect URI the server must allow-list is `lucymobile://auth/github`.
- **Push routing**: notification taps set a status line / log the `{type,id}`. A `reinforce` recall prompt and `needs_you`/`interception` items need a dedicated screen once routing beyond the single screen exists (marked `// TODO` in `index.tsx`).
- **Offline queue** is not implemented. Captures while offline currently error instead of queueing for retry.

## Permissions requested

| Permission | Why |
|---|---|
| Microphone | Capture spoken thoughts |
| Speech recognition | On-device transcription |
| Camera | Front-cam mirror so you're looking *into* Lucy while talking |

All copy is in `app.json` under each plugin's config block.

## Design language

Dark canvas, teal accent matching the Lucy dashboard (`#0F766E` / `#14B8A6`). The orb breathes when idle, scales with mic volume when listening, glows teal while Lucy speaks back. Conversation log stacks above the orb with `YOU` / `LUCY` labels.

## Notes for Keshav

- Hits `/v1/capture` with the exact shape `{ text, ref }` your handler expects.
- `ref` defaults to `mobile:<timestamp>` so dedup via `seen` store works.
- Response shape consumed: `{ committed, drafts: [{id, title}], redactions }`. If the API contract changes, `src/lib/api.ts` is the single file to update.
- Bearer header is the only auth path the client uses. `x-api-key` is supported on the server but mobile sticks to `Authorization`.
- Hot-reload works for any change in `src/`. Native module changes (new plugin in `app.json`) need a rebuild.
