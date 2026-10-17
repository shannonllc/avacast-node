// 再試行・打ち切り・エラーの種類・設定。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoff, MAX_RETRY_AFTER_MS, NOT_RETRIED_429, retryAfterWait } from '../src/http';
import {
  ApiError,
  AuthenticationError,
  Avacast,
  AvacastApiError,
  AvacastError,
  ConflictError,
  ConnectionError,
  NotFoundError,
  PaymentRequiredError,
  PermissionError,
  RateLimitError,
  TimeoutError,
  ValidationError,
  VERSION,
} from '../src/index';
import { client, empty, fakeFetch, hang, json } from './helpers';

const err = (code: string, message = 'm') => ({ error: { code, message } });
const state = { session_id: 'ses_1', status: 'active' };

/** 偽の時計で p を最後まで進める（再試行の待ちを飛ばす） */
async function settle<T>(p: PromiseLike<T>): Promise<{ value?: T; error?: unknown }> {
  const out = Promise.resolve(p).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return out;
}

describe('client options', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('sends Authorization, Accept and User-Agent with the SDK version; no body, no content-type on GET', async () => {
    const f = fakeFetch(json(200, state));
    await client(f.fn).sessions.get('ses_1');
    expect(f.calls[0]!.headers).toEqual({
      authorization: 'Bearer sk_test_abc',
      accept: 'application/json',
      'user-agent': `avacast-node/${VERSION}`,
    });
    expect(f.calls[0]!.body).toBeUndefined();
  });

  it('sends JSON bodies with content-type', async () => {
    const f = fakeFetch(json(202, { utterance_id: 'utt_1', status: 'queued', queue_length: 1 }));
    await client(f.fn).sessions.speak('ses_1', 'こんにちは');
    expect(f.calls[0]!.headers['content-type']).toBe('application/json');
    expect(f.calls[0]!.body).toEqual({ text: 'こんにちは' });
  });

  it('reads the API key from AVACAST_API_KEY', async () => {
    vi.stubEnv('AVACAST_API_KEY', 'sk_live_env');
    const f = fakeFetch(json(200, state));
    await new Avacast(undefined, { fetch: f.fn }).sessions.get('ses_1');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer sk_live_env');
  });

  it('throws without an API key', () => {
    vi.stubEnv('AVACAST_API_KEY', '');
    expect(() => new Avacast()).toThrow(AvacastApiError);
    expect(() => new Avacast('')).toThrow(/AVACAST_API_KEY/);
  });

  it('default base URL is https://api.avacast.jp, trailing slashes are removed', async () => {
    const f = fakeFetch(json(200, state));
    const v = new Avacast('sk_test_x', { fetch: f.fn });
    expect(v.baseUrl).toBe('https://api.avacast.jp');
    await v.sessions.get('ses_1');
    expect(f.calls[0]!.url.href).toBe('https://api.avacast.jp/v1/sessions/ses_1');
    expect(
      new Avacast('sk_test_x', { baseUrl: 'https://api.example.test//', fetch: f.fn }).baseUrl,
    ).toBe('https://api.example.test');
  });

  it('uses globalThis.fetch by default, called without a this binding', async () => {
    const seen: unknown[] = [];
    vi.stubGlobal('fetch', function (this: unknown) {
      seen.push(this);
      return Promise.resolve(json(200, { ok: true }));
    });
    expect(await new Avacast('sk_test_x').status()).toEqual({ ok: true });
    expect(seen).toEqual([undefined]);
  });

  it('throws when fetch is not available', () => {
    vi.stubGlobal('fetch', undefined);
    expect(() => new Avacast('sk_test_x')).toThrow(/fetch is not available/);
  });
});

