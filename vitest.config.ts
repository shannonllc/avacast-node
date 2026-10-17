import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/web/**/*.test.ts'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
