import { describe, expect, it, vi } from 'vitest';
import { SpeakEvent } from './events';
import { AvacastError, AvacastSession } from './session';
import type { Transport } from './transport';

function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

const validToken = () => makeToken({ sub: 'ses_test', exp: Math.floor(Date.now() / 1000) + 600 });

/** 接続層のダミー。WebRTC を使わずにセッションの流れだけを見る。 */
function fakeTransport(): Transport & { connected: boolean; closed: boolean } {
  return {
    connected: false,
    closed: false,
    async connect() {
      this.connected = true;
    },
    attach() {},
    async close() {
      this.closed = true;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AvacastSession の生成', () => {
  it('トークンからセッション ID を取り出す', () => {
    const s = new AvacastSession(validToken(), { transport: fakeTransport() });
    expect(s.sessionId).toBe('ses_test');
  });

  it('壊れたトークンは即座に落とす', () => {
    expect(() => new AvacastSession('garbage')).toThrow(AvacastError);
  });

  it('期限切れのトークンは繋ぎにいく前に落とす', () => {
    // 繋ぎにいっても必ず 401 になる。出る前に気づかせる。
    const expired = makeToken({ sub: 'ses_x', exp: Math.floor(Date.now() / 1000) - 10 });
    expect(() => new AvacastSession(expired)).toThrow(/有効期限/);
  });
});

describe('start / stop', () => {
  it('start で接続し、stop で切断する', async () => {
    const t = fakeTransport();
    const s = new AvacastSession(validToken(), { transport: t });
    await s.start();
    expect(t.connected).toBe(true);
    await s.stop();
    expect(t.closed).toBe(true);
  });

  it('start を 2 回呼んでも二重に接続しない', async () => {
    const t = fakeTransport();
    const connect = vi.spyOn(t, 'connect');
    const s = new AvacastSession(validToken(), { transport: t });
    await s.start();
    await s.start();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('stop 後に start すると落とす', async () => {
    const s = new AvacastSession(validToken(), { transport: fakeTransport() });
    await s.start();
    await s.stop();
    await expect(s.start()).rejects.toThrow(/終了/);
  });
});

describe('speak / interrupt', () => {
  it('クライアントトークンで発話 API を叩く', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ utterance_id: 'utt_1', status: 'queued', queue_length: 2 }),
    );
    const token = validToken();
    const s = new AvacastSession(token, {
      transport: fakeTransport(),
      apiBaseUrl: 'https://api.example.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await s.speak('こんにちは');
    expect(result).toEqual({ utteranceId: 'utt_1', queueLength: 2 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/client/sessions/ses_test/speak');
    // API キーではなくクライアントトークンを使う
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(init.body as string)).toEqual({ text: 'こんにちは' });
  });

  it('前の発話の完了を待たずに連続で呼べる（キューはサーバーが持つ）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ utterance_id: 'u', queue_length: 1 }));
    const s = new AvacastSession(validToken(), {
      transport: fakeTransport(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await Promise.all([s.speak('1'), s.speak('2'), s.speak('3')]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('サーバーのエラーコードをそのまま伝える', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'queue_full', message: 'Utterance queue is full.' } }, 429),
    );
    const s = new AvacastSession(validToken(), {
      transport: fakeTransport(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(s.speak('x')).rejects.toMatchObject({ code: 'queue_full' });
  });

  it('interrupt は破棄件数を返す', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ discarded_count: 3 }));
    const s = new AvacastSession(validToken(), {
      transport: fakeTransport(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await s.interrupt()).toEqual({ discardedCount: 3 });
  });
});

describe('イベント', () => {
  it('購読と解除ができる', async () => {
    const s = new AvacastSession(validToken(), { transport: fakeTransport() });
    const fn = vi.fn();
    const off = s.on(SpeakEvent.SPEAK_ENDED, fn);
    off();
    await s.stop();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('isSpeaking', () => {
  it('started で話し中、ended・interrupted・queue.drained で空く', () => {
    const s = new AvacastSession(validToken(), { transport: fakeTransport() });
    // biome-ignore lint/suspicious/noExplicitAny: 接続層の代わりに知らせを流す
    const emit = (s as any).emitter.emit.bind((s as any).emitter);
    expect(s.isSpeaking).toBe(false);
    emit(SpeakEvent.SPEAK_STARTED, { utteranceId: 'u1' });
    expect(s.isSpeaking).toBe(true);
    // 別の発話の終わりでは空かない
    emit(SpeakEvent.SPEAK_INTERRUPTED, { utteranceId: 'u0', spokenMs: 0 });
    expect(s.isSpeaking).toBe(true);
    emit(SpeakEvent.SPEAK_ENDED, { utteranceId: 'u1', durationMs: 900 });
    expect(s.isSpeaking).toBe(false);
    emit(SpeakEvent.SPEAK_STARTED, { utteranceId: 'u2' });
    emit(SpeakEvent.QUEUE_DRAINED, {});
    expect(s.isSpeaking).toBe(false);
  });
});

describe('ほかの分岐', () => {
  it('signalingUrl が無ければ start で落とす (接続層を差し込まないとき)', async () => {
    const s = new AvacastSession(validToken());
    await expect(s.start()).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('attach は start の前でも後でも接続層に渡す', async () => {
    const t = fakeTransport();
    const attach = vi.spyOn(t, 'attach');
    const s = new AvacastSession(validToken(), { transport: t });
    const el = {} as HTMLMediaElement;
    s.attach(el);
    expect(attach).not.toHaveBeenCalled();
    await s.start();
    expect(attach).toHaveBeenCalledWith(el);
    s.attach(el);
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it('接続の失敗は error を出して connect_failed で落とし、もう一度 start できる', async () => {
    const t = fakeTransport();
    let n = 0;
    t.connect = async () => {
      n++;
      if (n === 1) throw new Error('no media');
      if (n === 2) throw 'down';
    };
    const s = new AvacastSession(validToken(), { transport: t });
    const onError = vi.fn();
    s.on('error', onError);
    await expect(s.start()).rejects.toMatchObject({ code: 'connect_failed', message: 'no media' });
    await expect(s.start()).rejects.toMatchObject({ code: 'connect_failed', message: 'down' });
    await s.start();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('off で解除できる', () => {
    const s = new AvacastSession(validToken(), { transport: fakeTransport() });
    const fn = vi.fn();
    s.on(SpeakEvent.SPEAK_ENDED, fn);
    s.off(SpeakEvent.SPEAK_ENDED, fn);
    // biome-ignore lint/suspicious/noExplicitAny: 接続層の代わりに知らせを流す
    (s as any).emitter.emit(SpeakEvent.SPEAK_ENDED, { utteranceId: 'u', durationMs: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('エラーに状態コードと x-request-id を付け、形の違う本文は unknown と HTTP の状態にする', async () => {
    const replies = [
      new Response(JSON.stringify({ error: { code: 'session_ended', message: 'ended' } }), {
        status: 409,
        headers: { 'x-request-id': 'req_1' },
      }),
      new Response('<html>', { status: 502 }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift() as Response);
    const s = new AvacastSession(validToken(), {
      transport: fakeTransport(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const e = await s.speak('x').catch((x) => x);
    expect(e).toBeInstanceOf(AvacastError);
    expect(e).toMatchObject({
      code: 'session_ended',
      message: 'ended',
      status: 409,
      requestId: 'req_1',
    });
    expect(await s.interrupt().catch((x) => x)).toMatchObject({
      code: 'unknown',
      message: 'HTTP 502',
      status: 502,
      requestId: undefined,
    });
  });

  it('応答に値が無ければ空と 0 にする', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const s = new AvacastSession(validToken(), {
      transport: fakeTransport(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await s.speak('x')).toEqual({ utteranceId: '', queueLength: 0 });
    expect(await s.interrupt()).toEqual({ discardedCount: 0 });
  });

  it('fetch の既定は globalThis.fetch', async () => {
    const f = vi.fn(async () => jsonResponse({ discarded_count: 1 }));
    vi.stubGlobal('fetch', f);
    try {
      const s = new AvacastSession(validToken(), {
        transport: fakeTransport(),
        apiBaseUrl: 'https://api.example.test/',
      });
      expect(await s.interrupt()).toEqual({ discardedCount: 1 });
      expect((f.mock.calls[0] as unknown as [string])[0]).toBe(
        'https://api.example.test/v1/client/sessions/ses_test/interrupt',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('AvacastError は cause を持てる', () => {
    const cause = new Error('c');
    expect(new AvacastError('x', 'm', { cause }).cause).toBe(cause);
    expect(new AvacastError('x', 'm').cause).toBeUndefined();
  });

  it('stop は接続していなくても落ちない', async () => {
    await new AvacastSession(validToken()).stop();
  });
});
