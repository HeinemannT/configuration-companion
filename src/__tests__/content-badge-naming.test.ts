// @vitest-environment happy-dom
/**
 * Badge naming touches only the badges whose names arrived. Names come in
 * chunks of 25 (one per post); with 300 badges on the page the old path
 * rebuilt every badge named so far per chunk (1,950 rebuilds and as many fit
 * checks, each a forced layout between writes). Now each badge is rebuilt once, and the fit of the
 * named badges is checked once per frame, reads after writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentState } from '../content-state';
import { createIdentityLabel, flushFit, updateLabels } from '../content-overlays';

const N = 300;
const CHUNK = 25;
const rid = (i: number) => String(7_000_000_000_000_000_000n + BigInt(i));

function page(state: ContentState): void {
  document.body.innerHTML = '';
  for (let i = 0; i < N; i++) {
    const host = document.createElement('div');
    host.dataset.rid = rid(i);
    host.append(createIdentityLabel(state, rid(i)));
    document.body.append(host);
  }
}

/** Rebuilds (each rebuild replaces a badge's tile) and width reads. */
function counters() {
  const tiles = vi.spyOn(Element.prototype, 'replaceChildren');
  const widths = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
  return { tiles, widths, done: () => { tiles.mockRestore(); widths.mockRestore(); } };
}

describe('badge naming', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('rebuilds each badge once and checks its fit once per frame', () => {
    const state = new ContentState();
    page(state);
    const c = counters();
    for (let k = 0; k < N; k += CHUNK) {
      const chunk: Record<string, { type: string; businessId: string; name: string }> = {};
      for (let i = k; i < k + CHUNK; i++) chunk[rid(i)] = { type: 'ExtendedTable', businessId: `t_${i}`, name: `Table ${i}` };
      state.receiveEnrichments(chunk);
      updateLabels(state, Object.keys(chunk));
    }
    const rebuilds = c.tiles.mock.calls.length;
    const readsBeforeFrame = c.widths.mock.calls.length;
    flushFit();
    const reads = c.widths.mock.calls.length;
    c.done();
    console.log(`300 badges, 12 chunks: ${rebuilds} rebuilds, ${reads} width reads (${readsBeforeFrame} before the frame)`);
    expect(rebuilds).toBe(N);
    expect(readsBeforeFrame).toBe(0);
    expect(reads).toBeLessThanOrEqual(N);
    // The names are the same as with the full pass.
    const named = [...document.querySelectorAll('.crev-label-text')].map(e => e.textContent);
    expect(named).toEqual(Array.from({ length: N }, (_, i) => `t_${i}`));
  });

  it('the full pass (no names given) still rebuilds every named badge: the old per-chunk cost', () => {
    const state = new ContentState();
    page(state);
    const c = counters();
    for (let k = 0; k < N; k += CHUNK) {
      const chunk: Record<string, { type: string; businessId: string }> = {};
      for (let i = k; i < k + CHUNK; i++) chunk[rid(i)] = { type: 'ExtendedTable', businessId: `t_${i}` };
      state.receiveEnrichments(chunk);
      updateLabels(state);
    }
    const rebuilds = c.tiles.mock.calls.length;
    c.done();
    console.log(`full pass per chunk: ${rebuilds} rebuilds`);
    // 25 + 50 + … + 300 = 1,950: every badge named so far, per chunk.
    expect(rebuilds).toBe(1950);
  });
});
