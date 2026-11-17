/**
 * Warm a heavy module graph once per test file.
 *
 * Several files load the message router (every handler) with
 * `vi.resetModules()` and a dynamic import inside each test, so every test
 * starts from fresh module state. The first such import transforms the whole
 * graph, which on a busy machine takes longer than a test's own time limit.
 * Loading it once in `beforeAll`, with a generous limit of its own, leaves
 * the tests only the evaluation of already transformed modules. The warm-up
 * runs with fresh modules and its own chrome mock (`setup`) and leaves fresh
 * modules behind, so it changes nothing a test sees.
 */
import { beforeAll, vi } from 'vitest';

export const WARM_TIMEOUT_MS = 120_000;

/** Import `load` once before the file's tests; `setup` prepares globals
 *  the modules read when they load (for example mockChromeStorage). */
export function warmImports(load: () => Promise<unknown>, setup?: () => void, opts: { reset?: boolean } = {}): void {
  // `reset: false` for a file whose tests share the module instances with
  // its static imports (they do not reset modules themselves).
  const reset = opts.reset !== false;
  beforeAll(async () => {
    if (reset) vi.resetModules();
    setup?.();
    // A module that fails to evaluate here is still transformed and cached.
    try { await load(); } catch { /* the tests import it themselves */ }
    if (reset) vi.resetModules();
  }, WARM_TIMEOUT_MS);
}

/** The service worker's message router and every handler it registers. */
export function warmServiceWorkerGraph(setup?: () => void): void {
  warmImports(() => import('../message-router'), setup);
}
