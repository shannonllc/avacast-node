// fetch で /v1 を呼ぶ（voicast・Webhook Admin の SDK と同じ作り）。再試行（429・5xx・通信の失敗）、打ち切り、エラーの変換。
import {
  ApiError,
  type AvacastApiError,
  ConnectionError,
  errorFromResponse,
  parseRetryAfter,
  requestIdOf,
  TimeoutError,
} from './errors';
import type { RequestOptions } from './types';
import { USER_AGENT } from './version';

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type HttpConfig = {
  apiKey: string;
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  fetch: Fetch;
};

/** `undefined` is left out. */
export type Query = Record<string, string | number | undefined>;

export type HttpRequest = {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Safe to send twice (GET, DELETE, or a POST with an Idempotency-Key). 5xx, timeouts and network errors are
   * retried only for these.
   */
  idempotent: boolean;
};

/** Longest wait honoured for `retry-after`. Longer waits are thrown at once. */
export const MAX_RETRY_AFTER_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/**
 * 429 codes that are not retried: they clear only when you act (close a session, wait for the queue).
 * `rate_limited` is retried: the API refuses it before doing anything.
 */
export const NOT_RETRIED_429 = new Set(['concurrency_limit', 'queue_full']);

/** Exponential backoff with ±25% jitter. attempt starts at 0. */
export function backoff(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Milliseconds from `retry-after`, or undefined. */
export function retryAfterWait(headers: Headers, now: number = Date.now()): number | undefined {
  const after = parseRetryAfter(headers.get('retry-after'), now);
  return after === undefined ? undefined : Math.ceil(after * 1000);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new ConnectionError('Request was aborted', { cause: signal?.reason }));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type Outcome =
  | { ok: true; value: unknown }
  | { ok: false; error: AvacastApiError; retryable: boolean; wait?: number };

export class Http {
  constructor(readonly config: HttpConfig) {}

  url(path: string, query: Query = {}): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const s = qs.toString();
    return `${this.config.baseUrl}${path}${s ? `?${s}` : ''}`;
  }

  async request<T>(req: HttpRequest, options: RequestOptions = {}): Promise<T> {
    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    for (let attempt = 0; ; attempt++) {
      const r = await this.once(req, options);
      if (r.ok) return r.value as T;
      if (!r.retryable || attempt >= maxRetries || options.signal?.aborted) throw r.error;
      await sleep(r.wait ?? backoff(attempt), options.signal);
    }
  }

  private async once(req: HttpRequest, options: RequestOptions): Promise<Outcome> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...req.headers,
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }
    if (options.signal?.aborted) {
      return {
        ok: false,
        error: new ConnectionError('Request was aborted', { cause: options.signal.reason }),
        retryable: false,
      };
    }
    const timeout = options.timeout ?? this.config.timeout;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeout);
    const onAbort = () => ctrl.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let res: Response;
    let text: string;
    try {
      res = await this.config.fetch(this.url(req.path, req.query), {
        method: req.method,
        headers,
        body,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      if (timedOut)
        return {
          ok: false,
          error: new TimeoutError(`Request timed out after ${timeout} ms`, { cause: e }),
          retryable: req.idempotent,
        };
      if (options.signal?.aborted)
        return {
          ok: false,
          error: new ConnectionError('Request was aborted', { cause: e }),
          retryable: false,
        };
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        error: new ConnectionError(`Connection error: ${msg}`, { cause: e }),
        retryable: req.idempotent,
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (res.ok) {
      if (text === '') return { ok: true, value: undefined };
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch (e) {
        const error = new ApiError(`Invalid JSON in response (HTTP ${res.status})`, {
          status: res.status,
          requestId: requestIdOf(res.headers),
          cause: e,
        });
        return { ok: false, error, retryable: false };
      }
    }
    const error = errorFromResponse(res.status, text, res.headers);
    let retryable: boolean;
    if (res.status === 429) retryable = !NOT_RETRIED_429.has(error.code);
    else retryable = res.status >= 500 && req.idempotent;
    const wait = retryAfterWait(res.headers);
    if (retryable && wait !== undefined && wait > MAX_RETRY_AFTER_MS) retryable = false;
    return { ok: false, error, retryable, wait };
  }
}
