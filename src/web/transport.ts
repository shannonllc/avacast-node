import type { Emitter } from './events.js';

/**
 * 映像のサーバーとの接続を抽象化する。
 *
 * シグナリングは「SDP offer を POST して answer を受け取る」。
 *
 * ★ 発話イベントは DataChannel ではなく SSE で届く。URL はシグナリング URL の
 *   /offer を /events に置き換えたもの (webrtc.events_url にも入っている)。
 *   EventSource はヘッダを付けられないので client_token はクエリで渡す。
 *
 *   interface にしてあるので、手順が変わっても AvacastSession 側は触らずに済む。
 *   テストでは FakeTransport を差し込む。
 */
export interface Transport {
  /** 接続する。映像トラックが来たら onTrack が呼ばれる。 */
  connect(): Promise<void>;
  /** 映像・音声を <video> に結びつける。 */
  attach(element: HTMLMediaElement): void;
  /** 切断する。 */
  close(): Promise<void>;
}

export type TransportOptions = {
  signalingUrl: string;
  /** 発話イベントの SSE。省略時は signalingUrl の /offer を /events に置き換える */
  eventsUrl?: string;
  /** 映像が届くまで待つ上限 (ms)。過ぎたら connect を失敗にする。既定 20 秒 */
  connectTimeoutMs?: number;
  clientToken: string;
  /** セッション作成の応答 webrtc.ice_servers。無ければ STUN だけで試す */
  iceServers?: RTCIceServer[];
  emitter: Emitter;
};

/** 映像のサーバーから届くイベントの生の形。 */
type WireEvent = {
  type?: string;
  utterance_id?: string;
  duration_ms?: number;
  spoken_ms?: number;
  reason?: string;
  text?: string;
  code?: string;
  message?: string;
};

/**
 * WebRTC でつなぐ実装。
 *
 * 映像・音声は映像のサーバーから**直接**届く。API のサーバーは経由しない。
 * 発話イベントは SSE で受ける。
 */
export class WebRtcTransport implements Transport {
  private pc: RTCPeerConnection | null = null;
  private events: EventSource | null = null;
  private stream: MediaStream | null = null;
  private element: HTMLMediaElement | null = null;
  /** 自動再生を止められて消音で流しているとき、音を戻すための待ち受けを外す */
  private removeUnmute: (() => void) | null = null;
  private readonly opts: TransportOptions;

