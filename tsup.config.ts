import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', otel: 'src/otel/index.ts', testing: 'src/testing/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node20',
    platform: 'node',
    // Shared chunks: smpp-ts/testing and smpp-ts/otel use the same classes as the main entry
    // (instanceof SmppError works across entry points).
    splitting: true,
    treeshake: true,
  },
  {
    // Command line: `npx smpp-ts smsc` / `npx smpp-ts send`.
    entry: { cli: 'src/cli/bin.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    splitting: false,
    treeshake: true,
  },
]);
