// @vitest-environment happy-dom
/**
 * The reference editor in the object window's property row (one object, a
 * user or group, a list of objects): the closed row, opening (the allowed
 * objects read once), the loading, failed, empty and too-many states, picks
 * and their staging, search, stored objects no longer allowed, the staged
 * look, the dated note, refusals, and that other rows keep their editors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import { DATED_NOTE, type AllowedObjects, type DefinitionFacts, type TypePropertySchema } from '../../lib/property-schema';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import { mockChromeStorage } from '../../lib/__tests__/chrome-mock';
import { ALLOWED, DEF, ITEMS, schema as fixtureSchema } from '../../lib/__tests__/fixtures/property-fields';

const RID = '4000000000000000001';
const t = (text: string): PropValue => ({ kind: 'text', text });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

const [CUSTOMER, SUPPLIER, PARTNER] = ALLOWED[DEF.regions].map(i => i.rid);
const [ALICE, BOB] = ALLOWED[DEF.owner].map(i => i.rid);

function object(refs: Record<string, string[]> = {}): FullObject {
  return {
    rid: RID, type: 'CeProcess', name: 'Sample process', businessId: '110',
    props: { name: t('Sample process'), [DEF.note]: t(''), [DEF.summary]: t('') },
    references: { [DEF.kind]: [ITEMS[0].rid], [DEF.regions]: [SUPPLIER], [DEF.owner]: [ALICE], ...refs }, overridden: [],
  };
}

/** The fixture schema with the owner's definition replaced. */
async function ownerSchema(def: DefinitionFacts): Promise<TypePropertySchema> {
  const s = await fixtureSchema();
  return { ...s, definitions: { ...s.definitions, [DEF.owner]: def } };
}

type Allowed = NonNullable<ObjectWindowSource['allowedObjects']>;

async function mount(opts: { obj?: FullObject; schema?: TypePropertySchema; allowed?: Allowed; refHandlers?: boolean } = {}) {
  const obj = opts.obj ?? object();
  const s = opts.schema ?? await fixtureSchema();
  const allowedObjects = vi.fn<Allowed>(opts.allowed ?? (async (_rid, def) => ({ items: ALLOWED[def] ?? [] })));
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async (): Promise<ObjectRootPayload> => ({ rid: RID, root: obj, rows: null, nodes: {}, posts: 1, ms: 1 })),
    readSummaries: vi.fn(async () => ({ summaries: [] })),
    fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: { [RID]: obj }, errors: {} })),
    propertySchema: vi.fn(async () => s),
    allowedObjects,
    run: vi.fn(async () => ({ ok: true })),
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    editCustom: (rid, prop, value) => controller.editCustom(rid, prop, value),
    ...(opts.refHandlers === false ? {} : {
      loadAllowed: (rid: string, prop: string, o?: { refresh?: boolean }) => controller.loadAllowed(rid, prop, o),
      referenceRow: (rid: string, prop: string) => controller.referenceRow(rid, prop),
      editReferences: (rid: string, prop: string, rids: readonly string[]) => controller.editReferences(rid, prop, rids),
    }),
    revert: (rid, prop) => controller.revert(rid, prop),
    toggleReset: vi.fn(), discard: vi.fn(), save: vi.fn(), setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
  };
  controller = new ObjectWindowController(new ObjectWindowView(root, handlers), src, { confirmSave: async () => true, unknownRereadDelayMs: 0 });
  await controller.open(RID);
  await flush();
  return { root, controller, allowedObjects, handlers };
}

const row = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`.ow-pr2[data-key="${key}"]`)!;
const search = (root: HTMLElement, key: string) => row(root, key).querySelector<HTMLInputElement>('input.ow-ref-q');
const chips = (root: HTMLElement, key: string) => [...row(root, key).querySelectorAll<HTMLElement>('.ow-ref-chip')].map(c => c.dataset.rid);
const options = (root: HTMLElement, key: string) => [...row(root, key).querySelectorAll<HTMLElement>('.ow-ref-opt')];
const names = (root: HTMLElement, key: string) => options(root, key).map(o => o.querySelector('.nm')!.textContent);
const ticked = (root: HTMLElement, key: string) => options(root, key).filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.querySelector('.nm')!.textContent);
const press = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const mouse = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
const choose = (root: HTMLElement, key: string, name: string) => mouse(options(root, key).find(o => o.querySelector('.nm')!.textContent === name)!);
const type = (input: HTMLInputElement, text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };

