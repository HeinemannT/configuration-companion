/**
 * The Colors tab: the workspace's color sets on the left, the chosen set's
 * colors as swatches, an editor on the right (name, picker, hex, the contrast
 * of white and black text on it). Add a color, add a set, change a color's
 * name or value. Changes stay on the page until one confirm bar lists them;
 * the write is previewed on the server, and a fresh read checks it.
 * There is no delete here: nobody has verified what BMP does to objects still
 * linked to a deleted color.
 */
import { attrs, btn, el, icon } from '../lib/dom';
import { normalizeHex, textOn } from '../lib/colors-images/color-math';
import {
  addColor, addSet, changeCount, editColor, editNewColor, emptyDraft, hasChanges, pendingChanges, problems,
  removeNewColor, removeNewSet, renameNewColor, setViews, verifyColors, type ColorDraft, type ColorView, type SetView,
} from '../lib/colors-images/colors-draft';
import type { ColorSetData } from '../lib/types';
import { readColors, writeChanges } from './api';
import { drawConfirmBar, readFoot, statusBlock, type ConfirmRow, type PageCtx } from './common';
import { createPicker, type Picker } from './picker';

const swatch = (hex: string, cls = 'ci-chip') => attrs(el('i', cls), { style: `background:${hex}` });

export interface Tab {
  root: HTMLElement;
  /** Read the data the first time the tab is shown. */
  show(): void;
  hasUnsaved(): boolean;
}

