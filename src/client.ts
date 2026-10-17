import { AvacastApiError } from './errors';
import { type Fetch, Http } from './http';
import { Avatars } from './resources/avatars';
import { Sessions } from './resources/sessions';
import { Usage } from './resources/usage';
import { readEnv } from './runtime';
import type { RequestOptions, Status } from './types';

export const DEFAULT_BASE_URL = 'https://api.avacast.jp';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const API_KEY_ENV = 'AVACAST_API_KEY';

export interface ClientOptions {
  /** Default `https://api.avacast.jp`. */
  baseUrl?: string;
  /** Milliseconds per attempt. Default 30000. */
  timeout?: number;
  /** Retries after the first attempt. Default 2. `0` disables retries. */
  maxRetries?: number;
  /** Custom `fetch`. Default `globalThis.fetch`. */
  fetch?: Fetch;
}

/** Client for the avacast API (`/v1`). Use it on your server only: never ship the API key to a browser. */
export class Avacast {
  readonly sessions: Sessions;
  readonly avatars: Avatars;
  readonly usage: Usage;
  readonly baseUrl: string;
  private readonly http: Http;

  /**
   * @param apiKey `sk_live_…` or `sk_test_…`. Defaults to the `AVACAST_API_KEY` environment variable.
   */
  constructor(apiKey?: string, options: ClientOptions = {}) {
    const key = apiKey ?? readEnv(API_KEY_ENV);
    if (!key)
      throw new AvacastApiError(
        `Missing API key. Pass it to new Avacast('sk_…') or set ${API_KEY_ENV}.`,
      );
    const f = options.fetch ?? (globalThis as { fetch?: Fetch }).fetch;
    if (!f)
      throw new AvacastApiError(
        'fetch is not available. Use Node.js 18 or later, or pass options.fetch.',
      );
    this.http = new Http({
      apiKey: key,
      baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      // 素の fetch を this なしで呼ぶと、実行環境によっては Illegal invocation になる
      fetch: options.fetch ?? ((input, init) => f(input, init)),
    });
    this.baseUrl = this.http.config.baseUrl;
    this.sessions = new Sessions(this.http);
    this.avatars = new Avatars(this.http);
    this.usage = new Usage(this.http);
  }

  /** `GET /v1/status`: whether the API is responding. */
  status(options?: RequestOptions): Promise<Status> {
    return this.http.request({ method: 'GET', path: '/v1/status', idempotent: true }, options);
  }
}
