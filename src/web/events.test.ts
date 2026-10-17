import { describe, expect, it, vi } from 'vitest';
import { Emitter, SessionEvent, SpeakEvent } from './events';

describe('Emitter', () => {
  it('購読したイベントを受け取る', () => {
    const e = new Emitter();
    const seen: unknown[] = [];
    e.on('speak.ended', (p) => seen.push(p));
    e.emit('speak.ended', { utteranceId: 'utt_1', durationMs: 2500 });
    expect(seen).toEqual([{ utteranceId: 'utt_1', durationMs: 2500 }]);
  });

  it('戻り値を呼ぶと解除できる（useEffect からそのまま返せる）', () => {
    const e = new Emitter();
    const fn = vi.fn();
    const off = e.on('speak.ended', fn);
    off();
    e.emit('speak.ended', { utteranceId: 'u', durationMs: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('ハンドラが例外を投げても他のハンドラは動く', () => {
    // 顧客のコールバックの不具合で映像が止まると原因が分かりにくくなる。
    const e = new Emitter();
    const ok = vi.fn();
    e.on('speak.ended', () => {
      throw new Error('boom');
    });
    e.on('speak.ended', ok);
    expect(() => e.emit('speak.ended', { utteranceId: 'u', durationMs: 1 })).not.toThrow();
    expect(ok).toHaveBeenCalledOnce();
  });

  it('購読していないイベントを発行しても落ちない', () => {
    expect(() => new Emitter().emit('queue.drained', {})).not.toThrow();
  });

  it('イベント名はほかのアバターの SDK からの移行を意識した対応関係になっている', () => {
    // 移行がイベント名の置換で済むことが設計の狙い。
    expect(SessionEvent.STREAM_READY).toBe('session.ready');
    expect(SessionEvent.DISCONNECTED).toBe('session.ended');
    expect(SpeakEvent.SPEAK_ENDED).toBe('speak.ended');
  });
});