describe('errors', () => {
  const cases: [number, string, new (...a: never[]) => AvacastApiError][] = [
    [400, 'invalid_request', ValidationError],
    [401, 'invalid_api_key', AuthenticationError],
    [402, 'payment_required', PaymentRequiredError],
    [403, 'forbidden', PermissionError],
    [404, 'session_not_found', NotFoundError],
    [409, 'session_ended', ConflictError],
    [422, 'invalid_request', ValidationError],
    [418, 'teapot', ApiError],
  ];
  for (const [status, code, cls] of cases) {
    it(`${status} → ${cls.name}`, async () => {
      const f = fakeFetch(json(status, err(code, `m ${status}`), { 'x-request-id': 'req_1' }));
      const e = (await client(f.fn)
        .sessions.get('ses_1')
        .catch((x) => x)) as AvacastApiError;
      expect(e).toBeInstanceOf(cls);
      expect(e).toBeInstanceOf(AvacastApiError);
      expect(e).toBeInstanceOf(AvacastError);
      expect(e.name).toBe(cls.name);
      expect(e).toMatchObject({ status, code, message: `m ${status}`, requestId: 'req_1' });
      expect(f.calls).toHaveLength(1);
    });
  }

  it('x-request-id wins over cf-ray, and cf-ray is used when it is the only one', async () => {
    const f = fakeFetch(
      json(404, err('not_found'), { 'x-request-id': 'req_2', 'cf-ray': 'r' }),
      json(404, err('not_found'), { 'cf-ray': 'r2' }),
    );
    const v = client(f.fn);
    expect(await v.sessions.get('a').catch((x) => x.requestId)).toBe('req_2');
    expect(await v.sessions.get('a').catch((x) => x.requestId)).toBe('r2');
  });

  it('reads the older shape { error: code, message }', async () => {
    const f = fakeFetch(json(404, { error: 'not_found', message: 'gone' }));
    expect(
      await client(f.fn)
        .sessions.get('a')
        .catch((x) => x),
    ).toMatchObject({ code: 'not_found', message: 'gone' });
  });

  it('a non-JSON error body falls back to HTTP <status> and code ""', async () => {
    const f = fakeFetch(
      new Response('<html>bad gateway</html>', { status: 502 }),
      new Response('null', { status: 400 }),
    );
    const v = client(f.fn, { maxRetries: 0 });
    const e = (await v.sessions.get('a').catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({
      status: 502,
      code: '',
      message: 'HTTP 502',
      requestId: undefined,
      retryAfter: undefined,
    });
    expect(await v.sessions.get('a').catch((x) => x)).toMatchObject({
      status: 400,
      message: 'HTTP 400',
    });
  });

  it('a JSON error body that is not an object, or with non-string fields, is ignored', async () => {
    const f = fakeFetch(
      new Response('"oops"', { status: 500 }),
      json(400, { error: { code: 1, message: 2 } }),
      json(400, { error: 1, message: 2 }),
    );
    const v = client(f.fn, { maxRetries: 0 });
    expect(await v.sessions.get('a').catch((x) => x)).toMatchObject({
      status: 500,
      code: '',
      message: 'HTTP 500',
    });
    expect(await v.sessions.get('a').catch((x) => x)).toMatchObject({
      status: 400,
      code: '',
      message: 'HTTP 400',
    });
    expect(await v.sessions.get('a').catch((x) => x)).toMatchObject({
      status: 400,
      code: '',
      message: 'HTTP 400',
    });
  });

  it('invalid JSON in a 2xx response is an ApiError and is not retried', async () => {
    const f = fakeFetch(
      new Response('{oops', { status: 200, headers: { 'x-request-id': 'req_3' } }),
    );
    const e = (await client(f.fn)
      .sessions.get('a')
      .catch((x) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 200, requestId: 'req_3' });
    expect(e.message).toMatch(/Invalid JSON/);
    expect(f.calls).toHaveLength(1);
  });

  it('errors keep the cause', async () => {
    const boom = new TypeError('fetch failed');
    const f = fakeFetch(boom);
    const e = (await client(f.fn, { maxRetries: 0 })
      .sessions.get('a')
      .catch((x) => x)) as ConnectionError;
    expect(e).toBeInstanceOf(ConnectionError);
    expect(e.cause).toBe(boom);
    expect(e.message).toBe('Connection error: fetch failed');
    expect(e).toMatchObject({ status: undefined, code: '' });
  });

  it('error classes can be constructed directly', () => {
    const e = new RateLimitError('slow');
    expect(e).toMatchObject({
      name: 'RateLimitError',
      message: 'slow',
      status: undefined,
      retryAfter: undefined,
      code: '',
    });
    expect(new AvacastApiError('x').cause).toBeUndefined();
    expect(new ApiError('x')).toMatchObject({ code: '', retryAfter: undefined });
    expect(new ApiError('x', { code: 'maintenance', retryAfter: 3 })).toMatchObject({
      code: 'maintenance',
      retryAfter: 3,
    });
  });

  it('a non-Error rejection is still a ConnectionError', async () => {
    const f = fakeFetch(() => Promise.reject('down'));
    const e = await client(f.fn, { maxRetries: 0 })
      .sessions.get('a')
      .catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionError);
    expect(e.message).toBe('Connection error: down');
  });
});

