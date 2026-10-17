import { Emitter, type EventName, type EventPayloadMap } from './events.js';
import { isExpired, readClientToken } from './token.js';
import { type Transport, WebRtcTransport } from './transport.js';

/**
 * avacast のセッション。
 *
 * 使い方:
 *
 * ```ts
 * // client_token と webrtc は POST /v1/sessions のレスポンスから
 * const session = new AvacastSession(client_token, {
 *   signalingUrl: webrtc.signaling_url,
 *   iceServers: webrtc.ice_servers,
 * });
 * session.attach(videoEl);
 * // 映像が届いてから喋らせる。届く前の speak は 409 になる
 * session.on(SessionEvent.STREAM_READY, () => session.speak('ご相談ありがとうございます。'));
 * session.on(SpeakEvent.SPEAK_ENDED, () => askNextQuestion());
 * await session.start();
 * ```
 *
 * **発話キューはサーバーが持つ。** 前の発話の完了を待たずに speak() を
 * 呼んでよい。順番に読み上げられる。
 */

export type AvacastSessionOptions = {
  /** API のベース URL。既定は本番。 */
  apiBaseUrl?: string;
  /** シグナリング URL。セッション作成のレスポンスの webrtc.signaling_url。 */
  signalingUrl?: string;
  /** STUN / TURN。セッション作成のレスポンスの webrtc.ice_servers をそのまま渡す。 */
  iceServers?: RTCIceServer[];
  /** 発話イベントの SSE。セッション作成のレスポンスの webrtc.events_url。省略可 */
  eventsUrl?: string;
  /** テスト用に接続層を差し替える。 */
  transport?: Transport;
  /** fetch を差し替える（テスト用）。 */
  fetchImpl?: typeof fetch;
};

const DEFAULT_API_BASE = 'https://api.avacast.jp';

export type AvacastErrorOptions = {
  /** HTTP の状態コード。応答が無かったときは undefined */
  status?: number;
  /** 呼び出しの ID (応答の x-request-id)。問い合わせのときに伝える */
  requestId?: string;
  cause?: unknown;
};

/**
 * SDK が投げるエラーの元。ブラウザの AvacastSession も、サーバーの Avacast (avacast の本体) もこれを投げる。
 * code は API の error.code (invalid_client_token・queue_full など)。API の応答でないときは SDK の値か空文字
 */
