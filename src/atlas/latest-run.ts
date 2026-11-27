/**
 * One run at a time, and only the newest asked for counts. `request()`
 * starts `run` when none is running; asked while one runs, it marks that run
 * stale and runs once more after it (bursts of asks give one more run, not
 * one each). `run` gets `stale()`: true once a newer request or `drop()`
 * came, and it then keeps nothing it read.
 */
export function latestRun(run: (stale: () => boolean) => Promise<void>): { request: () => Promise<void>; drop: () => void } {
  let gen = 0;
  let running = false;
  let again = false;
  return {
    async request() {
      gen += 1;
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          const mine = gen;
          await run(() => mine !== gen);
        } while (again);
      } finally { running = false; }
    },
    drop() { gen += 1; },
  };
}
