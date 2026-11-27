import { describe, expect, it } from 'vitest';
import { latestRun } from '../latest-run';

/** A run that waits until released, and records whether it was stale then. */
function gated() {
  const gates: Array<() => void> = [];
  const results: boolean[] = [];
  let active = 0;
  let most = 0;
  const run = async (stale: () => boolean) => {
    active += 1;
    most = Math.max(most, active);
    await new Promise<void>(r => gates.push(r));
    results.push(stale());
    active -= 1;
  };
  return { run, gates, results, most: () => most };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('latestRun', () => {
  it('runs one at a time; a burst of asks gives one more run, and the older run is stale', async () => {
    const g = gated();
    const r = latestRun(g.run);
    const first = r.request();
    void r.request();
    void r.request();
    await tick();
    expect(g.gates).toHaveLength(1);
    g.gates[0]();
    await tick();
    expect(g.gates).toHaveLength(2);
    g.gates[1]();
    await first;
    expect(g.results).toEqual([true, false]);
    expect(g.most()).toBe(1);
  });

  it('drop makes the running one stale without another run', async () => {
    const g = gated();
    const r = latestRun(g.run);
    const p = r.request();
    await tick();
    r.drop();
    g.gates[0]();
    await p;
    expect(g.results).toEqual([true]);
    expect(g.gates).toHaveLength(1);
  });

  it('a run that throws does not block the next request', async () => {
    let n = 0;
    const r = latestRun(() => { n += 1; return n === 1 ? Promise.reject(new Error('x')) : Promise.resolve(); });
    await expect(r.request()).rejects.toThrow('x');
    await r.request();
    expect(n).toBe(2);
  });
});
