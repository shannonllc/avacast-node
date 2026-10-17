// WebRtcTransport を偽の RTCPeerConnection・MediaStream・EventSource・document で動かす (Node の中で流れを確かめる)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from './events';
import { WebRtcTransport } from './transport';

type Listener = () => void;

class FakeTrack {
  stopped = false;
  constructor(readonly kind: 'video' | 'audio') {}
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks: FakeTrack[] = [];
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  getTracks() {
    return this.tracks;
  }
}

class FakePc {
  static last: FakePc | null = null;
  static gathering: RTCIceGatheringState = 'complete';
  config: RTCConfiguration;
  transceivers: [string, unknown][] = [];
  ontrack: ((e: { track: FakeTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  iceConnectionState = 'checking';
  iceGatheringState: RTCIceGatheringState = FakePc.gathering;
  localDescription: { sdp: string; type: string } | null = null;
  remote: unknown = null;
  closed = false;
  listeners = new Map<string, Set<Listener>>();
  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePc.last = this;
  }
  addTransceiver(kind: string, init: unknown) {
    this.transceivers.push([kind, init]);
  }
  async createOffer() {
    return { sdp: 'v=0 offer', type: 'offer' };
  }
  async setLocalDescription(d: { sdp: string; type: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: unknown) {
    this.remote = d;
  }
  addEventListener(name: string, fn: Listener) {
    const s = this.listeners.get(name) ?? new Set();
    s.add(fn);
    this.listeners.set(name, s);
  }
  removeEventListener(name: string, fn: Listener) {
    this.listeners.get(name)?.delete(fn);
  }
  fire(name: string) {
    for (const fn of this.listeners.get(name) ?? []) fn();
  }
  close() {
    this.closed = true;
  }
}

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close() {
    this.closed = true;
  }
  send(data: unknown) {
    this.onmessage?.({ data });
  }
}

class FakeVideo {
  srcObject: unknown = null;
  muted = false;
  plays = 0;
  playImpl: (el: FakeVideo) => Promise<void> = async () => {};
  play() {
    this.plays++;
    return this.playImpl(this);
  }
}

class FakeDocument {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(name: string, fn: Listener) {
    const s = this.listeners.get(name) ?? new Set();
    s.add(fn);
    this.listeners.set(name, s);
  }
  removeEventListener(name: string, fn: Listener) {
    this.listeners.get(name)?.delete(fn);
  }
  fire(name: string) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) fn();
  }
  count() {
    return [...this.listeners.values()].reduce((a, s) => a + s.size, 0);
  }
}

const answer = { sdp: 'v=0 answer', type: 'answer' };
let fetchMock: ReturnType<typeof vi.fn>;

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
}

