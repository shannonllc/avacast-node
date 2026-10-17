// avacast: サーバーの Avacast（API キーで /v1 を呼ぶ）と、ブラウザの AvacastSession（avacast/web と同じもの）
export {
  API_KEY_ENV,
  Avacast,
  type ClientOptions,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
} from './client';
export {
  ApiError,
  AuthenticationError,
  AvacastApiError,
  ConflictError,
  ConnectionError,
  type ErrorOptions,
  NotFoundError,
  PaymentRequiredError,
  PermissionError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from './errors';
export type { Fetch } from './http';
export type { Avatars } from './resources/avatars';
export type { Sessions } from './resources/sessions';
export type { Usage as UsageResource } from './resources/usage';
export type * from './types';
export { VERSION } from './version';
export { LANGUAGES, type Language, VOICE_IDS, type VoiceId } from './voices';
export * from './web';
