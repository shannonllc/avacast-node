// 声の ID と言語（API の値。docs の「セッションの作成」と同じ）

/** Voice IDs for `voice.voice_id`: `<gender>-standard` or `<gender>-<decade>s-<tone>`. */
export const VOICE_IDS = [
  'female-standard',
  'female-20s-bright',
  'female-30s-clear',
  'female-30s-soft',
  'female-40s-warm',
  'female-50s-calm',
  'female-60s-gentle',
  'male-standard',
  'male-20s-bright',
  'male-30s-clear',
  'male-30s-friendly',
  'male-40s-calm',
  'male-50s-calm',
  'male-60s-deep',
] as const;

/** A voice ID from {@link VOICE_IDS}. Other strings are accepted for forward compatibility. */
export type VoiceId = (typeof VOICE_IDS)[number] | (string & {});

/** Languages for `voice.language`. Other values are read as `ja`. */
export const LANGUAGES = ['ja', 'en', 'zh', 'th', 'es', 'vi', 'pt', 'it', 'sk'] as const;

/** A language from {@link LANGUAGES}. */
export type Language = (typeof LANGUAGES)[number] | (string & {});
