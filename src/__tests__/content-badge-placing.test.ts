// @vitest-environment happy-dom
/**
 * A new floating badge (tabs, menu tiles, links, widgets) appears once, at
 * its final place: it is hidden until the first layout pass has placed it,
 * and that pass runs in the next frame instead of after the settle delay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ContentState } from '../content-state';
import { syncOverlays } from '../content-overlays';
import { PLACING_CLASS, placeNewBadges, runBadgeLayout } from '../content-badge-layout';

const { sendToSW } = vi.hoisted(() => ({ sendToSW: vi.fn() }));
vi.mock('../lib/content-port', () => ({ sendToSW }));
vi.mock('../lib/messaging', () => ({ sendFireForget: vi.fn() }));

describe('first placement of a badge', () => {
  let state: ContentState;

  beforeEach(() => {
    document.body.innerHTML = '<a id="tab" href="/?rid=111">Overview</a>';
    state = new ContentState();
    state.enrichMode = 'all';
    delete document.documentElement.dataset.crevBadgeLayout;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('mounts a floating badge hidden, and the layout pass reveals it with its offset', () => {
    syncOverlays(state);
    const label = document.querySelector<HTMLElement>('#tab > .crev-label')!;
    expect(label.classList.contains(PLACING_CLASS)).toBe(true);
    runBadgeLayout();
    expect(label.classList.contains(PLACING_CLASS)).toBe(false);
  });

  it('reveals the badge also when the layout is switched off', () => {
    syncOverlays(state);
    document.documentElement.dataset.crevBadgeLayout = 'off';
    runBadgeLayout();
    expect(document.querySelector(`.${PLACING_CLASS}`)).toBeNull();
  });

  it('places a waiting badge in the next frame, not after the settle delay', () => {
    vi.useFakeTimers();
    syncOverlays(state);
    placeNewBadges();
    vi.advanceTimersToNextFrame();
    expect(document.querySelector(`.${PLACING_CLASS}`)).toBeNull();
  });

  it('nothing animates a badge\'s position', () => {
    const css = readFileSync('src/content-overlay.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const labelRules = css.split('}').filter(r => /\.crev-label[^{]*\{/.test(r) && !/crev-stub|crev-sub|crev-cascade|crev-tile|#crev/.test(r.split('{')[0]));
    for (const r of labelRules) expect(r, r).not.toMatch(/transition[^;]*(translate|top|left|right|all)/);
  });
});
