// @vitest-environment happy-dom
/**
 * Blueprint while the user moves through pages (content-blueprint.ts
 * handlePageNav): the first load when Blueprint opens is immediate; a soft
 * navigation reads the new page's layout only after a short rest, and a page
 * passed through within the rest is never read. A load overtaken by a newer
 * one does not close Blueprint.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const loads = vi.hoisted(() => ({ rids: [] as string[], answers: [] as Array<(ok: boolean) => void> }));
vi.mock('../content-blueprint/service', async importOriginal => ({
  ...(await importOriginal<typeof import('../content-blueprint/service')>()),
  loadPage: vi.fn((rid: string) => {
    loads.rids.push(rid);
    return new Promise<boolean>(resolve => { loads.answers.push(resolve); });
  }),
}));
vi.mock('../content-blueprint/id-config', () => ({ loadPortableIdConfig: vi.fn(async () => {}) }));

const A = '9007199254740993001';
const B = '9007199254740993002';
const C = '9007199254740993003';
let page = A;
let blueprint: typeof import('../content-blueprint');
let state: typeof import('../content-blueprint/state');

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage: vi.fn(async () => undefined), id: 'test' },
  };
  blueprint = await import('../content-blueprint');
  state = await import('../content-blueprint/state');
  blueprint.setBlueprintRidResolver(() => page);
}, 60_000);

beforeEach(() => {
  vi.useFakeTimers();
  page = A;
  loads.rids.length = 0;
  loads.answers.length = 0;
});

afterEach(() => {
  blueprint.disableBlueprint();
  vi.useRealTimers();
});

const go = (rid: string) => { page = rid; window.dispatchEvent(new PopStateEvent('popstate')); };

describe('Blueprint page navigation rest', () => {
  it('opens at once, then reads only the page the user rests on', () => {
    blueprint.enableBlueprint();
    expect(loads.rids).toEqual([A]);
    go(B);
    vi.advanceTimersByTime(blueprint.BLUEPRINT_NAV_REST_MS - 50);
    go(C);
    vi.advanceTimersByTime(blueprint.BLUEPRINT_NAV_REST_MS - 50);
    expect(loads.rids).toEqual([A]);
    vi.advanceTimersByTime(50);
    expect(loads.rids).toEqual([A, C]);
    expect(state.bp.loadedRid).toBe(C);
  });

  it('a load overtaken by a newer page does not close Blueprint', async () => {
    blueprint.enableBlueprint();
    go(B);
    vi.advanceTimersByTime(blueprint.BLUEPRINT_NAV_REST_MS);
    expect(loads.rids).toEqual([A, B]);
    // A's answer arrives late; the service reports it as not loaded (another session generation).
    loads.answers[0](false);
    await Promise.resolve();
    await Promise.resolve();
    expect(state.bp.active).toBe(true);
  });

  it('closing Blueprint during the rest reads nothing', () => {
    blueprint.enableBlueprint();
    go(B);
    blueprint.disableBlueprint();
    vi.advanceTimersByTime(blueprint.BLUEPRINT_NAV_REST_MS * 2);
    expect(loads.rids).toEqual([A]);
  });
});
