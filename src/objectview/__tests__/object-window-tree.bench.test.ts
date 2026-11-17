// @vitest-environment happy-dom
/**
 * Measurement for the review item "every selection rebuilds the whole tree"
 * (PERF-11): a 100-row structure tree, 20 arrow-key steps, elements built and
 * time per step. `npm test` checks that the tree expands; the numbers are
 * printed only with `npm run bench` (CREV_BENCH=1).
 */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';

const ROOT = '1304972940111718401';
const rid = (i: number) => String(2_000_000_000_000_000_000n + BigInt(i));
const obj = (r: string, type: string, name: string): FullObject => ({ rid: r, type, name, businessId: `b${r.slice(-4)}`, props: { name: { kind: 'text', text: name } }, references: {}, overridden: [] });

describe('object window tree selection (100 rows)', () => {
  it('measures one arrow-key step', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ rid: rid(i), parent: i < 10 ? ROOT : rid(Math.floor(i / 10) - 1) }));
    const nodes = Object.fromEntries(rows.map((r, i) => [r.rid, obj(r.rid, i % 3 ? 'ButtonInput' : 'InputSet', `Row ${i}`)]));
    const payload: ObjectRootPayload = { rid: ROOT, root: obj(ROOT, 'InputView', 'Root'), rows, nodes, posts: 1, ms: 1 } as ObjectRootPayload;
    const src = { openRoot: vi.fn(async () => payload), readSummaries: vi.fn(async () => []), fieldList: vi.fn(async () => []), readObjects: vi.fn(async () => ({ objects: {}, errors: {} })), run: vi.fn(async () => ({ ok: true })) } as unknown as ObjectWindowSource;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    let controller!: ObjectWindowController;
    const noop = vi.fn();
    const handlers = { navigate: noop, back: noop, forward: noop, retry: noop, copy: noop, openInEditor: noop, openBlueprint: noop, selected: (o: FullObject) => controller.nodeSelected(o), edit: noop, revert: noop, toggleReset: noop, discard: noop, save: noop, setTarget: noop, compare: noop, access: noop } as unknown as ViewHandlers;
    const view = new ObjectWindowView(root, handlers);
    controller = new ObjectWindowController(view, src);
    await controller.open(ROOT, { type: 'InputView' });
    const tree = root.querySelector<HTMLElement>('[role=tree]')!;
    // Expand everything (Right on each collapsed row).
    for (let i = 0; i < 30; i++) for (const r of [...root.querySelectorAll<HTMLElement>('[role=treeitem][aria-expanded="false"]')]) { r.click(); tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); }
    const shown = root.querySelectorAll('[role=treeitem]').length;
    root.querySelector<HTMLElement>('[role=treeitem]')!.click();
    const create = vi.spyOn(document, 'createElement');
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      tree.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      times.push(performance.now() - t);
    }
    const perStep = create.mock.calls.length / 20;
    create.mockRestore();
    times.sort((a, b) => a - b);
    if (process.env.CREV_BENCH) console.log(`${shown} rows shown: ${perStep.toFixed(0)} elements built per step, median ${times[10].toFixed(1)} ms (happy-dom)`);
    expect(shown).toBeGreaterThan(50);
  });
});