describe('retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries 5xx with exponential backoff, then succeeds', async () => {
    const f = fakeFetch(
      json(500, err('internal_error')),
      json(503, err('gpu_unavailable')),
      json(200, state),
    );
    const r = await settle(client(f.fn).sessions.get('ses_1'));
    expect(r.value).toEqual(state);
    expect(f.calls).toHaveLength(3);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const f = fakeFetch(json(503, err('gpu_unavailable', 'busy')));
    const r = await settle(client(f.fn, { maxRetries: 3 }).sessions.get('a'));
    expect(r.error).toBeInstanceOf(ApiError);
    expect((r.error as ApiError).code).toBe('gpu_unavailable');
    expect(f.calls).toHaveLength(4);
  });

  it('a 503 with retry-after (maintenance) waits that long', async () => {
    const f = fakeFetch(json(503, err('maintenance'), { 'retry-after': '5' }), json(200, state));
    const p = client(f.fn).sessions.get('a');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual(state);
  });

  it('a 503 asking to wait longer than a minute is thrown at once, with retryAfter', async () => {
    const f = fakeFetch(json(503, err('maintenance'), { 'retry-after': '600' }));
    const r = await settle(client(f.fn).sessions.get('a'));
    expect(r.error).toMatchObject({ code: 'maintenance', retryAfter: 600 });
    expect(f.calls).toHaveLength(1);
  });

  it('a signal that is never aborted does not stop the retries', async () => {
    const f = fakeFetch(json(503, {}), json(200, state));
    const r = await settle(
      client(f.fn).sessions.get('a', { signal: new AbortController().signal }),
    );
    expect(r.value).toEqual(state);
    expect(f.calls).toHaveLength(2);
  });

  it('maxRetries per request overrides the client', async () => {
    const f = fakeFetch(json(500, {}));
    await settle(client(f.fn, { maxRetries: 5 }).sessions.get('a', { maxRetries: 0 }));
    expect(f.calls).toHaveLength(1);
  });

  it('retries network errors for GET and DELETE', async () => {
    const f = fakeFetch(
      new TypeError('ECONNRESET'),
      json(200, state),
      new TypeError('ECONNRESET'),
      json(200, { session_id: 'ses_1', status: 'ended' }),
    );
    const v = client(f.fn);
    expect((await settle(v.sessions.get('ses_1'))).value).toEqual(state);
    expect((await settle(v.sessions.end('ses_1'))).value).toMatchObject({ status: 'ended' });
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'DELETE', 'DELETE']);
  });

  it('retries create and speak with the same Idempotency-Key', async () => {
    const f = fakeFetch(
      new TypeError('ECONNRESET'),
      json(201, { session_id: 'ses_1' }),
      json(500, err('internal_error')),
      json(202, { utterance_id: 'utt_1' }),
    );
    const v = client(f.fn);
    expect((await settle(v.sessions.create({ avatar_id: 'avt_1' }))).value).toEqual({
      session_id: 'ses_1',
    });
    expect((await settle(v.sessions.speak('ses_1', 'hi'))).value).toEqual({
      utterance_id: 'utt_1',
    });
    const keys = f.calls.map((c) => c.headers['idempotency-key']);
    expect(keys[0]).toMatch(/^avacast-node-[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toMatch(/^avacast-node-/);
    expect(keys[3]).toBe(keys[2]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('does not retry interrupt on a 5xx or a network error', async () => {
    for (const reply of [json(500, {}), new TypeError('ECONNRESET')]) {
      const f = fakeFetch(reply);
      expect((await settle(client(f.fn).sessions.interrupt('ses_1'))).error).toBeInstanceOf(
        AvacastApiError,
      );
      expect(f.calls).toHaveLength(1);
    }
  });

  it('does not retry 4xx', async () => {
    for (const s of [400, 401, 402, 403, 404, 409, 422]) {
      const f = fakeFetch(json(s, err('x')));
      await settle(client(f.fn).sessions.get('a'));
      expect(f.calls).toHaveLength(1);
    }
  });

  it('429 rate_limited is retried for any request, waiting retry-after seconds', async () => {
    const f = fakeFetch(
      json(429, err('rate_limited', 'slow down'), { 'retry-after': '7' }),
      json(200, { interrupted_utterance_id: null, discarded_count: 0 }),
    );
    const p = client(f.fn).sessions.interrupt('ses_1');
    await vi.advanceTimersByTimeAsync(6_999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ interrupted_utterance_id: null, discarded_count: 0 });
    expect(f.calls).toHaveLength(2);
  });

  it('429 with an HTTP-date retry-after waits until that time', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const at = new Date(Date.now() + 3000).toUTCString();
    const f = fakeFetch(json(429, err('rate_limited'), { 'retry-after': at }), json(200, state));
    const p = client(f.fn).sessions.get('a');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(f.calls).toHaveLength(2);
  });

  it('429 without retry-after uses backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const f = fakeFetch(json(429, err('rate_limited')), json(200, state));
    const p = client(f.fn).sessions.get('a');
    await vi.advanceTimersByTimeAsync(499);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(f.calls).toHaveLength(2);
  });

  it('429 concurrency_limit and queue_full are thrown at once (they clear only when you act)', async () => {
    for (const code of ['concurrency_limit', 'queue_full']) {
      const f = fakeFetch(json(429, err(code)));
      const r = await settle(client(f.fn).sessions.speak('ses_1', 'x'));
      expect(r.error).toBeInstanceOf(RateLimitError);
      expect((r.error as RateLimitError).code).toBe(code);
      expect(f.calls).toHaveLength(1);
    }
    expect([...NOT_RETRIED_429]).toEqual(['concurrency_limit', 'queue_full']);
  });

  it('429 is thrown as RateLimitError with retryAfter once retries run out', async () => {
    const f = fakeFetch(json(429, err('rate_limited'), { 'retry-after': '1' }));
    const r = await settle(client(f.fn, { maxRetries: 1 }).sessions.get('a'));
    expect(r.error).toBeInstanceOf(RateLimitError);
    expect((r.error as RateLimitError).retryAfter).toBe(1);
    expect(f.calls).toHaveLength(2);
  });

  it('429 asking to wait longer than a minute is thrown at once', async () => {
    const f = fakeFetch(json(429, err('rate_limited'), { 'retry-after': '3600' }));
    const r = await settle(client(f.fn).sessions.get('a'));
    expect(r.error).toBeInstanceOf(RateLimitError);
    expect(f.calls).toHaveLength(1);
  });
});

