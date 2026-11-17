// npm run bench: the wall-clock benches (*.bench.test.*) with their time
// assertions on (CREV_BENCH=1). `npm test` runs the same files without the
// time limits, which a busy machine fails at random.
import { spawnSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, ['vitest', 'run', 'bench.test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CREV_BENCH: '1' },
});
process.exit(result.status ?? 1);
