import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/access/**/*.test.js'],
    exclude: ['src/**/integration/**'],
    setupFiles: ['src/test-setup.ts'],
    // A test file that loads the service worker's whole module graph (the
    // message router and every handler) takes several seconds on a busy
    // machine (two runs at once, a build in parallel), more than the 5 s
    // default. 20 s is what a loaded machine needs; a test that hangs still
    // fails. Heavy imports are warmed once per file in beforeAll
    // (src/lib/__tests__/warm-imports.ts), which has its own 60 s.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // Keep test modules/mocks isolated while letting happy-dom own localStorage.
    // Recent Node versions expose a conflicting experimental browser global.
    pool: 'forks',
    execArgv: process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
      ? ['--no-experimental-webstorage'] : [],
  },
});
