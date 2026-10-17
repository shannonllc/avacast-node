import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/web.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  sourcemap: false,
  treeshake: true,
  // avacast/web は単独で読み込めるようにする（共通の塊 chunk-*.js を作らない）
  splitting: false,
  // 束ねた中の「// <元のファイル>」の見出しを、公開のリポジトリと同じ src/web/ の形にそろえる
  async onSuccess() {
    for (const name of readdirSync('dist')) {
      if (!/\.c?js$/.test(name)) continue;
      const p = `dist/${name}`;
      writeFileSync(
        p,
        readFileSync(p, 'utf8').replace(/^\/\/ \.\.\/[\w-]+\/src\//gm, '// src/web/'),
      );
    }
  },
});
