// 実行環境の差を吸収する（Node 18 は Web Crypto が global に無い、process が無い実行環境もある）。

// 変数にしておくと、バンドラーが node:crypto を解決しようとしない（ブラウザ・Deno では読まれない）
const NODE_CRYPTO = 'node:crypto';

let nodeCrypto: Promise<Crypto> | undefined;

/** Web Crypto. Node 18 falls back to node:crypto's webcrypto. */
export function webCrypto(): Promise<Crypto> {
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g?.subtle) return Promise.resolve(g);
  nodeCrypto ??= import(/* webpackIgnore: true */ /* @vite-ignore */ NODE_CRYPTO).then(
    (m: { webcrypto: Crypto }) => m.webcrypto,
  );
  return nodeCrypto;
}

/** Reads an environment variable in Node, Bun and Deno. Returns undefined elsewhere. */
export function readEnv(name: string): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get(name: string): string | undefined } };
  };
  try {
    const v = g.process?.env?.[name] ?? g.Deno?.env?.get(name);
    return v?.trim() || undefined;
  } catch {
    // Deno without --allow-env throws
    return undefined;
  }
}

/** Random UUID v4. */
export async function uuid(): Promise<string> {
  const b = (await webCrypto()).getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
