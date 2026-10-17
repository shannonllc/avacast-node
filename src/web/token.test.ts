import { describe, expect, it } from 'vitest';
import { isExpired, readClientToken } from './token';

/** テスト用に JWT 風の文字列を組み立てる（署名は検証しないのでダミーでよい）。 */
function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.signature`;
}

describe('readClientToken', () => {
  it('セッション ID と期限を取り出す', () => {
    const token = makeToken({ sub: 'ses_abc', exp: 1788600000 });
    expect(readClientToken(token)).toEqual({ sessionId: 'ses_abc', expiresAt: 1788600000 });
  });

  it('日本語を含むペイロードでも壊れない', () => {
    const token = makeToken({ sub: 'ses_abc', exp: 1, name: '案内役A' });
    expect(readClientToken(token)?.sessionId).toBe('ses_abc');
  });

  it('形式が JWT でなければ null', () => {
    expect(readClientToken('not-a-token')).toBeNull();
    expect(readClientToken('a.b')).toBeNull();
    expect(readClientToken('')).toBeNull();
  });

  it('sub や exp が欠けていれば null', () => {
    expect(readClientToken(makeToken({ exp: 1 }))).toBeNull();
    expect(readClientToken(makeToken({ sub: 'ses_abc' }))).toBeNull();
  });

  it('ペイロードが壊れていても例外にしない', () => {
    expect(readClientToken('aaa.!!!not-base64!!!.bbb')).toBeNull();
  });
});

describe('isExpired', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

  it('期限前は false', () => {
    expect(isExpired({ sessionId: 's', expiresAt: at('2026-09-05T12:10:00Z') }, now)).toBe(false);
  });

  it('期限後は true', () => {
    expect(isExpired({ sessionId: 's', expiresAt: at('2026-09-05T11:59:00Z') }, now)).toBe(true);
  });

  it('ちょうど期限は切れている扱い', () => {
    expect(isExpired({ sessionId: 's', expiresAt: at('2026-09-05T12:00:00Z') }, now)).toBe(true);
  });
});
