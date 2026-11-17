// @vitest-environment happy-dom
/**
 * Blueprint's unsaved-work guard on a real unload (content-blueprint.ts
 * `onBeforeUnload`): the browser prompt is asked for only while staged edits
 * exist, not for Companion's own reload after an Apply, and the listener
 * goes away with the overlay. The page load and the staged-edit count are
 * stubbed; the lifecycle under test is the real one.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

const pending = vi.hoisted(() => ({ value: false }));
vi.mock('../content-blueprint/actions', async importOriginal => ({
  ...(await importOriginal<typeof import('../content-blueprint/actions')>()),
  hasPendingEdits: () => pending.value,
}));
vi.mock('../content-blueprint/service', async importOriginal => ({
  ...(await importOriginal<typeof import('../content-blueprint/service')>()),
  // The page model never arrives: the overlay stays in its loading shell.
  loadPage: vi.fn(() => new Promise<boolean>(() => {})),
}));
vi.mock('../content-blueprint/id-config', () => ({ loadPortableIdConfig: vi.fn(async () => {}) }));

let blueprint: typeof import('../content-blueprint');
let state: typeof import('../content-blueprint/state');

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}`, sendMessage: vi.fn(async () => undefined), id: 'test' },
  };
  blueprint = await import('../content-blueprint');
  state = await import('../content-blueprint/state');
  blueprint.setBlueprintRidResolver(() => '9007199254740993');
}, 60_000);

afterEach(() => {
  pending.value = false;
  state.bp.reloading = false;
  blueprint.disableBlueprint();
});

function unload(): BeforeUnloadEvent {
  const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(e);
  return e;
}

describe('Blueprint beforeunload guard', () => {
  it('asks for the browser prompt while staged edits exist', () => {
    blueprint.enableBlueprint();
    expect(state.bp.active).toBe(true);
    pending.value = true;
    expect(unload().defaultPrevented).toBe(true);
  });

  it('does not prompt for a clean session', () => {
    blueprint.enableBlueprint();
    pending.value = false;
    expect(unload().defaultPrevented).toBe(false);
  });

  it('does not prompt for Companion’s own reload after an Apply', () => {
    blueprint.enableBlueprint();
    pending.value = true;
    state.bp.reloading = true;
    expect(unload().defaultPrevented).toBe(false);
  });

  it('is removed with the overlay', () => {
    blueprint.enableBlueprint();
    blueprint.disableBlueprint();
    pending.value = true;
    expect(unload().defaultPrevented).toBe(false);
  });
});
