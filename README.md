# avacast

Node.js / TypeScript SDK for [avacast](https://avacast.jp/) realtime avatars.

- `Avacast`: on your server, with your API key. Create sessions, make the avatar speak, read usage.
- `AvacastSession` (`avacast/web`): in the browser, with the session's `client_token`. Show the avatar and get speech events.
- No dependencies. Node.js 18+, Bun, Deno and edge runtimes with `fetch`, and browsers. ESM and CommonJS, with TypeScript types.

## Install

```sh
npm install avacast
```

## Quick start

```ts
// server
import { Avacast } from 'avacast';

const avacast = new Avacast('sk_live_...'); // or set AVACAST_API_KEY

const { data: avatars } = await avacast.avatars.list();
const session = await avacast.sessions.create({
  avatar_id: avatars[0].id,
  voice: { language: 'ja', voice_id: 'female-30s-clear' },
});
// Give only these to the browser. Never ship the API key to a browser.
return { client_token: session.client_token, webrtc: session.webrtc };
```

```ts
// browser
import { AvacastSession, SessionEvent, SpeakEvent } from 'avacast/web';

const session = new AvacastSession(clientToken, {
  signalingUrl: webrtc.signaling_url,
  iceServers: webrtc.ice_servers,
});
session.attach(videoEl);
// Speak after the video has arrived (session.ready). Speaking earlier is refused with 409 session_not_connected.
session.on(SessionEvent.STREAM_READY, () => session.speak('ご相談ありがとうございます。'));
session.on(SpeakEvent.QUEUE_DRAINED, () => askNextQuestion());
await session.start();
```

`import { AvacastSession } from 'avacast'` works too (`avacast` and `avacast/web` are separate bundles, so `instanceof` does not match across the two: import from one of them). Without a bundler, load `https://avacast.jp/sdk/v1.js` (ES module) or `https://avacast.jp/sdk/v1.iife.js` (global `Avacast`).

## Server

```ts
const avacast = new Avacast(process.env.AVACAST_API_KEY, {
  timeout: 30_000, // ms per attempt (default)
  maxRetries: 2, // retries after the first attempt (default)
});
```

| Method | API |
|---|---|
| `sessions.create({ avatar_id, voice?, idle_timeout_seconds?, metadata? })` | `POST /v1/sessions` |
| `sessions.speak(sessionId, text)` | `POST /v1/sessions/:id/speak` |
| `sessions.interrupt(sessionId)` | `POST /v1/sessions/:id/interrupt` |
| `sessions.get(sessionId)` | `GET /v1/sessions/:id` |
| `sessions.end(sessionId)` | `DELETE /v1/sessions/:id` |
| `avatars.list()` | `GET /v1/avatars` |
| `usage.get()` | `GET /v1/usage` (this month) |
| `usage.range({ from?, to?, group_by? })` | `GET /v1/usage?from=&to=&group_by=` |
| `status()` | `GET /v1/status` |

Every method takes options last: `{ timeout, maxRetries, signal }`. `sessions.create` and `sessions.speak` also take `idempotencyKey`.

### Speaking from your server

```ts
await avacast.sessions.speak(session.session_id, 'First question.');
await avacast.sessions.speak(session.session_id, 'Second question.'); // no need to wait: lines are queued

await avacast.sessions.interrupt(session.session_id); // the user started talking
await avacast.sessions.end(session.session_id); // billing stops when the session closes
```

Call `speak` after the browser has connected (`session.ready`), or it fails with `ConflictError` (`session_not_connected`). The queue holds 20 lines; more fails with `RateLimitError` (`queue_full`).

You are billed for the time a session is open (`connected_seconds`). Sessions also close after `idle_timeout_seconds` without speaking (default 180) and at the plan's longest session (`expires_at`).

### Voices and languages

```ts
import { LANGUAGES, VOICE_IDS } from 'avacast';

VOICE_IDS; // ['female-standard', 'female-20s-bright', 'female-30s-clear', …, 'male-60s-deep']
LANGUAGES; // ['ja', 'en', 'zh', 'th', 'es', 'vi', 'pt', 'it', 'sk']
```

Without `voice_id`, the session uses the avatar's voice.

### Usage

```ts
const month = await avacast.usage.get(); // this month (UTC) and your limits
const byTenant = await avacast.usage.range({
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-11-01T00:00:00Z'),
  group_by: 'metadata.tenant', // sessions created with metadata: { tenant: '…' }
});
for (const row of byTenant.data ?? []) console.log(row.key, row.connected_seconds);
```

### Errors

```ts
import { ConflictError, NotFoundError, RateLimitError } from 'avacast';

try {
  await avacast.sessions.speak(id, text);
} catch (e) {
  if (e instanceof ConflictError && e.code === 'session_not_connected') {
    // wait for session.ready in the browser
  } else if (e instanceof RateLimitError && e.code === 'queue_full') {
    // wait for speak.ended, or interrupt
  } else {
    throw e;
  }
}
```

| Class | Status | `code` |
|---|---|---|
| `ValidationError` | 400 | `invalid_request` |
| `AuthenticationError` | 401 | `invalid_api_key` |
| `PaymentRequiredError` | 402 | `payment_required` (monthly limit reached) |
| `NotFoundError` | 404 | `session_not_found`, `avatar_not_found`, `not_found` |
| `ConflictError` | 409 | `session_ended`, `session_not_connected`, `idempotency_conflict` |
| `RateLimitError` | 429 | `rate_limited`, `concurrency_limit`, `queue_full` |
| `ApiError` | 5xx and others | `gpu_unavailable` (no capacity right now), `maintenance` |
| `ConnectionError` | – | Could not reach the API, or aborted |
| `TimeoutError` | – | No response within `timeout` |

All of them extend `AvacastApiError`, which extends `AvacastError` (also thrown by the browser SDK). Each has `code`, `status`, `requestId` (quote it when you contact us) and `message`. Branch on `code`; messages may change.

### Retries

- 429 `rate_limited` is retried after `retry-after`. `concurrency_limit` and `queue_full` are thrown at once: close a session, or wait for the queue.
- 5xx, timeouts and network errors are retried for `get`, `end`, `avatars.list`, `usage` and `status`, and for `create` and `speak`, which send an `Idempotency-Key` so that a retry does not open a second session or speak twice. `interrupt` is not retried on these.
- Waits are exponential (0.5 s, 1 s, 2 s … up to 8 s, ±25%), or `retry-after` when the API sends it. A `retry-after` over 60 seconds is thrown at once.

## Browser

```ts
import { AvacastSession, SessionEvent, SpeakEvent } from 'avacast/web';
```

| Constant | Name | Meaning |
|---|---|---|
| `SessionEvent.STREAM_READY` | `session.ready` | Video has started. You can speak now |
| `SessionEvent.DISCONNECTED` | `session.ended` | The session was disconnected |
| `SessionEvent.ERROR` | `error` | Unrecoverable error |
| `SpeakEvent.SPEAK_STARTED` | `speak.started` | A line started |
| `SpeakEvent.SPEAK_ENDED` | `speak.ended` | A line finished |
| `SpeakEvent.SPEAK_INTERRUPTED` | `speak.interrupted` | A line was interrupted |
| `SpeakEvent.QUEUE_DRAINED` | `queue.drained` | Nothing left to say: **the avatar has finished speaking** (`speak.ended` comes once per line) |

Every `speak()` gets `speak.started` then `speak.ended`, or `speak.interrupted` (also for lines discarded by `interrupt()` before they started). `queue.drained` follows when nothing is left, including right after `interrupt()`.

`session.isSpeaking` tells whether the avatar is speaking now, for example to mute the microphone while the avatar speaks.

`session.speak(text)` and `session.interrupt()` call the API with the `client_token`, so the browser can drive the avatar without a round trip through your server. `on()` returns a function that removes the listener:

```ts
useEffect(() => session.on(SpeakEvent.SPEAK_ENDED, next), [session]);
```

`session.stop()` disconnects the browser. To end the session (and billing), call `sessions.end` on your server, or let it close when idle.

Branch on the `code` of `AvacastError`: `invalid_client_token`, `session_ended`, `session_not_connected`, `queue_full`, `invalid_request`, `gpu_unavailable`, `connect_failed`.

## Links

- Docs: https://avacast.jp/docs
- License: MIT
