// @vitest-environment happy-dom
/**
 * The Numeric IDs tab drawn: the tab and its count, the list as the draft
 * shows it, the filters of Find, the fields for the new IDs, the footer, the
 * confirmation and the line after the change.
 */
import { describe, expect, it } from 'vitest';
import { TransportController } from '../transport-controller';
import { mountTransportView } from '../transport-view';
import { fakeWorker, row as findRow, scanResult } from './fakes';
import { flush, folder, row, setup } from './numeric-fakes';

const NOW = () => new Date(2026, 10, 19, 12, 0, 0);

function mount(o: Parameters<typeof setup>[0] = {}) {
  const s = setup({ areas: ['templateCategory'], ...o });
  const w = fakeWorker();
  const ctl = new TransportController(w.deps, { since: '2026-11-12' });
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  mountTransportView(host, ctl, { now: NOW, numeric: s.c, workspace: () => 'Steadfast demo' });
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => host.querySelector<T>(sel);
  const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...host.querySelectorAll<T>(sel)];
  return { s, ctl, host, $, $$ };
}

const rows = () => [
  row('11', '5612', 'Cleanup', { parentRid: 'F1' }),
  row('12', '5613', 'Other', { parentRid: 'F1' }),
  row('13', '316', 'My KPIs', { parentRid: 'F1', className: 'Tab' }),
];
const code: Array<[string, string, string]> = [['77', 'expression', 'a := t.5612'], ['78', 'expression', 'b := t.get("5612")']];

async function opened(o: Parameters<typeof setup>[0] = {}) {
  const m = mount({ rows: rows(), origins: [['13', 'System']], code, ...o });
  m.ctl.showTab('numeric');
  await flush(80);
  return m;
}

describe('the tab', () => {
  it('is the third tab, shows nothing and reads nothing until it is opened, then counts the objects', async () => {
    const m = mount({ rows: rows() });
    expect(m.$$('.tr-tab').map(t => t.dataset.tab)).toEqual(['find', 'transport', 'numeric']);
    expect(m.$('#tr-numeric')!.hidden).toBe(true);
    expect(m.s.sent).toEqual([]);
    m.$<HTMLButtonElement>('.tr-tab[data-tab="numeric"]')!.click();
    await flush(80);
    expect(m.ctl.tab).toBe('numeric');
    expect(m.$('#tr-numeric')!.hidden).toBe(false);
    expect(m.$('#tr-find')!.hidden).toBe(true);
    expect(m.$('.tr-tab[data-tab="numeric"]')!.textContent).toBe('Numeric IDs 3');
    expect(m.$('.ni-read')!.textContent).toBe('Read 19 Nov 12:00');
  });

  it('is not there without a controller for it', () => {
    const w = fakeWorker();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    mountTransportView(host, new TransportController(w.deps, { since: '2026-11-12' }));
    expect(host.querySelector('#tr-numeric')).toBeNull();
    expect([...host.querySelectorAll<HTMLElement>('.tr-tab')].map(t => t.dataset.tab)).toEqual(['find', 'transport']);
  });

  it('opens from the "auto ID" tag in Find', async () => {
    const auto = findRow({ id: '40213' });
    const s = setup({ rows: rows(), areas: ['templateCategory'] });
    const w = fakeWorker(msg => scanResult(msg, { rows: msg.root === 'portal' ? [auto] : [] }));
    const ctl = new TransportController(w.deps, { since: '2026-11-12' });
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    mountTransportView(host, ctl, { now: NOW, numeric: s.c });
    ctl.setChanged('7d');
    await flush(40);
    const tag = host.querySelector<HTMLButtonElement>(`.tr-row[data-rid="${auto.rid}"] .tr-tag.auto`)!;
    expect(tag.tagName).toBe('BUTTON');
    tag.click();
    expect(ctl.tab).toBe('numeric');
    await flush(80);
    expect(host.querySelector('#tr-numeric')!.hasAttribute('hidden')).toBe(false);
  });
});

