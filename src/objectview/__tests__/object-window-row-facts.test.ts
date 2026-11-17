// @vitest-environment happy-dom
/**
 * The object window's tree when the row facts could not be read: one line
 * that says why (connection sentences for session causes) with Retry, the
 * listed rows kept; and unknown markers for rows whose facts failed alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullObject } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';

const SET = '1521507040334396171';
const A = '2081208944661642130';
const B = '7635189582946656799';

const root: FullObject = { rid: SET, type: 'InputSet', name: 'Inputs', businessId: 'set', props: {}, references: {}, overridden: [] };

function payload(over: Partial<ObjectRootPayload>): ObjectRootPayload {
  return { rid: SET, root, rows: [{ rid: A, parent: SET }, { rid: B, parent: SET }], nodes: {}, posts: 2, ms: 10, ...over };
}

function mount(p: ObjectRootPayload) {
  const openRoot = vi.fn<ObjectWindowSource['openRoot']>(async () => p);
  const src = { openRoot, readSummaries: vi.fn(async () => []), fieldList: vi.fn(async () => []), readObjects: vi.fn(async () => ({ objects: {}, errors: {} })), run: vi.fn(async () => ({ ok: true })) } as unknown as ObjectWindowSource;
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers = {
    navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), retry: () => { void controller.retry(); }, copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    edit: vi.fn(), revert: vi.fn(), toggleReset: vi.fn(), discard: vi.fn(), save: vi.fn(), setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
  } as unknown as ViewHandlers;
  const view = new ObjectWindowView(root, handlers);
  controller = new ObjectWindowController(view, src);
  return { root, controller, openRoot };
}

describe('object window: row facts not read', () => {
  beforeEach(() => { document.body.textContent = ''; });

  it('says why in one line with the connection sentence, keeps the rows, and Retry reads again', async () => {
    const { root, controller, openRoot } = mount(payload({ rowFactsError: { message: 'BMP rejected portal authentication', kind: 'not-signed-in', rows: 2 } }));
    await controller.open(SET, { type: 'InputSet' });
    expect(root.querySelectorAll('.ow-row')).toHaveLength(3);
    const line = root.querySelector('.ow-tree-facts')!;
    expect(line.textContent).toContain('Names and markers of the rows could not be read.');
    expect(line.textContent).toContain('You are not signed in to BMP.');
    expect(line.getAttribute('title')).toBe('BMP rejected portal authentication');
    const retry = [...line.querySelectorAll('button')].find(b => b.textContent?.includes('Retry'))!;
    retry.click();
    await new Promise(r => setTimeout(r, 0));
    expect(openRoot).toHaveBeenCalledTimes(2);
  });

  it('shows no line when the facts were read', async () => {
    const { root, controller } = mount(payload({}));
    await controller.open(SET, { type: 'InputSet' });
    expect(root.querySelector('.ow-tree-facts')).toBeNull();
  });

  it('marks the markers of a row whose facts failed alone as unknown', async () => {
    const lite = (rid: string, factsUnknown?: boolean): FullObject => ({ rid, type: 'ButtonInput', name: `B ${rid.slice(-2)}`, businessId: rid, props: {}, references: {}, overridden: [], lite: true, ...(factsUnknown ? { factsUnknown } : {}) });
    const { root, controller } = mount(payload({ nodes: { [A]: lite(A, true), [B]: lite(B) } }));
    await controller.open(SET, { type: 'InputSet' });
    const row = root.querySelector(`#ow-r-${A}`)!;
    expect(row.querySelector('.nm')?.textContent).toBe('B 30');
    const marks = [...row.querySelectorAll('.ow-slots .m.unk')];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every(m => m.textContent === '?' && /could not be read/.test(m.getAttribute('title') ?? ''))).toBe(true);
    expect(root.querySelector(`#ow-r-${B} .m.unk`)).toBeNull();
  });
});