  constructor(opts: TransportOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers?.length
        ? this.opts.iceServers
        : [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.pc = pc;

    // 受信専用。こちらからカメラやマイクは送らない。
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    let videoArrived!: () => void;
    const videoTrack = new Promise<void>((resolve) => {
      videoArrived = resolve;
    });
    pc.ontrack = (event) => {
      this.stream ??= new MediaStream();
      this.stream.addTrack(event.track);
      this.attachIfReady();
      // 映像トラックが来た時点を「準備できた」とみなす。
      if (event.track.kind === 'video') {
        videoArrived();
        this.opts.emitter.emit('session.ready', { sessionId: '' });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.opts.emitter.emit('session.ended', { reason: 'disconnected' });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.waitForIceGathering(pc);

    const res = await fetch(this.opts.signalingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.clientToken}`,
      },
      body: JSON.stringify({
        sdp: pc.localDescription?.sdp,
        type: pc.localDescription?.type,
      }),
    });
    if (!res.ok) {
      throw new Error(`signaling failed: ${res.status} ${await res.text().catch(() => '')}`);
    }

    const answer = (await res.json()) as RTCSessionDescriptionInit;
    await pc.setRemoteDescription(answer);

    // シグナリングが通っても、経路 (TURN / 社内ネットワークの UDP 遮断) の都合で映像が来ないことがある。
    // 待ち続けると呼び出し側は「接続中」のまま止まるので、上限を過ぎたら失敗にして再接続に回せるようにする
    const timeoutMs = this.opts.connectTimeoutMs ?? 20_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no media within ${timeoutMs}ms (ice: ${pc.iceConnectionState})`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([videoTrack, timedOut]);
    } catch (e) {
      await this.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }

    // 発話イベント。接続が確立してから購読する (映像のサーバーのセッションは /offer で作られる)。
    // こちらからは送らない (発話の指示は HTTP で avacast サーバーへ出す)。
    const eventsUrl = this.opts.eventsUrl ?? this.opts.signalingUrl.replace(/\/offer$/, '/events');
    if (typeof EventSource !== 'undefined') {
      const url = `${eventsUrl}${eventsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.opts.clientToken)}`;
      this.events = new EventSource(url);
      this.events.onmessage = (e) => this.handleWireEvent(e.data);
      // 切断時の再接続は EventSource が自前でやる。session.ended が来たら閉じる
    }
  }

  attach(element: HTMLMediaElement): void {
    this.element = element;
    this.attachIfReady();
  }

  async close(): Promise<void> {
    this.events?.close();
    this.events = null;
    this.removeUnmute?.();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.pc?.close();
    this.pc = null;
    if (this.element) this.element.srcObject = null;
  }

  private attachIfReady(): void {
    const el = this.element;
    if (!el || !this.stream) return;
    // ontrack は映像・音声で 2 回来る。同じ stream を入れ直すと再生が頭からやり直しになる
    if (el.srcObject === this.stream) return;
    el.srcObject = this.stream;
    void this.play(el);
  }

  /**
   * 再生を始める。`autoplay` 属性だけに任せない。
   *
   * iOS (Safari も Chrome も WebKit) は、画面に一度も触れていない状態で音声付きの映像を
   * 自動再生させない。止められると映像も黒いまま出ない (PC の Chrome は制限が緩いので気付けない)。
   * そのときは音を消して映像だけ先に流し、次に画面に触れた時点で音を戻す。
   */
  private async play(el: HTMLMediaElement): Promise<void> {
    try {
      await el.play();
      return;
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== 'NotAllowedError') return;
    }
    el.muted = true;
    try {
      await el.play();
    } catch {
      return;
    }
    if (typeof document === 'undefined') return;
    const unmute = () => {
      this.removeUnmute?.();
      el.muted = false;
      void el.play().catch(() => {});
    };
    this.removeUnmute?.();
    document.addEventListener('pointerdown', unmute, true);
    document.addEventListener('keydown', unmute, true);
    this.removeUnmute = () => {
      document.removeEventListener('pointerdown', unmute, true);
      document.removeEventListener('keydown', unmute, true);
      this.removeUnmute = null;
    };
  }

  /**
   * ICE の収集が終わるまで待つ。
   *
   * Trickle ICE を使わず、候補が揃ってから 1 回だけ offer を送る形にしている。
   * シグナリングが HTTP の 1 往復で済み、サーバー側が単純になるため。
   * 収集が終わらない環境に備えて 3 秒で打ち切る。
   */
  private waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, 3000);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  /** 届いた生イベントを SDK のイベントに変換する。 */
  private handleWireEvent(raw: unknown): void {
    let data: WireEvent;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw) : (raw as WireEvent);
    } catch {
      return;
    }
    const e = this.opts.emitter;
    switch (data.type) {
      case 'speak.started':
        e.emit('speak.started', { utteranceId: data.utterance_id ?? '', text: data.text });
        return;
      case 'speak.ended':
        e.emit('speak.ended', {
          utteranceId: data.utterance_id ?? '',
          durationMs: data.duration_ms ?? 0,
        });
        return;
      case 'speak.interrupted':
        e.emit('speak.interrupted', {
          utteranceId: data.utterance_id ?? '',
          spokenMs: data.spoken_ms ?? 0,
        });
        return;
      case 'queue.drained':
        e.emit('queue.drained', {});
        return;
      case 'session.ended':
        // 映像のサーバーのセッションが終わった。SSE を閉じないと EventSource が再接続し続ける
        this.events?.close();
        this.events = null;
        e.emit('session.ended', { reason: data.reason ?? 'unknown' });
        return;
      case 'error':
        e.emit('error', { code: data.code ?? 'unknown', message: data.message ?? '' });
        return;
      default:
        // 知らない種別は黙って捨てる。サーバー側でイベントを増やしても
        // 古い SDK が壊れないようにする。
        return;
    }
  }
}
