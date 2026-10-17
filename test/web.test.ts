// ブラウザの部品（avacast/web）が本体からも同じ名前で読めること。中身の試験はブラウザの部品の側にある
import { describe, expect, it } from 'vitest';
import * as root from '../src/index';
import * as web from '../src/web';

describe('browser exports', () => {
  it('avacast/web has the browser SDK, and avacast re-exports it unchanged', () => {
    for (const name of [
      'AvacastSession',
      'AvacastError',
      'SessionEvent',
      'SpeakEvent',
      'readClientToken',
      'isExpired',
      'WebRtcTransport',
    ]) {
      expect(name in web).toBe(true);
      expect((root as Record<string, unknown>)[name]).toBe((web as Record<string, unknown>)[name]);
    }
  });

  it('server errors are AvacastError, the same class the browser SDK throws', () => {
    const e = new root.NotFoundError('x', { code: 'session_not_found', status: 404 });
    expect(e).toBeInstanceOf(web.AvacastError);
    expect(e).toMatchObject({ code: 'session_not_found', status: 404 });
  });
});
