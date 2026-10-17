// 偽の fetch。呼ばれた内容を記録し、用意した応答を順に返す。
import { vi } from 'vitest';
import { Avacast, type ClientOptions } from '../src/index';

export type Call = {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
};

type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/** replies は順に使い、最後の 1 つは使い切った後も返し続ける */
export function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string, init: RequestInit) => {
    const call: Call = {
      url: new URL(input),
      method: init.method as string,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal as AbortSignal,
    };
    calls.push(call);
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(call);
    return (r as Response).clone();
  });
  return { fn, calls };
}

export function client(fetch: ReturnType<typeof fakeFetch>['fn'], options: ClientOptions = {}) {
  return new Avacast('sk_test_abc', { baseUrl: 'https://api.test', fetch, ...options });
}

/** fetch that waits until the request is aborted */
export function hang(call: Call): Promise<Response> {
  return new Promise((_, reject) => {
    call.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}
