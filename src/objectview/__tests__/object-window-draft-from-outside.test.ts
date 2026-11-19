// @vitest-environment happy-dom
/** A change opened from outside (Point and tell) is staged in the window's own draft once the object has landed. */
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import type { ObjectWindowView } from '../window/view';

const BTN = '2081208944661642130';
const t = (text: string): PropValue => ({ kind: 'text', text });

function button(): FullObject {
  return { rid: BTN, type: 'ActionButton', name: 'Export', businessId: 'btn_export', props: { name: t('Export'), id: t('btn_export'), buttonText: t('Export') }, references: {}, overridden: [] };
}

function setup() {
  const models: Array<{ draft: { get: (rid: string, prop: string) => { kind: string; value?: string; base?: string } | undefined }; saveNote?: string }> = [];
  const view = { update: (m: (typeof models)[number]) => { models.push(m); } } as unknown as ObjectWindowView;
  const payload: ObjectRootPayload = { rid: BTN, root: button(), rows: [], nodes: {}, posts: 1, ms: 1 };
  const src = {
    openRoot: vi.fn(async () => payload),
    readSummaries: vi.fn(async () => []),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })),
    run: vi.fn(async () => ({ ok: true })),
  } as unknown as ObjectWindowSource;
  const controller = new ObjectWindowController(view, src, { confirmSave: async () => true });
  return { controller, models, last: () => models[models.length - 1] };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };

describe('stageDraft', () => {
  it('waits for the object to land, then holds the change in the draft with the stored value as its base', async () => {
    const { controller, last } = setup();
    controller.stageDraft(BTN, 'buttonText', 'Download');
    void controller.open(BTN);
    await flush();
    expect(last().draft.get(BTN, 'buttonText')).toMatchObject({ kind: 'value', value: 'Download', base: 'Export' });
  });

  it('on an object already shown, stages at once', async () => {
    const { controller, last } = setup();
    await controller.open(BTN);
    await flush();
    controller.stageDraft(BTN, 'buttonText', 'Download');
    expect(last().draft.get(BTN, 'buttonText')).toMatchObject({ kind: 'value', value: 'Download' });
  });

  it('a property the window does not edit stages nothing and says so', async () => {
    const { controller, last } = setup();
    await controller.open(BTN);
    await flush();
    controller.stageDraft(BTN, 'banana', 'x');
    expect(last().draft.get(BTN, 'banana')).toBeUndefined();
    expect(last().saveNote).toBe('banana cannot be changed in this window.');
  });
});