export function createColorsTab(ctx: PageCtx): Tab {
  let sets: ColorSetData[] | null = null;
  let fetchedAt: number | null = null;
  let loadError = '';
  let loading = false;
  let draft: ColorDraft = emptyDraft();
  let selSet = '';
  let selColor = '';
  let addingSet = false;
  let saving = false;
  let saveError = '';
  let result = '';
  let resultBad = false;
  let counter = 0;

  const side = el('div', 'ci-side');
  const main = el('div', 'ci-main');
  const panel = el('div', 'ci-panel');
  const bar = el('div', 'ci-confirm');
  bar.hidden = true;
  const root = el('div', 'ci-view ci-colors', side, main, panel, bar);
  root.hidden = true;


  const views = (): SetView[] => (sets ? setViews(sets, draft) : []);
  const currentSet = (): SetView | undefined => views().find(v => v.id === selSet) ?? views()[0];
  const currentColor = (): ColorView | undefined => currentSet()?.colors.find(c => c.key === selColor);

  async function load(force: boolean): Promise<void> {
    if (loading) return;
    loading = true;
    loadError = '';
    drawAll();
    try {
      const r = await ctx.work(readColors(force));
      sets = r.sets;
      fetchedAt = r.fetchedAt;
      if (r.error) loadError = `Showing the copy read earlier. ${r.error}`;
      if (!views().some(v => v.id === selSet)) { selSet = views()[0]?.id ?? ''; selColor = ''; }
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      drawAll();
    }
  }

  // ── the list of sets ──────────────────────────────────────────────

  function drawSide(): void {
    const head = el('div', 'ci-side-h', el('span', '', 'Color sets'),
      btn('ci-ib', 'Add color set', () => { addingSet = !addingSet; drawSide(); if (addingSet) side.querySelector<HTMLInputElement>('.ci-addset input')?.focus(); }, icon('i-plus', 'ic-sm')));
    const list = el('div', 'ci-side-list');
    if (addingSet) {
      const input = attrs(el('input', 'ci-inp') as HTMLInputElement, { placeholder: 'Name of the set', 'aria-label': 'Name of the new color set' });
      const done = () => {
        const name = input.value.trim();
        if (!name || !sets) return;
        const beside = sets[0]?.id;
        if (!beside) return;
        draft = addSet(draft, sets, name, sets.find(s => s.id === selSet)?.id ?? beside);
        const created = draft.newSets[draft.newSets.length - 1];
        selSet = created.id; selColor = ''; addingSet = false; result = '';
        drawAll();
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') { addingSet = false; drawSide(); } });
      list.append(el('div', 'ci-addset', input, btn('ui-btn', undefined, done, 'Add')));
    }
    for (const v of views()) {
      const chips = el('span', 'ci-chips', ...v.colors.slice(0, 4).map(c => swatch(c.hex)));
      const row = btn(`ci-srow${v.id === (currentSet()?.id) ? ' on' : ''}`, undefined, () => { selSet = v.id; selColor = ''; addingSet = false; drawAll(); },
        chips, el('span', 'ci-srow-name', v.name), v.isNew ? el('span', 'ci-tag', 'New') : null, el('span', 'ci-n', String(v.colors.length)));
      attrs(row, { title: `${v.name}  ${v.id}` });
      list.append(row);
    }
    side.replaceChildren(head, list, readFoot(fetchedAt, () => { void load(true); }, hasChanges(draft) ? 'Save or cancel the changes first' : undefined));
    list.querySelector('.ci-srow.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ── the colors of the chosen set ──────────────────────────────────

  function drawMain(): void {
    if (!sets) {
      main.replaceChildren(loading ? statusBlock('Reading the colors…') : statusBlock(loadError || 'The colors were not read.', () => { void load(true); }));
      return;
    }
    const set = currentSet();
    if (!set) { main.replaceChildren(statusBlock('This workspace has no color sets.')); return; }
    const head = el('div', 'ci-mhead', el('span', 'ci-title', set.name), el('span', 'ci-id', set.id), el('span', 'ci-grow'),
      loadError ? el('span', 'ci-warn', loadError) : null,
      result ? el('span', `ci-result${resultBad ? ' bad' : ''}`, result) : null);
    const sel = selColor && set.colors.some(c => c.key === selColor) ? selColor : (set.colors[0]?.key ?? '');
    selColor = sel;
    const tiles = set.colors.map(c => {
      const changed = !!c.was && (c.was.hex !== c.hex || c.was.name !== c.name);
      const hx = el('div', 'ci-hx', c.was && c.was.hex !== c.hex ? el('s', '', c.was.hex) : null, el('b', changed || c.isNew ? 'on' : '', c.hex));
      const t = btn(`ci-ctile${c.key === sel ? ' on' : ''}`, undefined, () => { selColor = c.key; drawMain(); drawPanel(); }, attrs(el('div', 'ci-sw'), { style: `background:${c.hex}` }), el('div', 'ci-nm', c.name), hx);
      attrs(t, { title: `${c.name}  ${c.id}` });
      return t;
    });
    const add = btn('ci-ctile add', 'Add color', () => {
      if (!sets) return;
      const key = `new${++counter}`;
      const base = currentColor()?.hex ?? '#808080';
      const next = addColor(draft, sets, set.id, key, base);
      draft = next.draft; selColor = key; result = '';
      drawAll();
      panel.querySelector<HTMLInputElement>('.ci-name')?.select();
    }, el('div', 'ci-sw', icon('i-plus')), el('div', 'ci-nm muted', 'Add color'));
    main.replaceChildren(head, el('div', 'ci-scroll', el('div', 'ci-cgrid', ...tiles, add)));
  }

  // ── the editor ────────────────────────────────────────────────────

  let picker: Picker | null = null;

  function liveUpdate(): void {
    // Everything that shows the colour being edited, except the fields the person is typing in.
    drawMain();
    drawSide();
    drawBar();
  }

  function drawPanel(): void {
    picker = null;
    const set = currentSet();
    const c = currentColor();
    if (!sets || !set || !c) {
      panel.replaceChildren(el('div', 'ci-ph', el('span', 'ci-title muted', set && sets ? 'No color in this set' : '')),
        set?.isNew ? el('div', 'ci-end', btn('ci-link', undefined, () => { draft = removeNewSet(draft, set.id); selSet = ''; selColor = ''; drawAll(); }, 'Remove this new set')) : '');
      return;
    }
    const probs = problems(sets, draft);
    const setData = sets.find(s => s.id === set.id);
    const apply = (field: 'name' | 'hex', value: string) => {
      result = '';
      if (c.isNew) {
        draft = field === 'name' ? renameNewColor(draft, sets!, c.key, value) : editNewColor(draft, c.key, { hex: value });
        if (field === 'name') {
          const idInput = panel.querySelector<HTMLInputElement>('.ci-newid');
          const upd = draft.newColors.find(n => n.key === c.key);
          if (idInput && upd && document.activeElement !== idInput) idInput.value = upd.id;
        }
      } else draft = editColor(draft, setData, c.id, field, value);
      liveUpdate();
      paintHead();
    };

    const name = attrs(el('input', 'ci-inp ci-name') as HTMLInputElement, { 'aria-label': 'Name' });
    name.value = c.name;
    name.addEventListener('input', () => apply('name', name.value));

    const hexChip = swatch(c.hex, 'ci-chip lg');
    const hex = attrs(el('input', 'ci-inp mono') as HTMLInputElement, { 'aria-label': 'Hex value', spellcheck: 'false', maxlength: '7' });
    hex.value = c.hex;
    const invalid = (on: boolean) => { if (on) hex.setAttribute('aria-invalid', 'true'); else hex.removeAttribute('aria-invalid'); };

    const ontext = el('div', 'ci-ontext');
    const paintContrast = (value: string) => {
      const t = textOn(value);
      ontext.replaceChildren(...[['#FFFFFF', 'White', t.white], ['#000000', 'Black', t.black]].map(([ink, label, ratio]) =>
        attrs(el('div', '', el('b', '', 'Aa'), el('span', '', String(ratio))), { style: `background:${value};color:${ink}`, title: `${label} text, contrast ${ratio}` })));
    };
    paintContrast(c.hex);

    picker = createPicker(c.hex, value => {
      hexChip.style.background = value;
      hex.value = value; invalid(false);
      paintContrast(value);
      apply('hex', value);
    });
    hex.addEventListener('input', () => {
      const v = normalizeHex(hex.value);
      invalid(!v);
      if (!v) return;
      hexChip.style.background = v;
      picker?.set(v);
      paintContrast(v);
      apply('hex', v);
    });
    hex.addEventListener('blur', () => {
      const now = currentColor();
      if (now) { hex.value = now.hex; invalid(false); }
    });

    const own = c.isNew ? draft.newColors.find(n => n.key === c.key) : undefined;
    const idField = c.isNew && own
      ? el('div', 'ci-field', el('label', 'ci-lab', 'ID'), (() => {
        const input = attrs(el('input', 'ci-inp mono ci-newid') as HTMLInputElement, { 'aria-label': 'ID', spellcheck: 'false' });
        input.value = own.id;
        input.addEventListener('input', () => { draft = editNewColor(draft, c.key, { id: input.value.trim() }); result = ''; drawBar(); paintHead(); });
        return input;
      })())
      : null;
    const problem = probs.get(c.key);
    const changed = !c.isNew && !!draft.edits[c.id];

    const head = el('div', 'ci-ph');
    function paintHead(): void {
      const now = currentColor();
      head.replaceChildren(el('span', 'ci-title', now?.name || ' '), el('span', 'ci-id', now?.id ?? ''));
    }
    paintHead();
    panel.replaceChildren(...[
      head,
      el('div', 'ci-field', el('label', 'ci-lab', 'Name'), name),
      idField,
      el('div', 'ci-field', el('label', 'ci-lab', 'Color'), picker.el, el('div', 'ci-hexrow', hexChip, hex)),
      el('div', 'ci-field', el('label', 'ci-lab', 'Text on it'), ontext),
      problem ? el('div', 'ci-problem', icon('i-warn', 'ic-sm'), el('span', '', problem)) : null,
      el('div', 'ci-end', c.isNew
        ? btn('ci-link', undefined, () => { draft = removeNewColor(draft, c.key); selColor = ''; drawAll(); }, 'Remove from this change')
        : changed ? btn('ci-link', undefined, () => {
          const rest = { ...draft.edits }; delete rest[c.id]; draft = { ...draft, edits: rest }; drawAll();
        }, 'Undo changes to this color') : null),
    ].filter((n): n is HTMLElement => n !== null));
  }

  // ── the confirm bar ───────────────────────────────────────────────

  function drawBar(): void {
    if (!sets || !hasChanges(draft)) { drawConfirmBar(bar, null); return; }
    const { ops, rows } = pendingChanges(sets, draft);
    const probs = problems(sets, draft);
    const lines: ConfirmRow[] = rows.map(r => ({
      lead: r.kind === 'change' ? el('span', 'ci-pair', swatch(r.from!), icon('i-arrow', 'ic-sm'), swatch(r.to!))
        : r.kind === 'add' ? el('span', 'ci-pair', swatch(r.to!)) : el('span', 'ci-pair', icon('i-plus', 'ic-sm')),
      name: r.name,
      detail: r.kind === 'change' ? r.detail : r.id,
      title: r.kind === 'change' ? `${r.name}  ${r.id}` : `${r.name}  ${r.id}  ${r.detail}`,
    }));
    const hasChange = rows.some(r => r.kind === 'change');
    const n = changeCount(draft);
    drawConfirmBar(bar, {
      title: `Save ${n} change${n === 1 ? '' : 's'}`,
      rows: lines,
      ...(hasChange ? { note: rows.filter(r => r.kind === 'change').length === 1 ? 'Changes it everywhere it is linked.' : 'Changes them everywhere they are linked.' } : {}),
      error: saveError || (probs.size ? [...probs.values()][0] : ''),
      saving,
      canSave: probs.size === 0 && ops.length > 0,
      onSave: () => { void save(); },
      onCancel: () => { draft = emptyDraft(); saveError = ''; if (!views().some(v => v.id === selSet)) selSet = ''; drawAll(); },
    });
  }

  async function save(): Promise<void> {
    if (!sets || saving) return;
    const { ops } = pendingChanges(sets, draft);
    saving = true; saveError = ''; drawBar();
    try {
      const out = await ctx.work(writeChanges(ctx.environment, ops, []));
      if (!out.ok) {
        saveError = out.outcomeUnknown ? `${out.error ?? 'No answer.'} BMP may have saved. Use Refresh to see what it holds.` : (out.error ?? 'The change was not written.');
        return;
      }
      // A fresh read, then the check against what was sent.
      let bad: string[] = [];
      try {
        const r = await ctx.work(readColors(true));
        sets = r.sets; fetchedAt = r.fetchedAt;
        bad = verifyColors(ops, sets);
      } catch (e) {
        bad = [`The colors could not be read again: ${e instanceof Error ? e.message : String(e)}`];
      }
      const n = changeCount(draft);
      draft = emptyDraft();
      result = bad.length ? `Saved, but BMP does not hold it as sent: ${bad[0]}` : `Saved ${n} change${n === 1 ? '' : 's'}`;
      resultBad = bad.length > 0;
      if (!views().some(v => v.id === selSet)) selSet = '';
    } finally {
      saving = false;
      drawAll();
    }
  }

  function drawAll(): void {
    drawSide(); drawMain(); drawPanel(); drawBar();
    root.classList.toggle('loading', loading);
  }

  return {
    root,
    show() {
      root.hidden = false;
      if (!sets && !loading) void load(false); else drawAll();
    },
    hasUnsaved: () => hasChanges(draft),
  };
}
