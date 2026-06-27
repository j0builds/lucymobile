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

**2. API key** in SecureStore. Set programmatically:

```ts
import { setApiKey } from '@/lib/api';
await setApiKey('<bearer-token-from-staticTenantResolver-or-prod>');
```

Until GitHub OAuth is wired, this is a manual seed. The key is hit as `Authorization: Bearer <key>` against your `apiKeyFromHeaders()` resolver.

## What's in this repo

```
src/app/index.tsx     the single-screen orb + camera + TTS loop
src/app/_layout.tsx   Stack root, dark theme, no tabs
src/lib/api.ts        captureText() -> POST /v1/capture
src/lib/config.ts     reads LUCY_API_URL from app.json extra
src/lib/response.ts   stub reply crafter (REPLACE with /v1/ask)
app.json              expo config, plugins, permission strings, bundle ids
```

Bundle id: `ai.lamlab.lucy` for both iOS and Android.

## What's stubbed

- **Lucy's reply** is a randomised acknowledgement from `src/lib/response.ts`. Swap with a call to `/v1/ask` (or direct Claude/OpenAI through the BYO router) when you want real conversational responses.
- **Auth** is a hardcoded SecureStore key. GitHub OAuth + Lucy identity mapping is the next slice.
- **Offline queue** is not implemented. Captures while offline currently error instead of queueing for retry.
- **Push notifications** are not wired.

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