async function open(root: HTMLElement, key: string): Promise<void> {
  row(root, key).querySelector<HTMLElement>('.ow-ref-box')!.click();
  await flush();
}

beforeEach(() => {
  document.body.textContent = '';
  mockChromeStorage();
});

describe('the closed reference row', () => {
  it('shows the chips with name, ID and open arrow, and the edit affordance', async () => {
    const { root } = await mount();
    const r = row(root, DEF.regions);
    expect(r.classList.contains('can')).toBe(true);
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER]);
    expect(r.querySelector('.ow-ref-go')?.getAttribute('aria-label')).toBe('Edit Relevant regions');
    expect(r.querySelector('.ow-ref-chip .ow-ref-open')).not.toBeNull();
    expect(search(root, DEF.regions)).toBeNull();
  });

  it('the open arrow navigates and does not open the editor', async () => {
    const { root, handlers, allowedObjects } = await mount();
    row(root, DEF.owner).querySelector<HTMLButtonElement>('.ow-ref-chip .ow-ref-open')!.click();
    expect(handlers.navigate).toHaveBeenCalledWith(ALICE);
    expect(search(root, DEF.owner)).toBeNull();
    expect(allowedObjects).not.toHaveBeenCalled();
  });

  it('without the reference handlers the row is read-only', async () => {
    const { root } = await mount({ refHandlers: false });
    for (const def of [DEF.owner, DEF.regions]) {
      expect(row(root, def).classList.contains('can')).toBe(false);
      expect(row(root, def).querySelector('.ow-ref-box, input')).toBeNull();
    }
  });
});

describe('opening', () => {
  it('reads the allowed objects once, also when opened again', async () => {
    const { root, allowedObjects } = await mount();
    await open(root, DEF.regions);
    expect(search(root, DEF.regions)?.placeholder).toBe('Search name or ID');
    // By name, whatever order the server gave.
    expect(names(root, DEF.regions)).toEqual(['Customer onboarding', 'Partner onboarding', 'Supplier onboarding']);
    expect(options(root, DEF.regions)[0].querySelector('.ow-ref-id')?.textContent).toBe('110');
    press(search(root, DEF.regions)!, 'Escape');
    expect(search(root, DEF.regions)).toBeNull();
    await open(root, DEF.regions);
    expect(allowedObjects).toHaveBeenCalledTimes(1);
    expect(allowedObjects).toHaveBeenCalledWith(RID, DEF.regions, 'CeProcess');
  });

  it('while reading: the current chips and one quiet line', async () => {
    let answer!: (a: AllowedObjects) => void;
    const { root } = await mount({ allowed: () => new Promise(res => { answer = res; }) });
    row(root, DEF.regions).querySelector<HTMLElement>('.ow-ref-box')!.click();
    expect(row(root, DEF.regions).querySelector('.ow-ref-pop')?.textContent).toContain('Reading the allowed objects…');
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER]);
    expect(row(root, DEF.regions).querySelector('.ow-ref-x')).toBeNull();
    answer({ items: ALLOWED[DEF.regions] });
    await flush();
    expect(row(root, DEF.regions).textContent).not.toContain('Reading the allowed objects…');
    expect(names(root, DEF.regions)).toHaveLength(3);
  });

  it('a failed read says why and offers Try again', async () => {
    let fail = true;
    const { root, allowedObjects } = await mount({
      allowed: async (_rid, def) => { if (fail) throw new Error('Expression failed'); return { items: ALLOWED[def] }; },
    });
    await open(root, DEF.regions);
    const pop = row(root, DEF.regions).querySelector<HTMLElement>('.ow-ref-pop')!;
    expect(pop.textContent).toContain('Expression failed');
    fail = false;
    [...pop.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Try again')!.click();
    await flush();
    expect(allowedObjects).toHaveBeenCalledTimes(2);
    expect(names(root, DEF.regions)).toHaveLength(3);
  });

  it('no allowed objects: says so', async () => {
    const { root } = await mount({ allowed: async () => ({ items: [] }) });
    await open(root, DEF.regions);
    expect(row(root, DEF.regions).querySelector('.ow-ref-pop')?.textContent).toContain('This property allows no objects for this object.');
    expect(options(root, DEF.regions)).toHaveLength(0);
  });

  it('too many allowed objects: the row is read-only with the reason', async () => {
    const { root } = await mount({ allowed: async (_rid, def) => ({ items: ALLOWED[def], tooMany: true }) });
    await open(root, DEF.regions);
    const r = row(root, DEF.regions);
    expect(search(root, DEF.regions)).toBeNull();
    expect(r.classList.contains('can')).toBe(false);
    expect(r.querySelector('.ow-preason')?.textContent).toBe('The list is too long to choose from here');
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER]);
  });
});

