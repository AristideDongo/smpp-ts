import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        'src/codec/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/encoding/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/session/**': { lines: 90, functions: 90, branches: 80, statements: 90 },
      },
    },
  },
});