beforeEach(() => {
  FakePc.last = null;
  FakePc.gathering = 'complete';
  FakeEventSource.last = null;
  vi.stubGlobal('RTCPeerConnection', FakePc);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('EventSource', FakeEventSource);
  fetchMock = okFetch();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function transport(opts: Partial<ConstructorParameters<typeof WebRtcTransport>[0]> = {}) {
  const emitter = new Emitter();
  const t = new WebRtcTransport({
    signalingUrl: 'https://node.test/s/offer',
    clientToken: 'tok en',
    emitter,
    ...opts,
  });
  return { t, emitter };
}

/** connect を始めて、ontrack が付くまで進める */
async function connecting(t: WebRtcTransport): Promise<{ done: Promise<void> }> {
  const done = t.connect();
  await vi.waitFor(() => expect(FakePc.last?.remote).not.toBeNull());
  return { done };
}

const sendVideo = () => FakePc.last!.ontrack!({ track: new FakeTrack('video') });
const sendAudio = () => FakePc.last!.ontrack!({ track: new FakeTrack('audio') });

describe('connect', () => {
  it('sends the offer with the client token, waits for video, then opens the events', async () => {
    const { t, emitter } = transport({
      iceServers: [{ urls: 'turn:t', username: 'u', credential: 'c' }],
    });
    const ready = vi.fn();
    emitter.on('session.ready', ready);
    const { done: p } = await connecting(t);
    sendAudio();
    expect(ready).not.toHaveBeenCalled();
    sendVideo();
    await p;
    expect(ready).toHaveBeenCalledWith({ sessionId: '' });
    const pc = FakePc.last!;
    expect(pc.config.iceServers).toEqual([{ urls: 'turn:t', username: 'u', credential: 'c' }]);
    expect(pc.transceivers).toEqual([
      ['video', { direction: 'recvonly' }],
      ['audio', { direction: 'recvonly' }],
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://node.test/s/offer');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok en');
    expect(JSON.parse(init.body as string)).toEqual({ sdp: 'v=0 offer', type: 'offer' });
    expect(pc.remote).toEqual(answer);
    expect(FakeEventSource.last!.url).toBe('https://node.test/s/events?token=tok%20en');
  });

  it('uses STUN when there are no ICE servers, and eventsUrl when given (with a query)', async () => {
    const { t } = transport({ iceServers: [], eventsUrl: 'https://node.test/ev?x=1' });
    const { done: p } = await connecting(t);
    sendVideo();
    await p;
    expect(FakePc.last!.config.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    expect(FakeEventSource.last!.url).toBe('https://node.test/ev?x=1&token=tok%20en');
  });

  it('does not open events where EventSource does not exist', async () => {
    vi.stubGlobal('EventSource', undefined);
    const { t } = transport();
    const { done: p } = await connecting(t);
    sendVideo();
    await p;
    expect(FakeEventSource.last).toBeNull();
  });

  it('a refused offer fails with the status and body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    );
    const { t } = transport();
    await expect(t.connect()).rejects.toThrow('signaling failed: 503 busy');
  });

  it('a refused offer whose body cannot be read still fails', async () => {
    const res = new Response('x', { status: 500 });
    vi.spyOn(res, 'text').mockRejectedValue(new Error('broken'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );
    const { t } = transport();
    await expect(t.connect()).rejects.toThrow('signaling failed: 500 ');
  });

  it('fails and closes when no video arrives in time', async () => {
    vi.useFakeTimers();
    const { t } = transport({ connectTimeoutMs: 1000 });
    const p = t.connect().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const e = await p;
    expect((e as Error).message).toBe('no media within 1000ms (ice: checking)');
    expect(FakePc.last!.closed).toBe(true);
  });

  it('the default wait for video is 20 seconds', async () => {
    vi.useFakeTimers();
    const { t } = transport();
    const p = t.connect().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(FakePc.last!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await p) as Error).message).toMatch(/no media within 20000ms/);
  });

  it('waits for ICE gathering, up to 3 seconds', async () => {
    FakePc.gathering = 'gathering';
    const { t } = transport();
    const p = t.connect();
    await vi.waitFor(() =>
      expect(FakePc.last?.listeners.get('icegatheringstatechange')?.size).toBe(1),
    );
    const pc = FakePc.last!;
    pc.fire('icegatheringstatechange'); // まだ gathering
    expect(fetchMock).not.toHaveBeenCalled();
    pc.iceGatheringState = 'complete';
    pc.fire('icegatheringstatechange');
    await vi.waitFor(() => expect(pc.remote).not.toBeNull());
    expect(pc.listeners.get('icegatheringstatechange')?.size).toBe(0);
    sendVideo();
    await p;

    vi.useFakeTimers();
    const second = transport().t;
    const p2 = second.connect();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(FakePc.last?.remote).not.toBeNull());
    sendVideo();
    await p2;
  });

  it('reports a failed or closed connection as session.ended', async () => {
    const { t, emitter } = transport();
    const ended = vi.fn();
    emitter.on('session.ended', ended);
    const { done: p } = await connecting(t);
    sendVideo();
    await p;
    const pc = FakePc.last!;
    pc.connectionState = 'connected';
    pc.onconnectionstatechange!();
    expect(ended).not.toHaveBeenCalled();
    pc.connectionState = 'failed';
    pc.onconnectionstatechange!();
    pc.connectionState = 'closed';
    pc.onconnectionstatechange!();
    expect(ended).toHaveBeenCalledTimes(2);
    expect(ended).toHaveBeenCalledWith({ reason: 'disconnected' });
  });
});

describe('events', () => {
  async function connected() {
    const r = transport();
    const { done } = await connecting(r.t);
    sendVideo();
    await done;
    return { ...r, es: FakeEventSource.last! };
  }

  it('maps each event and fills defaults', async () => {
    const { emitter, es } = await connected();
    const seen: unknown[] = [];
    for (const name of [
      'speak.started',
      'speak.ended',
      'speak.interrupted',
      'queue.drained',
      'error',
    ] as const) {
      emitter.on(name, (p: unknown) => seen.push([name, p]));
    }
    es.send(JSON.stringify({ type: 'speak.started', utterance_id: 'u1', text: 'こんにちは' }));
    es.send(JSON.stringify({ type: 'speak.started' }));
    es.send(JSON.stringify({ type: 'speak.ended', utterance_id: 'u1', duration_ms: 900 }));
    es.send(JSON.stringify({ type: 'speak.ended' }));
    es.send(JSON.stringify({ type: 'speak.interrupted', utterance_id: 'u2', spoken_ms: 100 }));
    es.send(JSON.stringify({ type: 'speak.interrupted' }));
    es.send({ type: 'queue.drained' });
    es.send(JSON.stringify({ type: 'error', code: 'x', message: 'y' }));
    es.send(JSON.stringify({ type: 'error' }));
    es.send(JSON.stringify({ type: 'something.new' }));
    es.send('{not json');
    expect(seen).toEqual([
      ['speak.started', { utteranceId: 'u1', text: 'こんにちは' }],
      ['speak.started', { utteranceId: '', text: undefined }],
      ['speak.ended', { utteranceId: 'u1', durationMs: 900 }],
      ['speak.ended', { utteranceId: '', durationMs: 0 }],
      ['speak.interrupted', { utteranceId: 'u2', spokenMs: 100 }],
      ['speak.interrupted', { utteranceId: '', spokenMs: 0 }],
      ['queue.drained', {}],
      ['error', { code: 'x', message: 'y' }],
      ['error', { code: 'unknown', message: '' }],
    ]);
  });

  it('session.ended closes the events', async () => {
    const { emitter, es } = await connected();
    const ended = vi.fn();
    emitter.on('session.ended', ended);
    es.send(JSON.stringify({ type: 'session.ended', reason: 'idle' }));
    expect(es.closed).toBe(true);
    expect(ended).toHaveBeenCalledWith({ reason: 'idle' });
    es.send(JSON.stringify({ type: 'session.ended' }));
    expect(ended).toHaveBeenLastCalledWith({ reason: 'unknown' });
  });
});

describe('attach, play and close', () => {
  it('attaches before or after the tracks, once per stream, and close cleans up', async () => {
    const { t } = transport();
    const el = new FakeVideo();
    t.attach(el as unknown as HTMLMediaElement); // まだ stream が無い
    expect(el.srcObject).toBeNull();
    const { done: p } = await connecting(t);
    sendAudio();
    sendVideo();
    await p;
    expect(el.srcObject).toBeInstanceOf(FakeStream);
    expect(el.plays).toBe(1); // 2 本目のトラックでは入れ直さない
    const other = new FakeVideo();
    t.attach(other as unknown as HTMLMediaElement);
    expect(other.srcObject).toBe(el.srcObject);
    const stream = other.srcObject as FakeStream;
    await t.close();
    expect(stream.tracks.every((x) => x.stopped)).toBe(true);
    expect(FakePc.last!.closed).toBe(true);
    expect(FakeEventSource.last!.closed).toBe(true);
    expect(other.srcObject).toBeNull();
    await t.close(); // 2 回目も落ちない
  });

  it('close without connecting or attaching does nothing', async () => {
    await transport().t.close();
  });

  it('when autoplay is refused, plays muted and unmutes on the first touch', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    const { t } = transport();
    const el = new FakeVideo();
    let n = 0;
    el.playImpl = async (v) => {
      n++;
      if (n === 1 && !v.muted) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      if (n === 3) throw new Error('later');
    };
    t.attach(el as unknown as HTMLMediaElement);
    const { done: p } = await connecting(t);
    sendVideo();
    await p;
    await vi.waitFor(() => expect(doc.count()).toBe(2));
    expect(el.muted).toBe(true);
    doc.fire('pointerdown');
    expect(el.muted).toBe(false);
    expect(doc.count()).toBe(0);
    await vi.waitFor(() => expect(el.plays).toBe(3)); // 3 回目の失敗は飲み込む
  });

  it('a second refusal while muted gives up; other errors are ignored', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    const refuse = (el: FakeVideo, f: (v: FakeVideo) => Promise<void>) => {
      el.playImpl = f;
    };
    // 消音でも止められる
    const a = transport().t;
    const el = new FakeVideo();
    refuse(el, async () => {
      throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
    });
    a.attach(el as unknown as HTMLMediaElement);
    const { done: p } = await connecting(a);
    sendVideo();
    await p;
    await vi.waitFor(() => expect(el.plays).toBe(2));
    expect(doc.count()).toBe(0);
    // NotAllowedError でない失敗 (null を投げる実装も) は待ち受けを付けない
    const b = transport().t;
    const el2 = new FakeVideo();
    refuse(el2, () => Promise.reject(null));
    b.attach(el2 as unknown as HTMLMediaElement);
    const { done: p2 } = await connecting(b);
    sendVideo();
    await p2;
    await vi.waitFor(() => expect(el2.plays).toBe(1));
    expect(el2.muted).toBe(false);
  });

  it('re-attaching replaces the unmute listeners, and close removes them', async () => {
    const doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    const { t } = transport();
    const refusing = () => {
      const el = new FakeVideo();
      el.playImpl = async (v) => {
        if (!v.muted) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      };
      return el;
    };
    t.attach(refusing() as unknown as HTMLMediaElement);
    const { done: p } = await connecting(t);
    sendVideo();
    await p;
    await vi.waitFor(() => expect(doc.count()).toBe(2));
    const second = refusing();
    t.attach(second as unknown as HTMLMediaElement);
    await vi.waitFor(() => expect(second.plays).toBe(2));
    await Promise.resolve();
    expect(doc.count()).toBe(2);
    await t.close();
    expect(doc.count()).toBe(0);
  });

  it('without a document (not a browser), muted playback stays muted', async () => {
    vi.stubGlobal('document', undefined);
    const { t } = transport();
    const el = new FakeVideo();
    el.playImpl = async (v) => {
      if (!v.muted) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
    };
    t.attach(el as unknown as HTMLMediaElement);
    const { done: p } = await connecting(t);
    sendVideo();
    await p;
    await vi.waitFor(() => expect(el.plays).toBe(2));
    expect(el.muted).toBe(true);
  });
});