export class AvacastError extends Error {
  readonly code: string;
  /** HTTP の状態コード。応答が無かったときは undefined */
  readonly status: number | undefined;
  /** 呼び出しの ID (応答の x-request-id) */
  readonly requestId: string | undefined;
  constructor(code: string, message: string, options: AvacastErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AvacastError';
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

export class AvacastSession {
  readonly sessionId: string;

  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly emitter = new Emitter();
  private readonly fetchImpl: typeof fetch;
  private readonly makeTransport: () => Transport;

  private transport: Transport | null = null;
  private element: HTMLMediaElement | null = null;
  private started = false;
  private stopped = false;
  /** 話している発話の ID。speak.started で入り、ended / interrupted / queue.drained で空く */
  private speakingId: string | null = null;

  constructor(clientToken: string, options: AvacastSessionOptions = {}) {
    const info = readClientToken(clientToken);
    if (!info) {
      throw new AvacastError('invalid_client_token', 'クライアントトークンの形式が不正です。');
    }
    // 期限切れのトークンで繋ぎにいくと必ず 401 になる。出る前に気づかせる。
    if (isExpired(info)) {
      throw new AvacastError(
        'invalid_client_token',
        'クライアントトークンの有効期限が切れています。サーバーで作り直してください。',
      );
    }

    // 話しているかを覚える。サーバーは、どの発話にも started→ended か interrupted を、キューが空になれば
    // queue.drained を必ず送る (取り消しと入れ違いに始まった発話の知らせは送らない)
    this.emitter.on('speak.started', ({ utteranceId }) => {
      this.speakingId = utteranceId;
    });
    const settle = ({ utteranceId }: { utteranceId: string }) => {
      if (this.speakingId === utteranceId) this.speakingId = null;
    };
    this.emitter.on('speak.ended', settle);
    this.emitter.on('speak.interrupted', settle);
    this.emitter.on('queue.drained', () => {
      this.speakingId = null;
    });

    this.token = clientToken;
    this.sessionId = info.sessionId;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

    this.makeTransport = () =>
      options.transport ??
      new WebRtcTransport({
        signalingUrl:
          options.signalingUrl ??
          (() => {
            throw new AvacastError(
              'invalid_request',
              'signalingUrl が指定されていません。セッション作成のレスポンスに含まれる webrtc.signaling_url を渡してください。',
            );
          })(),
        clientToken,
        eventsUrl: options.eventsUrl,
        iceServers: options.iceServers,
        emitter: this.emitter,
      });
  }

  /**
   * アバターがいま話しているか。半二重 (アバターが話している間はマイクを止める) の判定に使う。
   * 次の文が控えているかは queue.drained で分かる (話し終えて、キューも空になった合図)
   */
  get isSpeaking(): boolean {
    return this.speakingId !== null;
  }

  /** イベントを購読する。戻り値を呼ぶと解除できる。 */
  on<E extends EventName>(event: E, handler: (payload: EventPayloadMap[E]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  off<E extends EventName>(event: E, handler: (payload: EventPayloadMap[E]) => void): void {
    this.emitter.off(event, handler);
  }

  /** 映像・音声を <video> 要素に結びつける。start() の前後どちらで呼んでもよい。 */
  attach(element: HTMLMediaElement): void {
    this.element = element;
    this.transport?.attach(element);
  }

  /** 接続する。 */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new AvacastError('session_ended', 'このセッションは既に終了しています。');
    }
    if (this.started) return;
    this.started = true;

    this.transport = this.makeTransport();
    if (this.element) this.transport.attach(this.element);

    try {
      await this.transport.connect();
    } catch (e) {
      this.started = false;
      const message = e instanceof Error ? e.message : String(e);
      this.emitter.emit('error', { code: 'connect_failed', message });
      throw new AvacastError('connect_failed', message);
    }
  }

  /**
   * 喋らせる。
   *
   * 前の発話の完了を待つ必要はない。キューはサーバーが持っており、
   * 順番に読み上げられる。
   */
  async speak(text: string): Promise<{ utteranceId: string; queueLength: number }> {
    const body = await this.post(`/v1/client/sessions/${this.sessionId}/speak`, { text });
    return {
      utteranceId: String(body.utterance_id ?? ''),
      queueLength: Number(body.queue_length ?? 0),
    };
  }

  /** 発話を止め、キューの未再生分を破棄する。 */
  async interrupt(): Promise<{ discardedCount: number }> {
    const body = await this.post(`/v1/client/sessions/${this.sessionId}/interrupt`, {});
    return { discardedCount: Number(body.discarded_count ?? 0) };
  }

  /**
   * 接続を切る。
   *
   * セッション自体の終了はサーバー側の役目で、
   * 顧客のサーバーが DELETE /v1/sessions/:id を呼ぶか、
   * アイドル打ち切りで自動的に閉じられる。
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    try {
      await this.transport?.close();
    } finally {
      this.transport = null;
      this.emitter.removeAll();
    }
  }

  private async post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // API キーではなくクライアントトークン。1 セッションにしか効かない。
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(payload),
    });

    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    } & Record<string, unknown>;

    if (!res.ok) {
      const code = json.error?.code ?? 'unknown';
      const message = json.error?.message ?? `HTTP ${res.status}`;
      throw new AvacastError(code, message, {
        status: res.status,
        requestId: res.headers.get('x-request-id') ?? undefined,
      });
    }
    return json;
  }
}