describe('one object', () => {
  it('the current value is ticked; a pick stages it and closes; revert restores', async () => {
    const { root, controller } = await mount();
    await open(root, DEF.owner);
    expect(ticked(root, DEF.owner)).toEqual(['Alice']);
    choose(root, DEF.owner, 'Bob');
    expect(controller.dirtyCount).toBe(1);
    expect(search(root, DEF.owner)).toBeNull();
    expect(chips(root, DEF.owner)).toEqual([BOB]);
    const r = row(root, DEF.owner);
    expect(r.classList.contains('chg')).toBe(true);
    r.querySelector<HTMLButtonElement>('.ow-pr-a .ui-ibtn')!.click();
    expect(controller.dirtyCount).toBe(0);
    expect(chips(root, DEF.owner)).toEqual([ALICE]);
  });

  it('picking the current value closes without staging', async () => {
    const { root, controller } = await mount();
    await open(root, DEF.owner);
    choose(root, DEF.owner, 'Alice');
    expect(search(root, DEF.owner)).toBeNull();
    expect(controller.dirtyCount).toBe(0);
  });

  it('"Not set" is the first option only where the property may be empty', async () => {
    const blank = await mount({ schema: await ownerSchema({ configClass: 'ReferenceMethodConfig', multiselect: false, allowBlank: true, hasExpression: true }) });
    await open(blank.root, DEF.owner);
    expect(names(blank.root, DEF.owner)).toEqual(['Not set', 'Alice', 'Bob']);
    choose(blank.root, DEF.owner, 'Not set');
    expect(blank.controller.dirtyCount).toBe(1);
    expect(row(blank.root, DEF.owner).querySelector('.ow-ref-box .ow-pr-none')?.textContent).toBe('Not set');

    const strict = await mount({ schema: await ownerSchema({ configClass: 'ReferenceMethodConfig', multiselect: false, allowBlank: false, hasExpression: true }) });
    await open(strict.root, DEF.owner);
    expect(names(strict.root, DEF.owner)).toEqual(['Alice', 'Bob']);
  });

  it('Enter picks the highlighted option after arrow keys', async () => {
    const { root, controller } = await mount();
    await open(root, DEF.owner);
    const q = search(root, DEF.owner)!;
    press(q, 'ArrowDown');
    expect(row(root, DEF.owner).querySelector('.ow-ref-opt.on .nm')?.textContent).toBe('Bob');
    press(q, 'Enter');
    expect(controller.dirtyCount).toBe(1);
    expect(chips(root, DEF.owner)).toEqual([BOB]);
  });
});

