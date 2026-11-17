// @vitest-environment happy-dom
/**
 * "overrides template" only where the value really differs from the linked
 * template's value; never on audit or identity fields; no chips and one
 * quiet line when the template cannot be read.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { overrides, overrideState } from '../window/override-diff';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';

const SC = '7705595896874502408';
const TPL = '7705595896874502400';
const STATUS_A = '5100000000000000001';
const STATUS_B = '5100000000000000002';

const t = (text: string): PropValue => ({ kind: 'text', text });
const bool = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });

function scorecard(rid: string, props: Record<string, PropValue>, refs: Record<string, string[]>, overridden: string[] = []): FullObject {
  return { rid, type: 'Scorecard', name: 'Processes', businessId: 'processes', props: { name: t('Processes'), ...props }, references: refs, overridden };
}

const PROPS = ['description', 'showHeader', 'lastModified', 'helpText', 'id'];
const instance = scorecard(SC,
  { description: t('Our processes'), showHeader: bool(true), lastModified: t('2026-11-01'), helpText: t('Same help'), id: t('processes') },
  { linkedTo: [TPL], statusType: [STATUS_B], yearDef: [STATUS_A] }, [...PROPS, 'statusType', 'yearDef']);
const template = scorecard(TPL,
  { description: t('Template text'), showHeader: bool(true), lastModified: t('2025-01-01'), helpText: t('Same help'), id: t('processes_tpl') },
  { statusType: [STATUS_A], yearDef: [STATUS_A] });

describe('override comparison', () => {
  const ready = overrideState(instance, { [TPL]: { obj: template } });

  it('equal value: no chip; different value: chip', () => {
    expect(overrides(instance, 'helpText', ready)).toBe(false);
    expect(overrides(instance, 'showHeader', ready)).toBe(false);
    expect(overrides(instance, 'description', ready)).toBe(true);
  });

  it('never on audit or identity fields', () => {
    expect(overrides(instance, 'lastModified', ready)).toBe(false);
    expect(overrides(instance, 'id', ready)).toBe(false);
    expect(overrides(instance, 'name', ready)).toBe(false);
  });

  it('never on the fields an instance and its template differ in by nature', () => {
    const a = { ...instance, props: { ...instance.props, uuid: t(SC), fullPath: t('/1/2/'), model: t('ORGANISATION'), link: bool(true), templateLinkedTo: bool(false), _templateLinkedTo: bool(false) } };
    const b = { ...template, props: { ...template.props, uuid: t(TPL), fullPath: t('/1/3/'), model: t('TEMPLATECATEGORY'), link: bool(false), templateLinkedTo: bool(true), _templateLinkedTo: bool(true) } };
    const st = overrideState(a, { [TPL]: { obj: b } });
    for (const k of ['uuid', 'fullPath', 'model', 'link', 'templateLinkedTo', '_templateLinkedTo', 'writeAccessors']) expect(overrides(a, k, st), k).toBe(false);
  });

  it('references follow the same rule', () => {
    expect(overrides(instance, 'statusType', ready, true)).toBe(true);
    expect(overrides(instance, 'yearDef', ready, true)).toBe(false);
  });

  it('no chip while the template is read, none when it failed, none without a template', () => {
    expect(overrides(instance, 'description', overrideState(instance, {}))).toBe(false);
    const failed = overrideState(instance, { [TPL]: { error: 'Read failed' } });
    expect(failed.kind).toBe('error');
    expect(overrides(instance, 'description', failed)).toBe(false);
    const unlinked = { ...instance, references: {} };
    expect(overrideState(unlinked, {}).kind).toBe('none');
  });
});

describe('override chips in the object window', () => {
  function mount(readObjects: ObjectWindowSource['readObjects']) {
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const payload: ObjectRootPayload = { rid: SC, root: instance, rows: [], nodes: {}, posts: 1, ms: 1 };
    const src: ObjectWindowSource = {
      openRoot: vi.fn(async () => payload),
      readSummaries: vi.fn(async () => []),
      fieldList: vi.fn(async () => []),
      readObjects: vi.fn(readObjects),
      run: vi.fn(async () => ({ ok: true })),
    };
    let controller!: ObjectWindowController;
    const handlers: ViewHandlers = {
      navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(),
      openInEditor: vi.fn(), openBlueprint: vi.fn(), selected: o => controller.nodeSelected(o),
      edit: vi.fn(), revert: vi.fn(), toggleReset: vi.fn(), discard: vi.fn(), save: vi.fn(),
      setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
      needTemplate: rid => controller.ensureTemplate(rid),
    };
    const view = new ObjectWindowView(root, handlers);
    controller = new ObjectWindowController(view, src);
    return { root, controller, src };
  }
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
  const chips = (root: HTMLElement) => [...root.querySelectorAll('.ow-detail .ow-tag')].filter(e => e.textContent === 'overrides template');

  it('reads the template once and marks only the rows that differ', async () => {
    const { root, controller, src } = mount(async rids => ({ objects: Object.fromEntries(rids.filter(r => r === TPL).map(r => [r, template])), errors: {} }));
    await controller.open(SC, { type: 'Scorecard' });
    await flush();
    expect(src.readObjects).toHaveBeenCalledTimes(1);
    expect(vi.mocked(src.readObjects).mock.calls[0][0]).toEqual([TPL]);
    // Description and the Status type reference differ; help text, header, audit and ID do not.
    const marked = chips(root).map(c => c.closest('.gv')?.previousElementSibling?.textContent);
    expect(marked).toEqual(['Description', 'Status type']);
    expect(root.querySelector('.ow-cmp-note')).toBeNull();
  });

  it('template unreadable: no chips and one quiet line', async () => {
    const { root, controller } = mount(async () => ({ objects: {}, errors: { [TPL]: 'Read failed' } }));
    await controller.open(SC, { type: 'Scorecard' });
    await flush();
    expect(chips(root)).toHaveLength(0);
    const notes = [...root.querySelectorAll('.ow-cmp-note')];
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0].textContent).toBe('Could not compare with the template');
  });
});
