import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        'src/codec/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/encoding/**': { lines: 90, functions: 90, branches: 85, statements: 90 },
        'src/session/**': { lines: 90, functions: 90, branches: 80, statements: 90 },
        // Below the spec's 90% target: these thresholds lock the current level and only go up.
        'src/client/**': { lines: 88, functions: 85, branches: 78, statements: 85 },
        'src/server/**': { lines: 90, functions: 85, branches: 82, statements: 88 },
        'src/transport/**': { lines: 90, functions: 85, branches: 82, statements: 85 },
      },
    },
  },
});