describe('the list', () => {
  it('shows the area and folder, then each object with its type, name, old ID, arrow, new ID and the count of code', async () => {
    const { $, $$ } = await opened();
    const area = $('.ni-area')!;
    expect(area.textContent).toContain('Templates');
    expect($$('.ni-fold').map(r => r.querySelector('.ni-ft')!.textContent)).toEqual(expect.arrayContaining(['Templates', 'Folder one']));
    const r = $('.ni-row[data-rid="11"]')!;
    expect(r.querySelector('.bdg')).not.toBeNull();
    expect(r.querySelector('.ni-nm')!.textContent).toBe('Cleanup');
    expect(r.querySelector('.ni-old')!.textContent).toBe('5612');
    expect(r.querySelector<HTMLInputElement>('.ni-nid')!.value).toBe('cleanup');
    expect(r.querySelector('.ni-code')!.textContent).toBe('2');
    expect(r.querySelector('.ni-code')!.getAttribute('title')).toBe('Code in 2 objects names this ID');
    expect($('.ni-row[data-rid="12"] .ni-code')).toBeNull();
    expect($<HTMLInputElement>('.ni-row[data-rid="11"] .ni-ck')!.checked).toBe(true);
  });

  it('lists BMP\'s own last, in a group that starts closed and unticked', async () => {
    const { $, $$ } = await opened();
    expect($('.ni-row[data-rid="13"]')).toBeNull();
    const head = $('.ni-bmp')!;
    expect(head.textContent).toContain("Probably BMP's own");
    expect(head.textContent).toContain('1');
    expect($$('.ni-row').pop()).toBe(head);
    $<HTMLButtonElement>('.ni-bmp .ni-caret')!.click();
    const bmp = $('.ni-row[data-rid="13"]')!;
    expect(bmp.querySelector<HTMLInputElement>('.ni-ck')!.checked).toBe(false);
    expect(bmp.classList.contains('off')).toBe(true);
    expect(bmp.querySelector('.ni-nm')!.getAttribute('title')).toMatch(/System/);
  });

  it('folds a folder with its caret', async () => {
    const { $ } = await opened();
    const key = $('.ni-fold[data-node="F1"] .ni-caret')!.getAttribute('data-key')!;
    $<HTMLButtonElement>(`.ni-caret[data-key="${key}"]`)!.click();
    expect($('.ni-row[data-rid="11"]')).toBeNull();
    $<HTMLButtonElement>(`.ni-caret[data-key="${key}"]`)!.click();
    expect($('.ni-row[data-rid="11"]')).not.toBeNull();
  });

  it('says there is nothing when no area has a number', async () => {
    const { $ } = await opened({ rows: [] });
    expect($('.ni-empty')!.textContent).toBe('No numeric IDs in these areas.');
    expect($('.tr-tab[data-tab="numeric"]')!.textContent).toBe('Numeric IDs 0');
  });
});

