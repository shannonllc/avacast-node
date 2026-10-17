/**
 * SDK が投げるイベント。
 *
 * 名前はほかのアバターの SDK でよく使われる形に寄せてある。移行してくる人が
 * イベント名の置換だけで済むようにするため。
 */
export const SessionEvent = {
  /** 映像が届きはじめた。attach() してよい合図。 */
  STREAM_READY: 'session.ready',
  /** 切断された。理由は payload.reason。 */
  DISCONNECTED: 'session.ended',
  /** 回復不能なエラー。 */
  ERROR: 'error',
} as const;

export const SpeakEvent = {
  /** 発話がはじまった。 */
  SPEAK_STARTED: 'speak.started',
  /** 発話が終わった。**次の発話や次の質問を出す合図はこれ。** */
  SPEAK_ENDED: 'speak.ended',
  /** 中断された。 */
  SPEAK_INTERRUPTED: 'speak.interrupted',
  /**
   * キューが空になった (話し終えて、次に話す発話も無い)。「アバターが話し終えた」の合図はこれ。
   * speak.ended は 1 文ごとに来るので、文と文の間で「話し終えた」と取り違えないこと。
   */
  QUEUE_DRAINED: 'queue.drained',
} as const;

export type EventName =
  | (typeof SessionEvent)[keyof typeof SessionEvent]
  | (typeof SpeakEvent)[keyof typeof SpeakEvent];

export type EventPayloadMap = {
  'session.ready': { sessionId: string };
  'session.ended': { reason: string };
  error: { code: string; message: string };
  'speak.started': { utteranceId: string; text?: string };
  'speak.ended': { utteranceId: string; durationMs: number };
  'speak.interrupted': { utteranceId: string; spokenMs: number };
  'queue.drained': Record<string, never>;
};

type Handler<E extends EventName> = (payload: EventPayloadMap[E]) => void;

/**
 * 最小限のイベント発行。
 *
 * ハンドラが投げた例外で SDK 全体を止めない。顧客のコールバックの
 * 不具合が、映像の切断や発話の停止に波及すると原因が分かりにくくなる。
 */
export class Emitter {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  on<E extends EventName>(event: E, handler: Handler<E>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: unknown) => void);
    this.handlers.set(event, set);
    // 解除用の関数を返す。React の useEffect からそのまま返せる形にしておく。
    return () => this.off(event, handler);
  }

  off<E extends EventName>(event: E, handler: Handler<E>): void {
    this.handlers.get(event)?.delete(handler as (payload: unknown) => void);
  }

  emit<E extends EventName>(event: E, payload: EventPayloadMap[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[avacast] handler for "${event}" threw`, e);
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
