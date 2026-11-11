import { defineConfig } from 'vitest/config';

// Interoperability tests against a third-party SMSC (see test/interop/README.md).
export default defineConfig({
  test: {
    include: ['test/interop/**/*.interop.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // One shared SMSC: no parallelism across files.
    fileParallelism: false,
  },
});