describe('the filters of Find', () => {
  it('the box narrows by name or ID and marks the words', async () => {
    const { $, $$ } = await opened();
    const input = $<HTMLInputElement>('.ni .tr-q')!;
    expect(input.placeholder).toBe('Name or ID');
    input.value = 'cleanup';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect($$('.ni-row[data-rid]').map(r => r.dataset.rid)).toEqual(['11']);
    expect($('.ni-row[data-rid="11"] mark')!.textContent).toBe('Cleanup');
    input.value = '5613';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect($$('.ni-row[data-rid]').map(r => r.dataset.rid)).toEqual(['12']);
  });

  it('the Areas button offers the areas of Find but Properties, and reads one chosen later', async () => {
    const { $, s } = await opened();
    const pop = $('.ni .pop-areas')!;
    expect(pop.hidden).toBe(true);
    $<HTMLButtonElement>('.ni .tr-where')!.click();
    expect(pop.hidden).toBe(false);
    const names = [...pop.querySelectorAll('.tr-opt span')].map(x => x.textContent);
    expect(names).toContain('Templates');
    expect(names).not.toContain('Properties');
    s.sent.length = 0;
    const box = pop.querySelector<HTMLInputElement>('input[data-root="role"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush(80);
    expect(s.sent.filter(m => m.type === 'NUMERIC_IDS_SCAN').map(m => m.root)).toEqual(['role']);
    expect($('.ni .tr-where')!.textContent).toContain('Areas:');
  });
});

describe('the new IDs', () => {
  it('a typed ID that cannot be used turns the field red with its reason, and the row leaves the count', async () => {
    const { $ } = await opened();
    expect($('.ni .tr-selcount')!.textContent).toBe('2 of 2');
    expect($('.ni .tr-open')!.textContent).toBe('Change 2 IDs');
    const input = $<HTMLInputElement>('.ni-row[data-rid="11"] .ni-nid')!;
    input.value = 'bad id';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('bad')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.title).toMatch(/Letters/);
    expect($('.ni .tr-selcount')!.textContent).toBe('1 of 2');
    expect($('.ni .tr-open')!.textContent).toBe('Change 1 ID');
    // No banner: the status line stays empty.
    expect($('.ni-status')!.textContent).toBe('');
    input.value = 'btn_mine';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.classList.contains('bad')).toBe(false);
    expect($('.ni .tr-selcount')!.textContent).toBe('2 of 2');
    // Leaving the field empty shows the proposal again.
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
    expect(input.value).toBe('cleanup');
  });

  it('a tick on a folder ticks what is under it, and the header box all that shows', async () => {
    const { $ } = await opened();
    const fold = $<HTMLInputElement>('.ni-fold[data-node="F1"] .ni-ck')!;
    expect(fold.checked).toBe(true);
    fold.checked = false;
    fold.dispatchEvent(new Event('change', { bubbles: true }));
    expect($<HTMLInputElement>('.ni-row[data-rid="11"] .ni-ck')!.checked).toBe(false);
    expect($('.ni .tr-selcount')!.textContent).toBe('0 of 2');
    expect($<HTMLButtonElement>('.ni .tr-open')!.disabled).toBe(true);
    const one = $<HTMLInputElement>('.ni-row[data-rid="12"] .ni-ck')!;
    one.checked = true;
    one.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fold.indeterminate).toBe(true);
    const all = $<HTMLInputElement>('.ni-all')!;
    all.checked = true;
    all.dispatchEvent(new Event('change', { bubbles: true }));
    expect($('.ni .tr-selcount')!.textContent).toBe('2 of 2');
  });
});

describe('the code copy', () => {
  it('says once, quietly, that code is not checked, with the way to make a copy', async () => {
    const { $ } = await opened({ copy: { ready: false, reason: 'no code copy on this computer', canMake: true } });
    expect($('.ni-note')!.textContent).toContain('Code is not checked: no code copy on this computer.');
    expect($('.ni-note button')!.textContent).toBe('Make a copy');
    expect($('.ni-code')).toBeNull();
  });

  it('has no link when the server cannot be copied', async () => {
    const { $ } = await opened({ copy: { ready: false, reason: 'a copy cannot be made of this server', canMake: false } });
    expect($('.ni-note')!.textContent).toBe('Code is not checked: a copy cannot be made of this server.');
    expect($('.ni-note button')).toBeNull();
  });
});

