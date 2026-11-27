// @vitest-environment happy-dom
/**
 * The Atlas view with a type that has many references: long lists show their
 * first part and an expander that stays open while the type stays picked,
 * references are drawn with an arrow icon and read aloud in words, and a
 * running read changes only its own status.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mountAtlasView, SIDE_SHOWN, ROWS_SHOWN, type AtlasActions, type AtlasState } from '../atlas-view';
import type { AtlasEdge, AtlasModel } from '../../lib/atlas/model';

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
});

const FOCUS = 'CeAssuranceActivity';
function bigModel(): AtlasModel {
  const edges: AtlasEdge[] = [];
  const types: AtlasModel['types'] = { [FOCUS]: { cls: FOCUS, name: 'Enterprise assurance activity with a very long name that never ends', count: 40, seen: 40 } };
  for (let i = 0; i < 30; i++) {
    const other = `CeOther${String(i).padStart(2, '0')}`;
    types[other] = { cls: other, name: `Other type ${i}`, count: i, seen: i };
    edges.push({ from: FOCUS, prop: `ref_${String(i).padStart(2, '0')}`, label: `Reference ${i}`, multi: true, to: [other], declared: true, filled: 30 - i });
    edges.push({ from: other, prop: `back_${i}`, label: `Back ${i}`, multi: false, to: [FOCUS], declared: true, filled: 1 });
  }
  return { types, edges, reverses: [], sample: 2000, unread: [] };
}

function state(over: Partial<AtlasState> = {}): AtlasState {
  return {
    view: 'type', server: 'bmp.example/Steadfast', model: bigModel(), fetchedAt: Date.now(), readMs: 6200, reading: false, readSince: null, progress: null,
    error: null, notice: null, cell: null, focus: FOCUS, prop: null,
    route: { from: null, to: null, routes: [], key: null, scope: 'all', tab: 'rows', rows: null, rowsFor: null, total: 0, loading: false, since: null, error: null, start: 'this.object' },
    home: null, usage: null, query: '', matches: [], ...over,
  };
}

const actions = new Proxy({}, { get: () => vi.fn() }) as unknown as AtlasActions;

describe('Atlas view, One type with long lists', () => {
  it('shows the first part of each list with "Show all", keeps it open for the type, and closes it for another', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const view = mountAtlasView(host, actions);
    view.render(state());
    const cols = host.querySelectorAll('.at-col');
    expect(cols[0].querySelectorAll('.at-card')).toHaveLength(SIDE_SHOWN);
    expect(host.querySelectorAll('.at-focus .at-row')).toHaveLength(ROWS_SHOWN);
    const more = cols[0].querySelector<HTMLButtonElement>('.at-more')!;
    expect(more.textContent).toBe('Show all 30');
    more.click();
    expect(host.querySelectorAll('.at-col')[0].querySelectorAll('.at-card')).toHaveLength(30);
    expect(host.querySelectorAll('.at-col')[0].querySelector('.at-more')!.textContent).toBe('Show fewer');
    // Drawn again for the same type (a reference picked): still open.
    view.render(state({ prop: 'ref_29' }));
    expect(host.querySelectorAll('.at-col')[0].querySelectorAll('.at-card')).toHaveLength(30);
    // The picked reference is shown though it is past the first part.
    expect([...host.querySelectorAll('.at-focus .at-row.on')].map(r => r.querySelector('.at-row-p')?.textContent)).toEqual(['ref_29']);
    // Another type: closed again.
    view.render(state({ focus: 'CeOther01' }));
    view.render(state());
    expect(host.querySelectorAll('.at-col')[0].querySelectorAll('.at-card')).toHaveLength(SIDE_SHOWN);
  });

  it('draws a reference with an arrow icon and says it in words', () => {
    const host = document.createElement('div');
    const view = mountAtlasView(host, actions);
    view.render(state({ prop: 'ref_00' }));
    const sub = host.querySelector('.at-sub-ref')!;
    expect(sub.querySelector('svg.at-arrow use')?.getAttribute('href')).toBe('#i-arrow');
    expect(sub.querySelector('.sr-only')?.textContent).toBe(' references ');
    expect(sub.textContent).not.toMatch(/\u2192|->/);
  });

  it('says what a running read does, keeps the copy in use, and changes only the status while it runs', () => {
    const host = document.createElement('div');
    const view = mountAtlasView(host, actions);
    const s = state({ reading: true, readSince: Date.now() });
    view.render(s);
    const card = host.querySelector('.at-card');
    expect(host.querySelector<HTMLElement>('.at-progress')!.hidden).toBe(false);
    expect(host.querySelector('.at-ptext')!.textContent).toMatch(/stays in use/);
    s.progress = { step: 'held', done: 12, total: 140, startedAt: Date.now() };
    view.live(s);
    expect(host.querySelector('.at-pstep')!.textContent).toBe('Step 2 of 3: What the references hold, 12 of 140 types');
    expect(host.querySelector('.at-card')).toBe(card);
    view.render(state());
    expect(host.querySelector<HTMLElement>('.at-progress')!.hidden).toBe(true);
    expect(host.querySelector('.at-read')!.textContent).toMatch(/^31 types, 60 references, read in 6\.2 s \u00b7 as of \d\d:\d\d$/);
  });
});
