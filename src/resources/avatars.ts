import type { Http } from '../http';
import type { Avatar, List, RequestOptions } from '../types';

/** Avatars you can use (`/v1/avatars`). */
export class Avatars {
  /** @internal */
  constructor(private readonly http: Http) {}

  /** Lists the preset avatars and the ones you made, all at once. */
  list(options?: RequestOptions): Promise<List<Avatar>> {
    return this.http.request({ method: 'GET', path: '/v1/avatars', idempotent: true }, options);
  }
}
