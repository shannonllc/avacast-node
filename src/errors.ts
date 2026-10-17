// API のエラー（{ "error": { "code", "message" } }）を状態コードごとのクラスにする。
// どれもブラウザの SDK と同じ AvacastError を元にする（instanceof AvacastError で両方を受けられる）
import { AvacastError, type AvacastErrorOptions } from './web/session.js';
import type { ErrorCode } from './types';

export { AvacastError, type AvacastErrorOptions };

export type ErrorOptions = AvacastErrorOptions & {
  /** API error code. `''` when there is none (no response, or a body without a code). */
  code?: ErrorCode;
};

/** Base class of the errors thrown by the `Avacast` client. `code` is the API's `error.code`, or `''`. */
export class AvacastApiError extends AvacastError {
  override name = 'AvacastApiError';
  override readonly code: ErrorCode;

  constructor(message: string, options: ErrorOptions = {}) {
    super(options.code ?? '', message, options);
    this.code = options.code ?? '';
  }
}

/** 400 `invalid_request`: a parameter is missing or invalid (for example text over 1,000 characters). */
export class ValidationError extends AvacastApiError {
  override name = 'ValidationError';
}

/** 401 `invalid_api_key`: the API key is wrong or revoked, or the account is not active. */
export class AuthenticationError extends AvacastApiError {
  override name = 'AuthenticationError';
}

/** 402 `payment_required`: the monthly limit was reached. New sessions are refused. */
export class PaymentRequiredError extends AvacastApiError {
  override name = 'PaymentRequiredError';
}

/** 403: the operation is not allowed. */
export class PermissionError extends AvacastApiError {
  override name = 'PermissionError';
}

/** 404 `session_not_found`, `avatar_not_found` or `not_found`. */
export class NotFoundError extends AvacastApiError {
  override name = 'NotFoundError';
}

/** 409 `session_ended`, `session_not_connected` or `idempotency_conflict`. */
export class ConflictError extends AvacastApiError {
  override name = 'ConflictError';
}

/** 429 `rate_limited`, `concurrency_limit` or `queue_full`. Thrown after retries are used up. */
export class RateLimitError extends AvacastApiError {
  override name = 'RateLimitError';
  /** Seconds to wait before retrying, from `retry-after`. */
  readonly retryAfter: number | undefined;

  constructor(message: string, options: ErrorOptions & { retryAfter?: number } = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** Any other error response, including 5xx (`gpu_unavailable` and `maintenance` are 503). */
export class ApiError extends AvacastApiError {
  override name = 'ApiError';
  /** Seconds to wait before retrying, from `retry-after` (sent with `maintenance`). */
  readonly retryAfter: number | undefined;

  constructor(message: string, options: ErrorOptions & { retryAfter?: number } = {}) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** The request could not reach the API (DNS, TCP, TLS) or was aborted. */
export class ConnectionError extends AvacastApiError {
  override name = 'ConnectionError';
}

/** The request did not complete within `timeout`. */
export class TimeoutError extends ConnectionError {
  override name = 'TimeoutError';
}

/** Seconds from `retry-after` (seconds or HTTP date). */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - now) / 1000);
}

export function requestIdOf(headers: Headers): string | undefined {
  return headers.get('x-request-id') ?? headers.get('cf-ray') ?? undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Reads `{ error: { code, message } }`; also accepts `{ error: code, message }`. */
function readBody(text: string): { code?: string; message?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {}; // HTML from a proxy, empty body, etc.
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const { error, message } = parsed as { error?: unknown; message?: unknown };
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown };
    return { code: str(e.code), message: str(e.message) };
  }
  return { code: str(error), message: str(message) };
}

/** Builds the error for a non-2xx response. `text` is the raw response body. */
export function errorFromResponse(status: number, text: string, headers: Headers): AvacastApiError {
  const body = readBody(text);
  const options: ErrorOptions = { status, code: body.code, requestId: requestIdOf(headers) };
  const message = body.message ?? `HTTP ${status}`;
  switch (status) {
    case 400:
    case 422:
      return new ValidationError(message, options);
    case 401:
      return new AuthenticationError(message, options);
    case 402:
      return new PaymentRequiredError(message, options);
    case 403:
      return new PermissionError(message, options);
    case 404:
      return new NotFoundError(message, options);
    case 409:
      return new ConflictError(message, options);
    case 429:
      return new RateLimitError(message, {
        ...options,
        retryAfter: parseRetryAfter(headers.get('retry-after')),
      });
    default:
      return new ApiError(message, {
        ...options,
        retryAfter: parseRetryAfter(headers.get('retry-after')),
      });
  }
}
