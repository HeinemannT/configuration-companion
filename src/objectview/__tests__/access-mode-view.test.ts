// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import type { ObjectRootPayload } from '../../lib/object-window';
import type { AccessSubject, AccessTraceNode } from '../../lib/types';
import type { ActionVerdicts } from '../../lib/access-mode';
import { DENY_IGNORED } from '../../lib/access-wording';
import { ObjectWindowView, type ViewHandlers } from '../window/view';
import { ObjectWindowController, type ObjectWindowSource } from '../window/controller';
import { AccessMode, type AccessSource, type DecideAnswer } from '../window/access-state';

const VIEW = '1304972940111718401';
const SET = '1521507040334396171';
const ROLE_OBJ = '1521507040334396999';
const t = (text: string): PropValue => ({ kind: 'text', text });
const obj = (rid: string, type: string, name: string): FullObject =>
  ({ rid, type, name, businessId: `b${rid.slice(-3)}`, props: { name: t(name) }, references: rid === VIEW ? {} : { parent: [VIEW] }, overridden: [] });

const payload: ObjectRootPayload = {
  rid: VIEW, root: obj(VIEW, 'InputView', 'Update date'),
  rows: [{ rid: SET, parent: VIEW }, { rid: ROLE_OBJ, parent: VIEW }],
  nodes: { [SET]: obj(SET, 'InputSet', 'Inputs'), [ROLE_OBJ]: obj(ROLE_OBJ, 'Role', 'Auditor') },
  posts: 1, ms: 1,
};
const SUBJECTS: AccessSubject[] = [
  { rid: '900', name: 'Maya', kind: 'user', businessId: 'maya_chen' },
  { rid: '901', name: 'Process Manager', kind: 'role', businessId: 'roleProcessManager' },
];
const allowed: ActionVerdicts = { READ: { state: 'allowed', by: [{ policyRid: '7', policyName: 'Portal objects', index: 0, effect: 'ALLOW', via: 'role:roleBasic' }], evaluated: 3 }, UPDATE: { state: 'denied', evaluated: 3, denyMatched: [] }, CREATE: { state: 'denied', evaluated: 3, denyMatched: [] }, DELETE: { state: 'unknown', reason: 'Timed out' } };
const tick = () => new Promise(r => setTimeout(r, 0));

function mount(sourceOver: Partial<AccessSource> = {}) {
  const decide = vi.fn(async (req: { requestId: string; environment: string; subjectRid: string; rids: string[] }): Promise<DecideAnswer> =>
    ({ ...req, ok: true, verdicts: Object.fromEntries(req.rids.map(r => [r, allowed])) }));
  const accessSource: AccessSource = {
    status: async () => ({}),
    prepare: async () => ({ subjects: SUBJECTS, available: true, environmentName: 'DEV' }),
    decide,
    trace: async req => ({ ...req, ok: false, error: 'not in this test' }),
    loadPrefs: async () => ({ recents: [] }),
    savePrefs: () => { /* none */ },
    ...sourceOver,
  };
  const mode = new AccessMode(accessSource);
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  let controller!: ObjectWindowController;
  const handlers: ViewHandlers = {
    navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), retry: vi.fn(), copy: vi.fn(), openInEditor: vi.fn(), openBlueprint: vi.fn(),
    selected: o => controller.nodeSelected(o),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    revert: vi.fn(), toggleReset: vi.fn(), discard: vi.fn(), save: vi.fn(), setTarget: vi.fn(), compare: vi.fn(), access: vi.fn(),
  };
  const view = new ObjectWindowView(root, handlers, { access: { mode, handlers: { openRule: vi.fn(), openTest: vi.fn(), copy: vi.fn() } } });
  const src: ObjectWindowSource = {
    openRoot: vi.fn(async () => { mode.setEnvironment('p1@https://bmp/'); return payload; }),
    readSummaries: vi.fn(async () => []), fieldList: vi.fn(async () => []),
    readObjects: vi.fn(async () => ({ objects: {}, errors: {} })), run: vi.fn(async () => ({ ok: true })),
  };
  controller = new ObjectWindowController(view, src);
  return { root, view, controller, mode, handlers, decide };
}

const btn = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.ow-acc-btn')!;

