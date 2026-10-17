#!/usr/bin/env node
// ビルドした成果物を npm pack し、別のディレクトリに入れて、素の Node（ESM・CJS）・型（node16 の ESM・CJS）・
// Deno（あれば）から使えることを確かめる。pnpm test の最後に流す（voicast・Webhook Admin の SDK の pack-check と同じ作り）。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'avacast-sdk-pack-'));
const require = createRequire(join(pkgDir, 'package.json'));

function step(name) {
  console.log(`[pack-check] ${name}`);
}
function fail(msg) {
  console.error(`[pack-check] NG: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// API は偽の fetch で流す。どの実行環境でも同じもの
const SMOKE = `
  const seen = [];
  const client = new Avacast('sk_test_x', {
    baseUrl: 'https://api.test',
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ session_id: 'ses_1', client_token: 'a.b.c', webrtc: {} }), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  const r = await client.sessions.create({ avatar_id: 'avt_1' });
  if (r.session_id !== 'ses_1') throw new Error('create returned ' + JSON.stringify(r));
  const h = seen[0].init.headers;
  if (h['user-agent'] !== 'avacast-node/' + VERSION) throw new Error('user-agent ' + h['user-agent']);
  if (h.authorization !== 'Bearer sk_test_x') throw new Error('authorization ' + h.authorization);
  if (!/^avacast-node-[0-9a-f-]{36}$/.test(h['idempotency-key'])) throw new Error('idempotency-key ' + h['idempotency-key']);
  const nf = new Avacast('sk_test_x', { fetch: async () => new Response('{"error":{"code":"session_not_found","message":"x"}}', { status: 404 }) });
  let e404 = null;
  try { await nf.sessions.get('ses_x'); } catch (e) { e404 = e; }
  if (!(e404 instanceof NotFoundError) || !(e404 instanceof AvacastError) || e404.code !== 'session_not_found') throw new Error('404 was ' + e404);
  if (VOICE_IDS.length !== 14) throw new Error('VOICE_IDS');
  if (typeof AvacastSession !== 'function' || typeof WebSession !== 'function') throw new Error('AvacastSession from avacast and avacast/web');
  if (typeof SpeakEvent.QUEUE_DRAINED !== 'string') throw new Error('SpeakEvent');
`;

const IMPORTS = 'Avacast, AvacastError, NotFoundError, AvacastSession, VOICE_IDS, VERSION';
const WEB_IMPORTS = 'AvacastSession as WebSession, SpeakEvent';

try {
  step('npm pack');
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  const [info] = JSON.parse(out);
  const files = info.files.map((f) => f.path).sort();
  const expected = [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'dist/index.cjs',
    'dist/index.d.cts',
    'dist/index.d.ts',
    'dist/index.js',
    'dist/web.cjs',
    'dist/web.d.cts',
    'dist/web.d.ts',
    'dist/web.js',
    'package.json',
  ];
  // avacast/web は本体と何も共有しない（共通の塊 chunk-*.js が出ない）
  if (JSON.stringify(files) !== JSON.stringify(expected))
    fail(`files in the tarball: ${files.join(', ')}`);
  const tgz = join(work, info.filename);

  step('the tarball has no dependencies and no workspace references');
  const packed = JSON.parse(
    execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }),
  );
  for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (packed[k] && Object.keys(packed[k]).length)
      fail(`${k} in package.json: ${JSON.stringify(packed[k])}`);
  }
  for (const f of files.filter((x) => x.startsWith('dist/'))) {
    const src = execFileSync('tar', ['-xzOf', tgz, `package/${f}`], { encoding: 'utf8' });
    if (/@avacast\/|workspace:|web-sdk/.test(src)) fail(`${f} refers to a workspace package`);
    if (/from ["']node:|require\(["']node:/.test(src))
      fail(`${f} imports a Node built-in statically`);
  }
  // ブラウザ向けの avacast/web は Node の処理系に触れない（動的な import('node:crypto') も含めない）
  for (const f of ['dist/web.js', 'dist/web.cjs']) {
    const src = execFileSync('tar', ['-xzOf', tgz, `package/${f}`], { encoding: 'utf8' });
    if (/node:crypto|process\.env/.test(src)) fail(`${f} touches Node-only APIs`);
  }

  step('install into an empty project');
  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', private: true, version: '0.0.0' }),
  );
  run(
    'npm',
    [
      'install',
      tgz,
      '--offline',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--no-package-lock',
    ],
    { cwd: app },
  );

  step('Node ESM (import)');
  writeFileSync(
    join(app, 'esm.mjs'),
    `import { ${IMPORTS} } from 'avacast';\nimport { ${WEB_IMPORTS} } from 'avacast/web';\n${SMOKE}\nconsole.log('esm ok ' + VERSION);\n`,
  );
  if (!run(process.execPath, ['esm.mjs'], { cwd: app }).includes(`esm ok ${pkg.version}`))
    fail('esm');

  step('Node CJS (require)');
  writeFileSync(
    join(app, 'cjs.cjs'),
    `const { ${IMPORTS} } = require('avacast');\nconst { AvacastSession: WebSession, SpeakEvent } = require('avacast/web');\n(async () => {${SMOKE}\nconsole.log('cjs ok ' + VERSION);\n})().catch((e) => { console.error(e); process.exit(1); });\n`,
  );
  if (!run(process.execPath, ['cjs.cjs'], { cwd: app }).includes(`cjs ok ${pkg.version}`))
    fail('cjs');

  // 追加の実行環境（例: PACK_CHECK_RUNTIMES=/path/to/node18,/path/to/bun）でも ESM・CJS を流す
  for (const bin of (process.env.PACK_CHECK_RUNTIMES ?? '').split(',').filter(Boolean)) {
    const v = run(bin, ['--version']).trim();
    step(`${bin} ${v}: ESM and CJS`);
    if (!run(bin, ['esm.mjs'], { cwd: app }).includes('esm ok')) fail(`esm on ${v}`);
    if (!run(bin, ['cjs.cjs'], { cwd: app }).includes('cjs ok')) fail(`cjs on ${v}`);
  }

  step('types under module node16 (ESM and CJS)');
  const typesNode = dirname(require.resolve('@types/node/package.json'));
  const TYPES = `
    const v: Avacast = new Avacast('sk_test_x', { maxRetries: 1, timeout: 1000 });
    async function f(): Promise<void> {
      const s: Session = await v.sessions.create({ avatar_id: 'avt', voice: { voice_id: 'female-30s-clear', language: 'ja' } });
      const u: Utterance = await v.sessions.speak(s.session_id, 'hi', { idempotencyKey: 'k' });
      const st: SessionState = await v.sessions.get(s.session_id);
      const r: RangeUsage = await v.usage.range({ from: new Date(), group_by: 'metadata.tenant' });
      const m: MonthlyUsage = await v.usage.get();
      const a: Avatar[] = (await v.avatars.list()).data;
      void [u.utterance_id, st.connected_seconds, r.data?.[0]?.key, m.limits.concurrency, a[0]?.is_preset];
      try { await v.sessions.end(s.session_id); } catch (e) { if (e instanceof RateLimitError) void e.retryAfter; }
      const session = new AvacastSession(s.client_token, { signalingUrl: s.webrtc.signaling_url });
      const off: () => void = session.on('speak.ended', ({ utteranceId }) => utteranceId.toUpperCase());
      off();
    }
    void f;
  `;
  const imports =
    'Avacast, RateLimitError, type Session, type Utterance, type SessionState, type RangeUsage, type MonthlyUsage, type Avatar';
  const header = `import { ${imports} } from 'avacast';\nimport { AvacastSession } from 'avacast/web';\n`;
  writeFileSync(join(app, 'types.mts'), `${header}${TYPES}`);
  writeFileSync(join(app, 'types.cts'), `${header}${TYPES}`);
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'node16',
        moduleResolution: 'node16',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        typeRoots: [dirname(typesNode)],
        types: ['node'],
      },
      files: ['types.mts', 'types.cts'],
    }),
  );
  run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd: app,
  });

  const deno = spawnSync('deno', ['--version'], { encoding: 'utf8' });
  if (deno.status === 0) {
    step('Deno (no permissions besides reading the package)');
    writeFileSync(
      join(app, 'deno.mjs'),
      `import { ${IMPORTS} } from './node_modules/avacast/dist/index.js';\nimport { ${WEB_IMPORTS} } from './node_modules/avacast/dist/web.js';\n${SMOKE}\nlet missing = null; try { new Avacast(); } catch (e) { missing = e; }\nif (!(missing instanceof AvacastError)) throw new Error('missing key did not throw');\nconsole.log('deno ok ' + VERSION);\n`,
    );
    if (
      !run('deno', ['run', '--no-prompt', '--allow-read=.', 'deno.mjs'], { cwd: app }).includes(
        'deno ok',
      )
    )
      fail('deno');
  } else {
    step('Deno is not installed; skipped');
  }

  console.log('[pack-check] all ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
