// 各 API の呼び方（メソッド・パス・本文・クエリ）と応答の受け渡し。
import { describe, expect, it } from 'vitest';
import { AvacastApiError, LANGUAGES, VOICE_IDS } from '../src/index';
import { client, fakeFetch, json } from './helpers';

const session = {
  session_id: 'ses_1',
  client_token: 'eyJ.x.y',
  webrtc: {
    signaling_url: 'https://node.test/offer',
    events_url: 'https://node.test/events',
    ice_servers: [],
  },
  expires_at: '2026-10-17T12:30:00.000Z',
};

describe('sessions', () => {
  it('create posts the params with a generated Idempotency-Key', async () => {
    const f = fakeFetch(json(201, session));
    const params = {
      avatar_id: 'avt_1',
      voice: { language: 'ja', voice_id: 'female-30s-clear', speed: 0.9 },
      idle_timeout_seconds: 300,
      metadata: { tenant: 'clinic-a' },
    };
    expect(await client(f.fn).sessions.create(params)).toEqual(session);
    expect(f.calls[0]).toMatchObject({ method: 'POST', body: params });
    expect(f.calls[0]!.url.pathname).toBe('/v1/sessions');
    expect(f.calls[0]!.headers['idempotency-key']).toMatch(/^avacast-node-/);
  });

  it('create and speak use the given Idempotency-Key and pass the other options on', async () => {
    const f = fakeFetch(json(201, session));
    const v = client(f.fn);
    await v.sessions.create({ avatar_id: 'avt_1' }, { idempotencyKey: 'order-1', maxRetries: 0 });
    await v.sessions.speak('ses_1', 'hi', { idempotencyKey: 'line-1', timeout: 5 });
    expect(f.calls.map((c) => c.headers['idempotency-key'])).toEqual(['order-1', 'line-1']);
  });

  it('get, end, speak and interrupt', async () => {
    const f = fakeFetch(
      json(200, { session_id: 'ses/1', status: 'active' }),
      json(200, { session_id: 'ses/1', status: 'ended', connected_seconds: 3, total_speak_ms: 0 }),
      json(202, { utterance_id: 'utt_1', status: 'queued', queue_length: 1 }),
      json(200, { interrupted_utterance_id: 'utt_1', discarded_count: 2 }),
    );
    const v = client(f.fn);
    expect((await v.sessions.get('ses/1')).status).toBe('active');
    expect((await v.sessions.end('ses/1')).connected_seconds).toBe(3);
    expect((await v.sessions.speak('ses/1', 'ご相談ありがとうございます。')).utterance_id).toBe(
      'utt_1',
    );
    expect((await v.sessions.interrupt('ses/1')).discarded_count).toBe(2);
    expect(f.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /v1/sessions/ses%2F1',
      'DELETE /v1/sessions/ses%2F1',
      'POST /v1/sessions/ses%2F1/speak',
      'POST /v1/sessions/ses%2F1/interrupt',
    ]);
    expect(f.calls[2]!.body).toEqual({ text: 'ご相談ありがとうございます。' });
    expect(f.calls[3]!.body).toBeUndefined();
    expect(f.calls[3]!.headers['idempotency-key']).toBeUndefined();
  });
});

describe('avatars', () => {
  it('list', async () => {
    const data = [
      { id: 'avt_1', name: '案内役A', thumbnail_url: null, languages: ['ja'], is_preset: true },
    ];
    const f = fakeFetch(json(200, { data }));
    expect((await client(f.fn).avatars.list()).data).toEqual(data);
    expect(f.calls[0]!.url.pathname).toBe('/v1/avatars');
    expect(f.calls[0]!.method).toBe('GET');
  });
});

describe('usage', () => {
  it('get is this month, without a query', async () => {
    const f = fakeFetch(json(200, { connected_seconds: 10 }));
    expect((await client(f.fn).usage.get()).connected_seconds).toBe(10);
    expect(f.calls[0]!.url.search).toBe('');
  });

  it('range sends from, to (strings or Dates) and group_by', async () => {
    const f = fakeFetch(json(200, { connected_seconds: 5, group_by: 'metadata.tenant', data: [] }));
    const v = client(f.fn);
    await v.usage.range({
      from: new Date('2026-10-01T00:00:00Z'),
      to: '2026-11-01T00:00:00Z',
      group_by: 'metadata.tenant',
    });
    await v.usage.range({ group_by: 'metadata.tenant' });
    await v.usage.range({ from: '2026-10-01', to: '' });
    expect(f.calls.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
      { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00Z', group_by: 'metadata.tenant' },
      { group_by: 'metadata.tenant' },
      { from: '2026-10-01' },
    ]);
  });

  it('range without from, to or group_by is refused before sending', async () => {
    const f = fakeFetch(json(200, {}));
    const v = client(f.fn);
    await expect(v.usage.range({})).rejects.toBeInstanceOf(AvacastApiError);
    await expect(v.usage.range({ from: '', group_by: '' as 'metadata.x' })).rejects.toThrow(
      /usage.get/,
    );
    expect(f.calls).toHaveLength(0);
  });
});

describe('status and constants', () => {
  it('status', async () => {
    const f = fakeFetch(json(200, { ok: true }));
    expect(await client(f.fn).status()).toEqual({ ok: true });
    expect(f.calls[0]!.url.pathname).toBe('/v1/status');
  });

  it('voice IDs and languages are the API values', () => {
    expect(VOICE_IDS).toHaveLength(14);
    expect(VOICE_IDS).toContain('female-standard');
    expect(VOICE_IDS).toContain('male-60s-deep');
    for (const v of VOICE_IDS) expect(v).toMatch(/^(female|male)-(standard|[2-6]0s-[a-z]+)$/);
    expect(LANGUAGES[0]).toBe('ja');
  });
});