describe('access mode in the object window', () => {
  it('toggles the mode: R W A D columns, the access pane, and a pressed button', async () => {
    const { root, controller } = mount();
    await controller.open(VIEW);
    await tick();
    expect(btn(root).getAttribute('aria-pressed')).toBe('false');
    btn(root).click();
    await tick();
    expect(btn(root).getAttribute('aria-pressed')).toBe('true');
    expect(btn(root).textContent).toContain('On');
    expect([...root.querySelectorAll('.ow-tree-head .ow-slots .m')].map(e => e.textContent)).toEqual(['R', 'W', 'A', 'D']);
    expect(root.querySelector('.ow-detail .ow-ac')).toBeTruthy();
    expect(document.activeElement?.id).toBe('ow-cb-input');
  });

  it('picks a subject with the keyboard and fills every row from one request', async () => {
    const { root, controller, decide } = mount();
    await controller.open(VIEW);
    btn(root).click();
    await tick();
    const input = root.querySelector<HTMLInputElement>('#ow-cb-input')!;
    input.value = 'proc';
    input.dispatchEvent(new Event('input'));
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.ow-cb-foot')?.textContent).toBe('1 match');
    expect(input.getAttribute('aria-activedescendant')).toBe('ow-cb-o0');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(); await tick();
    expect(input.value).toBe('Process Manager');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0].rids).toEqual([VIEW, SET, ROLE_OBJ]);
    const row = root.querySelector(`.ow-row[data-rid="${SET}"]`)!;
    expect(row.getAttribute('aria-label')).toBe('Inputs: Read allowed, Write not granted, Add child not granted, Delete could not evaluate');
    expect([...row.querySelectorAll('.ow-sl')].map(c => c.className.split(' ').pop())).toEqual(['allowed', 'denied', 'denied', 'unknown']);
    // One explanation line under the cells; the trace does not repeat it.
    expect(root.querySelector('.ow-ac-why')?.textContent).toBe('Granted by Portal objects · statement 1 · through role roleBasic');
    expect(root.querySelector('.ow-ac-decided, .ow-ac-sentence')).toBeNull();
    expect(root.querySelector('[data-act="DELETE"] .vw')?.textContent).toBe('No result');
  });

  it('the verdict strip is a radio group moved with the arrow keys', async () => {
    const { root, controller, mode } = mount();
    await controller.open(VIEW);
    btn(root).click();
    mode.pick(SUBJECTS[0]);
    await tick(); await tick();
    const strip = root.querySelector<HTMLElement>('.ow-ac-verdicts')!;
    expect(strip.getAttribute('role')).toBe('radiogroup');
    strip.querySelector<HTMLElement>('[data-act="READ"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(mode.action).toBe('UPDATE');
    expect(root.querySelector('[data-act="UPDATE"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('leaving the mode returns to the detail pane with pending edits intact', async () => {
    const { root, controller } = mount();
    await controller.open(VIEW);
    controller.edit(VIEW, 'name', 'Renamed', 'Update date');
    btn(root).click();
    await tick();
    expect(root.querySelector('.ow-bar-long')?.textContent).toBe('1 unsaved change');
    btn(root).click();
    await tick();
    expect(root.querySelector('.ow-ac')).toBeNull();
    expect(root.querySelector('.ow-sub-name h2')?.textContent).toBe('Renamed');
    expect(controller.dirtyCount).toBe(1);
  });

  it('an older server disables the toggle with a reason, and nothing throws', async () => {
    const { root, controller, mode } = mount({ status: async () => ({ available: false, reason: 'This BMP version has no access test command.' }) });
    await controller.open(VIEW);
    await tick();
    expect(mode.availability).toBe('unavailable');
    // Focusable and hoverable, so the reason can be read; a click does nothing.
    expect(btn(root).getAttribute('aria-disabled')).toBe('true');
    btn(root).click();
    expect(mode.on).toBe(false);
    expect(btn(root).title).toContain('no access test command');
    expect(btn(root).textContent).toContain('Unavailable');
  });

  it('a Role still opens the Access workspace', async () => {
    const { root, controller, view, handlers } = mount();
    await controller.open(VIEW);
    view.select(ROLE_OBJ);
    expect(btn(root).textContent).toContain('Open in Access');
    btn(root).click();
    expect(handlers.access).toHaveBeenCalledWith(expect.objectContaining({ rid: ROLE_OBJ, type: 'Role' }));
  });

  it('a denial: one line under the cells, then the statements, "Not granting" as a disclosure row with a summary', async () => {
    const node = (element: string, result: boolean | null, details: Record<string, string> = {}, children: AccessTraceNode[] = []): AccessTraceNode =>
      ({ element, result, timedOut: false, details, children });
    const st = (name: string, subject: boolean, action: boolean) => node('Statement', false, { policyRid: '7', policyRid_name: name, statementIndex: '0', effect: 'ALLOW' },
      [node('Subject', subject, { original: '[role:roleX]' }), node('Action', action, { actions: '[CREATE]', requestedAction: 'UPDATE' })]);
    const trace = node('TraceRequest', false, {}, [st('All Organisational Content - Maintain (by Organization Manager)', true, false), st('Other', false, true)]);
    const { root, controller, mode } = mount({ trace: async req => ({ ...req, ok: true, trace }) });
    await controller.open(VIEW);
    btn(root).click();
    mode.pick(SUBJECTS[0]);
    await tick(); await tick();
    mode.setAction('UPDATE');
    await tick(); await tick();
    expect(root.querySelector('.ow-ac-why')?.textContent).toBe('Not granted: no statement grants Write.');
    expect(root.querySelector('.ow-ac-vc[data-act="UPDATE"] .vw')?.textContent).toBe('Not granted');
    expect(root.querySelector('.ow-ac-body')?.textContent).not.toContain('No statement grants write on this node');
    const grp = root.querySelector<HTMLElement>('.ow-ac-grp')!;
    expect(grp.querySelector('.t')?.textContent).toBe('Not granting');
    expect(grp.querySelector('.n')?.textContent).toBe('2');
    expect(grp.querySelector('.sum')?.textContent).toBe('1 for another action · 1 for another subject');
    expect(grp.getAttribute('aria-expanded')).toBe('true');
    const row = root.querySelector('.ow-ac-row.stmt')!;
    // The reason sits inside the row's toggle, next to the policy name.
    expect(row.querySelector('.why')?.textContent).toBe('Action does not match');
    expect(row.querySelector('.pn')?.textContent).toBe('All Organisational Content - Maintain (by Organization Manager)');
  });

  it('a matched Deny statement grants nothing: quiet, named as ignored, never "Denied"', async () => {
    const node = (element: string, result: boolean | null, details: Record<string, string> = {}, children: AccessTraceNode[] = []): AccessTraceNode =>
      ({ element, result, timedOut: false, details, children });
    const deny = node('Statement', false, { policyRid: '9', policyRid_name: 'Block edits', statementIndex: '1', effect: 'DENY' },
      [node('Subject', true, { original: '[role:roleX]' }), node('Action', true, { actions: '[UPDATE]', requestedAction: 'UPDATE' }), node('All', true)]);
    const trace = node('TraceRequest', false, {}, [deny]);
    const { root, controller, mode } = mount({ trace: async req => ({ ...req, ok: true, trace }) });
    await controller.open(VIEW);
    btn(root).click();
    mode.pick(SUBJECTS[0]);
    await tick(); await tick();
    mode.setAction('UPDATE');
    await tick(); await tick();
    const why = root.querySelector('.ow-ac-why')?.textContent ?? '';
    expect(why).toContain('Not granted: no statement grants Write.');
    expect(why).toContain(DENY_IGNORED);
    const grp = root.querySelector<HTMLElement>('.ow-ac-grp')!;
    expect(grp.querySelector('.sum')?.textContent).toBe('1 matched Deny (grants nothing)');
    const row = root.querySelector('.ow-ac-row.stmt')!;
    expect(row.querySelector('.why')?.textContent).toBe('Matched, grants nothing');
    // Quiet and neutral: no error colour class, no deny glyph.
    expect(row.querySelector('.st')?.className).toBe('st ign');
    expect(row.getAttribute('title')).toContain(DENY_IGNORED);
    expect(root.querySelector('.ow-ac-tnote')?.textContent).toContain(DENY_IGNORED);
    expect(root.querySelector('.ow-ac-body')?.textContent).not.toMatch(/Deny matched|Denied|does not cancel/);
  });

  it('the kind filter sits in the popup; the count line is announced, not shown', async () => {
    const { root, controller } = mount();
    await controller.open(VIEW);
    btn(root).click();
    await tick();
    const input = root.querySelector<HTMLInputElement>('#ow-cb-input')!;
    expect(root.querySelector('.ow-ac-bar .ow-ac-kind')?.closest('.ow-cb-pop')).toBeTruthy();
    input.value = 'ma';
    input.dispatchEvent(new Event('input'));
    expect([...root.querySelectorAll('.ow-cb-h')].map(h => h.textContent)).toEqual(['Matches']);
    expect(root.querySelector('.ow-cb-foot')?.classList.contains('ow-sr')).toBe(true);
  });
});
