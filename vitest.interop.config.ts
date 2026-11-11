import { defineConfig } from 'vitest/config';

// Tests d'interopérabilité contre un SMSC tiers (cf. test/interop/README.md).
export default defineConfig({
  test: {
    include: ['test/interop/**/*.interop.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Un seul SMSC partagé : pas de parallélisme entre fichiers.
    fileParallelism: false,
  },
});
