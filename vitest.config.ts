import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/access/**/*.test.js'],
    exclude: ['src/**/integration/**'],
    // Keep test modules/mocks isolated while letting happy-dom own localStorage.
    // Recent Node versions expose a conflicting experimental browser global.
    pool: 'forks',
    execArgv: process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
      ? ['--no-experimental-webstorage'] : [],
  },
});