describe('a list of objects', () => {
  it('a pick adds or removes the object and the editor stays open', async () => {
    const { root, controller } = await mount();
    await open(root, DEF.regions);
    expect(ticked(root, DEF.regions)).toEqual(['Supplier onboarding']);
    choose(root, DEF.regions, 'Customer onboarding');
    expect(search(root, DEF.regions)).not.toBeNull();
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER, CUSTOMER]);
    expect(ticked(root, DEF.regions)).toEqual(['Customer onboarding', 'Supplier onboarding']);
    expect(controller.dirtyCount).toBe(1);
    choose(root, DEF.regions, 'Supplier onboarding');
    expect(chips(root, DEF.regions)).toEqual([CUSTOMER]);
    // Back to the stored value: nothing staged.
    choose(root, DEF.regions, 'Supplier onboarding');
    choose(root, DEF.regions, 'Customer onboarding');
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER]);
    expect(controller.dirtyCount).toBe(0);
  });

  it('a chip\'s remove button, Clear all and Backspace in an empty search', async () => {
    const { root, controller } = await mount({ obj: object({ [DEF.regions]: [SUPPLIER, CUSTOMER, PARTNER] }) });
    await open(root, DEF.regions);
    row(root, DEF.regions).querySelector<HTMLButtonElement>(`.ow-ref-chip[data-rid="${CUSTOMER}"] .ow-ref-x`)!.click();
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER, PARTNER]);
    const q = search(root, DEF.regions)!;
    type(q, 'x');
    press(q, 'Backspace');
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER, PARTNER]);
    type(search(root, DEF.regions)!, '');
    press(search(root, DEF.regions)!, 'Backspace');
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER]);
    const clear = [...row(root, DEF.regions).querySelectorAll<HTMLButtonElement>('.ow-ref-clear')];
    expect(clear.map(b => b.getAttribute('aria-label') ?? b.title)).toEqual(['Clear all']);
    clear[0].click();
    expect(chips(root, DEF.regions)).toEqual([]);
    expect(row(root, DEF.regions).querySelector('.ow-ref-clear')).toBeNull();
    expect(search(root, DEF.regions)).not.toBeNull();
    expect(controller.dirtyCount).toBe(1);
  });

  it('search filters by name and by ID, ignoring case', async () => {
    const { root } = await mount();
    await open(root, DEF.regions);
    type(search(root, DEF.regions)!, 'PART');
    expect(names(root, DEF.regions)).toEqual(['Partner onboarding']);
    type(search(root, DEF.regions)!, '108');
    expect(names(root, DEF.regions)).toEqual(['Supplier onboarding']);
    type(search(root, DEF.regions)!, 'nothing like it');
    expect(names(root, DEF.regions)).toEqual([]);
    expect(row(root, DEF.regions).querySelector<HTMLElement>('.ow-menu-empty')?.hidden).toBe(false);
  });

  it('a search survives a pick', async () => {
    const { root } = await mount();
    await open(root, DEF.regions);
    type(search(root, DEF.regions)!, 'onboarding');
    choose(root, DEF.regions, 'Partner onboarding');
    expect(search(root, DEF.regions)?.value).toBe('onboarding');
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER, PARTNER]);
  });
});

describe('stored objects no longer allowed', () => {
  const without = (rid: string): Allowed => async (_r, def) => ({ items: (ALLOWED[def] ?? []).filter(i => i.rid !== rid) });

  it('show with a warning mark; they can be removed, not added again', async () => {
    const { root, controller } = await mount({ obj: object({ [DEF.regions]: [SUPPLIER, CUSTOMER] }), allowed: without(SUPPLIER) });
    await open(root, DEF.regions);
    const chip = row(root, DEF.regions).querySelector<HTMLElement>(`.ow-ref-chip[data-rid="${SUPPLIER}"]`)!;
    expect(chip.classList.contains('ow-ref-out')).toBe(true);
    expect(chip.title).toBe('No longer one of the allowed objects');
    expect(names(root, DEF.regions)).toEqual(['Customer onboarding', 'Partner onboarding']);
    chip.querySelector<HTMLButtonElement>('.ow-ref-x')!.click();
    expect(chips(root, DEF.regions)).toEqual([CUSTOMER]);
    expect(controller.dirtyCount).toBe(1);
  });

  it('may stay in the list while an allowed object is added; the editor stays open', async () => {
    const { root, controller } = await mount({ obj: object({ [DEF.regions]: [SUPPLIER, CUSTOMER] }), allowed: without(SUPPLIER) });
    await open(root, DEF.regions);
    // A list keeps what it holds: only the added object must be allowed.
    choose(root, DEF.regions, 'Partner onboarding');
    expect(row(root, DEF.regions).querySelector('.ow-perr')).toBeNull();
    expect(search(root, DEF.regions)).not.toBeNull();
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER, CUSTOMER, PARTNER]);
    expect(controller.dirtyCount).toBe(1);
  });
});

