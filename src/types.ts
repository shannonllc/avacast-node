// /v1 のリクエストと応答の形（https://avacast.jp/docs）。日時は ISO 8601（UTC）の文字列
import type { Language, VoiceId } from './voices';

/** Per-request options. */
export interface RequestOptions {
  /** Milliseconds per attempt. Overrides the client's `timeout`. */
  timeout?: number;
  /** Retries after the first attempt. Overrides the client's `maxRetries`. */
  maxRetries?: number;
  /** Aborts the request (and the wait between retries). */
  signal?: AbortSignal;
}

/** Options for requests that accept an `Idempotency-Key` (`sessions.create`, `sessions.speak`). */
export interface IdempotentRequestOptions extends RequestOptions {
  /**
   * Up to 255 characters. The same key returns the recorded response instead of running the request again.
   * Generated when omitted, and reused across retries.
   */
  idempotencyKey?: string;
}

export interface SessionVoice {
  /** Speaking language. Default `ja`. Unsupported values are read as `ja`. */
  language?: Language;
  /** Voice ID such as `female-30s-clear`. Default: the avatar's voice. */
  voice_id?: VoiceId;
  /** Speaking rate, 0.8 to 1.2. Default 1.0. Values out of range are clamped. */
  speed?: number;
}

export interface SessionCreateParams {
  /** The avatar to use (`avt_…`). */
  avatar_id: string;
  voice?: SessionVoice;
  /** Seconds without speaking before the session closes, 30 to 1800. Default 180. */
  idle_timeout_seconds?: number;
  /** Your own labels, for example to split usage by `metadata.<key>`. */
  metadata?: Record<string, unknown>;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SessionWebRtc {
  signaling_url: string;
  /** Server-sent events for speech. Open it with `?token=<client_token>`; the browser SDK does this for you. */
  events_url: string;
  ice_servers: IceServer[];
}

/** `POST /v1/sessions`. Pass only `client_token` and `webrtc` to the browser, never the API key. */
export interface Session {
  session_id: string;
  client_token: string;
  webrtc: SessionWebRtc;
  /** When the session closes at the latest (the plan's longest session). */
  expires_at: string;
}

/** Why a session ended. `gpu_failure` means it ended because of a failure on avacast's side. */
export type SessionEndReason =
  | 'closed_by_api'
  | 'expired'
  | 'idle'
  | 'disconnected'
  | 'gpu_failure'
  | (string & {});

/** `GET /v1/sessions/:id`. */
export interface SessionState {
  session_id: string;
  status: 'active' | 'ended';
  end_reason: SessionEndReason | null;
  avatar_id: string;
  language: string;
  /** Lines waiting or being spoken. */
  queue_length: number;
  /** What you are billed for. Counts up to now while the session is open. */
  connected_seconds: number;
  /** Total speaking time in milliseconds (for reference, not billed). */
  total_speak_ms: number;
  started_at: string;
  ended_at: string | null;
  expires_at: string;
}

/** `DELETE /v1/sessions/:id`. */
export interface EndedSession {
  session_id: string;
  status: 'ended';
  connected_seconds: number;
  total_speak_ms: number;
}

/** `POST /v1/sessions/:id/speak`. */
export interface Utterance {
  utterance_id: string;
  status: 'queued';
  queue_length: number;
}

/** `POST /v1/sessions/:id/interrupt`. */
export interface InterruptResult {
  /** The line that was being spoken, or null when nothing was. */
  interrupted_utterance_id: string | null;
  /** Lines removed from the queue. */
  discarded_count: number;
}

/** An avatar from `GET /v1/avatars`. */
export interface Avatar {
  id: string;
  name: string;
  thumbnail_url: string | null;
  languages: string[];
  /** True for avatars provided by avacast; false for the ones you made. */
  is_preset: boolean;
}

export interface List<T> {
  data: T[];
}

export interface UsagePeriod {
  start: string;
  end: string;
}

/** `GET /v1/usage` without parameters: this month (UTC). */
export interface MonthlyUsage {
  period: UsagePeriod;
  /** What you are billed for. Includes open sessions. */
  connected_seconds: number;
  total_speak_seconds: number;
  session_count: number;
  utterance_count: number;
  limits: {
    concurrency: number;
    /** When reached, creating a session fails with 402 `payment_required`. Null for no limit. */
    monthly_connected_seconds: number | null;
  };
}

export interface UsageRangeParams {
  /** Start of the period: an ISO 8601 date-time with a time zone, or a Date. Default: the start of this month (UTC). */
  from?: string | Date;
  /** End of the period (not included). Default: now. Up to 366 days after `from`. */
  to?: string | Date;
  /** `metadata.<key>`, such as `metadata.tenant`. The key is letters, digits, `_` and `-`, up to 64 characters. */
  group_by?: `metadata.${string}`;
}

export interface UsageGroup {
  /** The metadata value, or null for sessions without the key. */
  key: string | null;
  connected_seconds: number;
  session_count: number;
}

/** `GET /v1/usage` with `from`, `to` or `group_by`. Sessions across the edges count only the part inside. */
export interface RangeUsage {
  period: UsagePeriod;
  connected_seconds: number;
  /** Sessions that started in the period. */
  session_count: number;
  /** Present with `group_by`. */
  group_by?: string;
  /** Present with `group_by`: one row per metadata value, most connected first. */
  data?: UsageGroup[];
}

/** `GET /v1/status`. */
export interface Status {
  ok: boolean;
}

/** Error codes of the API (`error.code`). Branch on these, not on the message. */
export type ErrorCode =
  | 'invalid_request'
  | 'invalid_api_key'
  | 'invalid_client_token'
  | 'payment_required'
  | 'not_found'
  | 'session_not_found'
  | 'avatar_not_found'
  | 'session_ended'
  | 'session_not_connected'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'concurrency_limit'
  | 'queue_full'
  | 'gpu_unavailable'
  | 'maintenance'
  | 'internal_error'
  | (string & {});
