// @vitest-environment happy-dom
/**
 * The save note names a custom value that is not stored as sent also when
 * another object of the same save failed (the rows stay marked as before).
 * The note is read from the controller: the bar shows it once nothing is
 * unsaved.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import type { SaveStep } from '../window/save-plan';
import { DEF, schema as fixtureSchema } from '../../lib/__tests__/fixtures/property-fields';

const ROOT = '4000000000000000001';
const NODE = '4000000000000000002';
const t = (text: string): PropValue => ({ kind: 'text', text });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

const object = (rid: string, note: string): FullObject => ({
  rid, type: 'CeProcess', name: `Object ${rid.slice(-1)}`, businessId: `b${rid.slice(-1)}`,
  props: { name: t(`Object ${rid.slice(-1)}`), [DEF.note]: t(note) }, references: {}, overridden: [],
});

describe('settle note', () => {
  it('names both a failed other object and a custom value not stored as sent', async () => {
    const schema = await fixtureSchema();
    let written = false;
    const current = () => ({ [ROOT]: object(ROOT, written ? 'Changed by a rule' : 'Old'), [NODE]: object(NODE, 'Old') });
    const run = vi.fn<ObjectWindowSource['run']>(async (step: SaveStep) => {
      if (step.rid === NODE) return { ok: false, error: 'Access denied' };
      written = true;
      return { ok: true };
    });
    const src: ObjectWindowSource = {
      openRoot: vi.fn(async (): Promise<ObjectRootPayload> => ({ rid: ROOT, root: object(ROOT, 'Old'), rows: null, nodes: { [NODE]: object(NODE, 'Old') }, posts: 1, ms: 1 })),
      readSummaries: vi.fn(async () => ({ summaries: [] })),
      fieldList: vi.fn(async () => []),
      readObjects: vi.fn(async (rids: readonly string[]) => {
        const all = current();
        return { objects: Object.fromEntries(rids.map(r => [r, all[r as keyof typeof all]])), errors: {} };
      }),
      propertySchema: vi.fn(async () => schema),
      run,
    };
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    let controller!: ObjectWindowController;
    const handlers: ViewHandlers = {
      navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
      selected: o => controller.nodeSelected(o),
      edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
      editCustom: (rid, prop, value) => controller.editCustom(rid, prop, value),
      revert: (rid, prop) => controller.revert(rid, prop),
      toggleReset: vi.fn(), discard: vi.fn(), save: () => { void controller.save(); }, setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
    };
    controller = new ObjectWindowController(new ObjectWindowView(root, handlers), src, { confirmSave: async () => true, unknownRereadDelayMs: 0 });
    await controller.open(ROOT);
    await flush();
    controller.editCustom(ROOT, DEF.note, 'Mine');
    controller.editCustom(NODE, DEF.note, 'Theirs');
    expect(controller.dirtyCount).toBe(2);
    await controller.save();
    expect(run).toHaveBeenCalledTimes(2);
    // The note itself (the bar shows it once nothing is unsaved; while rows
    // stay marked it shows "Not saved: <object>").
    const note = (controller as unknown as { saveNote?: string }).saveNote ?? '';
    expect(note).toContain('Saved 0, 1 object not saved');
    expect(note).toContain('Not stored as sent: Note (note): "Changed by a rule"');
    expect(controller.dirtyCount).toBe(2);
  });
});
