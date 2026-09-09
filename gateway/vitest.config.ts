import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The end-to-end suite imports the browser's own client, which uses the
      // application's `@/` alias. Mapping it here is what lets both halves of
      // the protocol be exercised against each other rather than against
      // fakes of one another.
      '@': fileURLToPath(new URL('../src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A PTY test spawns real shells; the default 5s is tight under load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Serial: several suites bind ports and spawn processes.
    fileParallelism: false,
  },
});
