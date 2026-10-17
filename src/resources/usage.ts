import { AvacastApiError } from '../errors';
import type { Http } from '../http';
import type { MonthlyUsage, RangeUsage, RequestOptions, UsageRangeParams } from '../types';

const time = (v: string | Date | undefined): string | undefined =>
  v instanceof Date ? v.toISOString() : v || undefined;

/** Connected time and sessions (`/v1/usage`). */
export class Usage {
  /** @internal */
  constructor(private readonly http: Http) {}

  /** This month (UTC) with your limits. */
  get(options?: RequestOptions): Promise<MonthlyUsage> {
    return this.http.request({ method: 'GET', path: '/v1/usage', idempotent: true }, options);
  }

  /**
   * A period of your choice, optionally split by a metadata key (`group_by: 'metadata.tenant'`).
   * Pass at least one of `from`, `to` and `group_by`.
   */
  range(params: UsageRangeParams, options?: RequestOptions): Promise<RangeUsage> {
    const query = {
      from: time(params.from),
      to: time(params.to),
      group_by: params.group_by || undefined,
    };
    if (query.from === undefined && query.to === undefined && query.group_by === undefined) {
      return Promise.reject(
        new AvacastApiError(
          'usage.range needs from, to or group_by. Use usage.get() for this month.',
        ),
      );
    }
    return this.http.request(
      { method: 'GET', path: '/v1/usage', query, idempotent: true },
      options,
    );
  }
}
