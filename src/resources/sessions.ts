import type { Http } from '../http';
import { uuid } from '../runtime';
import type {
  EndedSession,
  IdempotentRequestOptions,
  InterruptResult,
  RequestOptions,
  Session,
  SessionCreateParams,
  SessionState,
  Utterance,
} from '../types';
import { id } from './path';

/** Sessions: open an avatar, make it speak, and close it (`/v1/sessions`). */
export class Sessions {
  /** @internal */
  constructor(private readonly http: Http) {}

  /**
   * Opens a session. Pass only `client_token` and `webrtc` to the browser, never the API key.
   * Sends an `Idempotency-Key` (generated unless you pass one), so it is retried safely on a 5xx or a network error.
   * Throws `PaymentRequiredError` at the monthly limit and `RateLimitError` (`concurrency_limit`) when too many sessions are open.
   */
  async create(
    params: SessionCreateParams,
    options: IdempotentRequestOptions = {},
  ): Promise<Session> {
    const { idempotencyKey, ...rest } = options;
    const key = idempotencyKey ?? `avacast-node-${await uuid()}`;
    return this.http.request(
      {
        method: 'POST',
        path: '/v1/sessions',
        body: params,
        headers: { 'idempotency-key': key },
        idempotent: true,
      },
      rest,
    );
  }

  /** The state, connected time (what you are billed for) and total speaking time. */
  get(sessionId: string, options?: RequestOptions): Promise<SessionState> {
    return this.http.request(
      { method: 'GET', path: `/v1/sessions/${id(sessionId)}`, idempotent: true },
      options,
    );
  }

  /** Ends the session. Ending one that has already ended is not an error. */
  end(sessionId: string, options?: RequestOptions): Promise<EndedSession> {
    return this.http.request(
      { method: 'DELETE', path: `/v1/sessions/${id(sessionId)}`, idempotent: true },
      options,
    );
  }

  /**
   * Queues a line (up to 1,000 characters). No need to wait for the previous line.
   * Throws `ConflictError` (`session_not_connected`) before the browser has connected, and `RateLimitError` (`queue_full`)
   * when 20 lines are waiting. Sends an `Idempotency-Key`, so it is retried without speaking twice.
   */
  async speak(
    sessionId: string,
    text: string,
    options: IdempotentRequestOptions = {},
  ): Promise<Utterance> {
    const { idempotencyKey, ...rest } = options;
    const key = idempotencyKey ?? `avacast-node-${await uuid()}`;
    return this.http.request(
      {
        method: 'POST',
        path: `/v1/sessions/${id(sessionId)}/speak`,
        body: { text },
        headers: { 'idempotency-key': key },
        idempotent: true,
      },
      rest,
    );
  }

  /** Stops the current line and discards the queue. Not retried on a 5xx or a network error (it could cut a newer line). */
  interrupt(sessionId: string, options?: RequestOptions): Promise<InterruptResult> {
    return this.http.request(
      { method: 'POST', path: `/v1/sessions/${id(sessionId)}/interrupt`, idempotent: false },
      options,
    );
  }
}