describe('the change', () => {
  it('says in the confirmation when a row was left out because its new ID is used', async () => {
    const { $, s } = await opened();
    s.fail.factsTaken = new Set(['t.cleanup']);
    $<HTMLButtonElement>('.ni .tr-open')!.click();
    await flush(80);
    expect($('.ni-dlg h2')!.textContent).toBe('Change 1 ID in Steadfast demo');
    expect($('.ni-dlg .ni-dnote')!.textContent).toBe('1 row left out: the new ID is already used.');
  });

  it('asks once, lists old to new and the code, then changes and says what happened', async () => {
    const { $, $$, s } = await opened();
    $<HTMLButtonElement>('.ni .tr-open')!.click();
    await flush(80);
    const dlg = $('.ni-dlg')!;
    expect(dlg.querySelector('h2')!.textContent).toBe('Change 2 IDs in Steadfast demo');
    expect($$('.ni-drow').map(r => [r.querySelector('.ni-old')!.textContent, r.querySelector('.ni-new')!.textContent])).toEqual([['5612', 'cleanup'], ['5613', 'other']]);
    expect(dlg.querySelector('.ni-dnote')!.textContent).toBe('Also changes code in 2 objects.');
    expect(s.writes).toEqual([]);
    expect(s.ids.get('11')).toBe('5612');
    const buttons = [...dlg.querySelectorAll('button')].map(b => b.textContent);
    expect(buttons).toEqual(['Cancel', 'Change IDs']);
    [...dlg.querySelectorAll('button')].find(b => b.textContent === 'Change IDs')!.click();
    await flush(200);
    expect($('.ni-scrim')!.hidden).toBe(true);
    expect($('.ni-status')!.textContent).toBe('Changed 2 IDs and code in 2 objects.');
    expect($('.ni-row[data-rid="11"]')).toBeNull();
    expect(s.ids.get('11')).toBe('cleanup');
    expect(s.texts.get('77|expression')).toBe('a := t.cleanup');
    expect($('.tr-tab[data-tab="numeric"]')!.textContent).toBe('Numeric IDs 0');
    // The last change can be changed back, after the window is closed too.
    const back = $<HTMLButtonElement>('.ni-back')!;
    expect(back.hidden).toBe(false);
    back.click();
    await flush(200);
    expect(s.ids.get('11')).toBe('5612');
    expect(s.texts.get('77|expression')).toBe('a := t.5612');
    expect($('.ni-back')!.hidden).toBe(true);
    expect($('.ni-status')!.textContent).toBe('Changed back 2 IDs and 2 scripts. Refresh to list them again.');
  });

  it('Cancel writes nothing', async () => {
    const { $, s } = await opened();
    $<HTMLButtonElement>('.ni .tr-open')!.click();
    await flush(80);
    [...$('.ni-dlg')!.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!.click();
    expect($('.ni-scrim')!.hidden).toBe(true);
    expect(s.sent.some(m => m.type === 'NUMERIC_IDS_RUN')).toBe(false);
  });

  it('keeps a row that was not changed, with its reason', async () => {
    const { $, s } = await opened();
    s.fail.commitFail = 1;
    $<HTMLButtonElement>('.ni .tr-open')!.click();
    await flush(80);
    [...$('.ni-dlg')!.querySelectorAll('button')].find(b => b.textContent === 'Change IDs')!.click();
    await flush(200);
    expect($('.ni-row[data-rid="11"] .ni-why')!.textContent).toBe('Server error');
    expect($('.ni-status')!.textContent).toBe('Changed 0 IDs. 2 not changed.');
  });
});

describe('the folder of a numbered object', () => {
  it('keeps a folder\'s context when it has no number itself', async () => {
    const { $ } = await opened({ rows: [row('11', '5612', 'Cleanup', { parentRid: 'F2' })], context: [folder('F1', 'folder_one', 'Folder one'), { ...folder('F2', 'folder_two', 'Folder two'), parentRid: 'F1', parentId: 'folder_one' }] });
    expect($('.ni-fold[data-node="F1"]')).not.toBeNull();
    expect($('.ni-fold[data-node="F2"]')).not.toBeNull();
    expect($('.ni-row[data-rid="11"]')!.style.getPropertyValue('--d')).toBe('3');
  });
});
