/**
 * クライアントトークン（JWT）から必要な情報を取り出す。
 *
 * **署名は検証しない。** 検証は avacast のサーバーの仕事で、ブラウザ側は
 * 鍵を持たない。ここでやりたいのは「このトークンはどのセッションのものか」
 * を知ることだけ。中身を信用して権限判断をしてはいけない。
 */

export type ClientTokenInfo = {
  sessionId: string;
  /** 有効期限（UNIX 秒）。 */
  expiresAt: number;
};

function decodeBase64Url(part: string): string {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  // atob はブラウザにも Node 16+ にもある。
  const binary = atob(padded + pad);
  // 日本語などを含む場合に備えて UTF-8 として解釈する。
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * トークンからセッション ID と期限を取り出す。
 * 壊れたトークンは例外ではなく null を返す（呼び出し側でエラー表示に回す）。
 */
export function readClientToken(token: string): ClientTokenInfo | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1] as string)) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    return { sessionId: payload.sub, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

/**
 * すでに期限が切れているか。
 * 期限切れのトークンで接続を試みると必ず 401 になるので、
 * ネットワークに出る前に気づけるようにする。
 */
export function isExpired(info: ClientTokenInfo, now: Date = new Date()): boolean {
  return info.expiresAt * 1000 <= now.getTime();
}