describe('timeout and abort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('times out each attempt, retries safe requests, then throws TimeoutError', async () => {
    const f = fakeFetch(hang);
    const r = await settle(client(f.fn, { timeout: 1000, maxRetries: 1 }).sessions.get('a'));
    expect(r.error).toBeInstanceOf(TimeoutError);
    expect(r.error).toBeInstanceOf(ConnectionError);
    expect((r.error as Error).message).toBe('Request timed out after 1000 ms');
    expect(f.calls).toHaveLength(2);
  });

  it('timeout per request overrides the client; interrupt is not retried', async () => {
    const f = fakeFetch(hang);
    const r = await settle(
      client(f.fn, { timeout: 60_000 }).sessions.interrupt('ses_1', { timeout: 10 }),
    );
    expect(r.error).toBeInstanceOf(TimeoutError);
    expect(f.calls).toHaveLength(1);
  });

  it('a body that stalls also times out', async () => {
    const f = fakeFetch((c) => {
      const body = new ReadableStream({
        start(ctrl) {
          c.signal.addEventListener('abort', () =>
            ctrl.error(new DOMException('aborted', 'AbortError')),
          );
        },
      });
      return new Response(body, { status: 200 });
    });
    const r = await settle(client(f.fn, { timeout: 50, maxRetries: 0 }).sessions.get('a'));
    expect(r.error).toBeInstanceOf(TimeoutError);
  });

  it('an aborted signal stops the request and is not retried', async () => {
    const f = fakeFetch(hang);
    const ctrl = new AbortController();
    const p = settle(client(f.fn).sessions.get('a', { signal: ctrl.signal }));
    await Promise.resolve();
    ctrl.abort();
    const r = await p;
    expect(r.error).toBeInstanceOf(ConnectionError);
    expect(r.error).not.toBeInstanceOf(TimeoutError);
    expect((r.error as Error).message).toBe('Request was aborted');
    expect(f.calls).toHaveLength(1);
  });

  it('a signal aborted before the call never sends', async () => {
    const f = fakeFetch(hang);
    const r = await settle(client(f.fn).sessions.get('a', { signal: AbortSignal.abort() }));
    expect((r.error as Error).message).toBe('Request was aborted');
    expect(f.calls).toHaveLength(0);
  });

  it('aborting during the wait between retries stops retrying', async () => {
    const f = fakeFetch(json(503, {}));
    const ctrl = new AbortController();
    const p = client(f.fn)
      .sessions.get('a', { signal: ctrl.signal })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    ctrl.abort(new Error('stop'));
    const e = await p;
    expect(e).toBeInstanceOf(ConnectionError);
    expect(e.cause).toEqual(new Error('stop'));
    expect(f.calls).toHaveLength(1);
  });

  it('an error after the signal was aborted (without abort reaching fetch) is not retried', async () => {
    const ctrl = new AbortController();
    const f = fakeFetch(() => {
      ctrl.abort();
      return Promise.resolve(json(503, {}));
    });
    const r = await settle(client(f.fn).sessions.get('a', { signal: ctrl.signal }));
    expect(r.error).toBeInstanceOf(ApiError);
    expect(f.calls).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('backoff doubles from 500 ms up to 8 s with ±25% jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => backoff(n, () => 0.5))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
    expect(backoff(0, () => 0)).toBe(375);
    expect(backoff(0, () => 1)).toBe(625);
    expect(backoff(1)).toBeGreaterThanOrEqual(750);
  });

  it('retryAfterWait', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(retryAfterWait(h({ 'retry-after': '2' }), 0)).toBe(2000);
    expect(retryAfterWait(h({ 'retry-after': '0.4' }), 0)).toBe(400);
    expect(retryAfterWait(h({ 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' }), 1000)).toBe(4000);
    expect(retryAfterWait(h({ 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' }), 9000)).toBe(0);
    expect(retryAfterWait(h({ 'retry-after': 'soon' }), 0)).toBeUndefined();
    expect(retryAfterWait(h({ 'retry-after': '-3' }), 0)).toBe(0);
    expect(retryAfterWait(h({ 'retry-after': ' ' }))).toBeUndefined();
    expect(retryAfterWait(h({}))).toBeUndefined();
    expect(MAX_RETRY_AFTER_MS).toBe(60_000);
  });

  it('empty responses resolve to undefined', async () => {
    const f = fakeFetch(empty(204));
    expect(await client(f.fn).sessions.end('ses_1')).toBeUndefined();
  });
});