describe('the staged look and the dated note', () => {
  it('a staged list marks added objects and shows removed ones after them; revert clears it', async () => {
    const { root, controller } = await mount();
    await open(root, DEF.regions);
    choose(root, DEF.regions, 'Supplier onboarding');
    choose(root, DEF.regions, 'Customer onboarding');
    choose(root, DEF.regions, 'Partner onboarding');
    press(search(root, DEF.regions)!, 'Escape');
    expect(search(root, DEF.regions)).toBeNull();
    const r = row(root, DEF.regions);
    expect(r.classList.contains('chg')).toBe(true);
    expect(chips(root, DEF.regions)).toEqual([CUSTOMER, PARTNER, SUPPLIER]);
    const all = [...r.querySelectorAll<HTMLElement>('.ow-ref-chip')];
    expect(all.map(c => c.querySelector('.ow-ref-mk')?.textContent)).toEqual(['+', '+', '−']);
    expect(all.map(c => (c.classList.contains('ow-ref-add') ? 'add' : c.classList.contains('ow-ref-del') ? 'del' : ''))).toEqual(['add', 'add', 'del']);
    expect(r.textContent).not.toContain(DATED_NOTE);
    r.querySelector<HTMLButtonElement>('.ow-pr-a .ui-ibtn')!.click();
    expect(controller.dirtyCount).toBe(0);
    expect(row(root, DEF.regions).querySelector('.ow-ref-mk, .ow-ref-note')).toBeNull();
  });

  it('a historical property carries a clock after its name and no sentence, closed or open', async () => {
    const { root } = await mount();
    const kind = row(root, DEF.regions).querySelector<HTMLElement>('.ow-pr-l .ow-kind.hist');
    expect(kind?.title).toContain('historical');
    expect(kind?.querySelector('.ow-kind-h')).not.toBeNull();
    expect(row(root, DEF.regions).querySelectorAll('.ow-pr-l .ow-kind')).toHaveLength(1);
    expect(row(root, DEF.regions).textContent).not.toContain(DATED_NOTE);
    await open(root, DEF.regions);
    expect(row(root, DEF.regions).textContent).not.toContain(DATED_NOTE);
  });

  it('every row names its kind with a glyph before the name', async () => {
    const { root } = await mount();
    expect(row(root, DEF.regions).querySelector<HTMLElement>('.ow-pr-l .ow-kind')?.title).toMatch(/^List of references/);
    expect(row(root, DEF.owner).querySelector<HTMLElement>('.ow-pr-l .ow-kind')?.title).toMatch(/^User or group/);
  });

  it('a list emptied reads "Not set" with the removed objects struck through', async () => {
    const { root } = await mount();
    await open(root, DEF.regions);
    choose(root, DEF.regions, 'Supplier onboarding');
    press(search(root, DEF.regions)!, 'Escape');
    const box = row(root, DEF.regions).querySelector<HTMLElement>('.ow-ref-box')!;
    expect(box.querySelector('.ow-pr-none')?.textContent).toBe('Not set');
    expect(chips(root, DEF.regions)).toEqual([SUPPLIER]);
    expect(box.querySelector('.ow-ref-chip')?.classList.contains('ow-ref-del')).toBe(true);
  });
});

describe('one editor at a time; other rows unchanged', () => {
  it('opening a reference editor closes an open text editor and the other way round', async () => {
    const { root } = await mount();
    row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    expect(row(root, DEF.note).querySelector('input.ow-ped-in')).not.toBeNull();
    await open(root, DEF.regions);
    expect(row(root, DEF.note).querySelector('input.ow-ped-in')).toBeNull();
    expect(search(root, DEF.regions)).not.toBeNull();
    row(root, DEF.note).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    expect(search(root, DEF.regions)).toBeNull();
    expect(row(root, DEF.note).querySelector('input.ow-ped-in')).not.toBeNull();
  });

  it('a list item row keeps its choice menu', async () => {
    const { root } = await mount();
    row(root, DEF.kind).querySelector<HTMLButtonElement>('.ow-pbox')!.click();
    expect(row(root, DEF.kind).querySelectorAll('.ow-menu-opt:not(.ow-ref-opt)')).toHaveLength(ITEMS.length);
    expect(row(root, DEF.kind).querySelector('.ow-ref-ed')).toBeNull();
  });

  it('leaving the editor closes it and keeps what was picked', async () => {
    const { root, controller } = await mount();
    await open(root, DEF.regions);
    choose(root, DEF.regions, 'Partner onboarding');
    const q = search(root, DEF.regions)!;
    q.focus();
    q.blur();
    await flush();
    expect(search(root, DEF.regions)).toBeNull();
    expect(controller.dirtyCount).toBe(1);
  });
});
