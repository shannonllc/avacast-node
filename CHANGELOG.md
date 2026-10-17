# Changelog

## 0.3.0 (2026-10-17)

- Server SDK: `new Avacast(apiKey)` calls the REST API (`/v1`) with your API key (`sk_live_…` / `sk_test_…`, or `AVACAST_API_KEY`).
  - `sessions.create`, `sessions.get`, `sessions.end`, `sessions.speak`, `sessions.interrupt`
  - `avatars.list`, `usage.get` (this month), `usage.range` (`from` / `to` / `group_by: 'metadata.<key>'`), `status`
  - Retries 429 `rate_limited`, and 5xx and network errors for requests that are safe to repeat. `sessions.create` and `sessions.speak` send an `Idempotency-Key` (generated, or `idempotencyKey`), so they are retried without opening two sessions or speaking twice. `interrupt` is not retried on a 5xx or a network error.
  - Errors by status: `ValidationError`, `AuthenticationError`, `PaymentRequiredError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `ApiError`, `ConnectionError`, `TimeoutError`. All extend `AvacastApiError` and the browser SDK's `AvacastError`; `code` is the API's `error.code`.
  - `VOICE_IDS` and `LANGUAGES`: the values for `voice.voice_id` and `voice.language`.
  - Node.js 18+, Bun, Deno and edge runtimes with `fetch`. ESM and CommonJS. No dependencies.
- The browser SDK is also available as `avacast/web`. `import { AvacastSession } from 'avacast'` keeps working.
- `AvacastError` has `status` and `requestId` (from `x-request-id`) when the API refused a call.

## 0.2.0 (2026-10-12)

- `session.isSpeaking`. Every `speak()` gets `speak.started` then `speak.ended` or `speak.interrupted`, and `queue.drained` when nothing is left to say.

## 0.1.1 (2026-09-28)

- Imports inside the package end with `.js`, so it loads from Node's ESM.

## 0.1.0 (2026-09-28)

- First release of the browser SDK (`AvacastSession`).
