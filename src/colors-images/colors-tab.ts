/**
 * The Colors tab: the workspace's color sets on the left, the chosen set's
 * colors as swatches, an editor on the right (name, picker, the value as
 * hex, RGB or HSL, pick from the screen, the contrast of white and black
 * text on it with the nearest value where white passes). Add a color, add
 * several (pasted from a list, CSS or a brand guide, reviewed first) or a
 * scale of lighter and darker steps from a color; a new color close to one
 * already in the sets is marked. Changes stay on the page until one confirm
 * bar lists them; the write is previewed on the server, and a fresh read
 * checks it. There is no delete here: nobody has verified what BMP does to
 * objects still linked to a deleted color.
 */
import { attrs, btn, el, icon } from '../lib/dom';
import {
  closeMatch, formatColor, parseColor, scaleFrom, textOn, whitePassNudge, type ColorFormat,
} from '../lib/colors-images/color-math';
import {
  addColor, addColors, addSet, changeCount, editColor, editNewColor, emptyDraft, hasChanges, knownColors, pendingChanges, problems,
  removeNewColor, removeNewSet, renameNewColor, scaleColors, setViews, verifyColors, type ColorDraft, type ColorView, type SetView,
} from '../lib/colors-images/colors-draft';
import { parsePastedColors, type FoundColor } from '../lib/colors-images/color-paste';
import type { ColorSetData } from '../lib/types';
import { readColors, writeChanges } from './api';
import { pickFromScreenButton } from './color-pop';
import { drawConfirmBar, readFoot, statusBlock, type ConfirmRow, type PageCtx } from './common';
import { createPicker, type Picker } from './picker';

const swatch = (hex: string, cls = 'ci-chip') => attrs(el('i', cls), { style: `background:${hex}` });

export interface Tab {
  root: HTMLElement;
  /** Read the data the first time the tab is shown. */
  show(): void;
  hasUnsaved(): boolean;
}

type Mode = 'edit' | 'paste' | 'scale';

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
  let mode: Mode = 'edit';
  let format: ColorFormat = 'hex';
  let pasteText = '';
  /** Names edited and rows removed in the paste review, by hex. */
  let pasteNames: Record<string, string> = {};
  let pasteRemoved = new Set<string>();
  let menuOpen = false;

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
  const nextKey = () => `new${++counter}`;

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
      sets ? btn('ci-ib', 'Add color set', () => { addingSet = !addingSet; drawSide(); if (addingSet) side.querySelector<HTMLInputElement>('.ci-addset input')?.focus(); }, icon('i-plus', 'ic-sm')) : null);
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
        selSet = created.id; selColor = ''; addingSet = false; result = ''; mode = 'edit';
        drawAll();
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(); } else if (e.key === 'Escape') { addingSet = false; drawSide(); } });
      list.append(el('div', 'ci-addset', input, btn('ui-btn', undefined, done, 'Add')));
    }
    for (const v of views()) {
      const chips = el('span', 'ci-chips', ...v.colors.slice(0, 4).map(c => swatch(c.hex)));
      const row = btn(`ci-srow${v.id === (currentSet()?.id) ? ' on' : ''}`, undefined, () => { selSet = v.id; selColor = ''; addingSet = false; mode = 'edit'; menuOpen = false; drawAll(); },
        chips, el('span', 'ci-srow-name', v.name), v.isNew ? el('span', 'ci-tag', 'New') : null, el('span', 'ci-n', String(v.colors.length)));
      attrs(row, { title: `${v.name}  ${v.id}` });
      list.append(row);
    }
    if (!sets && loading) list.append(...[78, 62, 70, 56, 66].map(w => el('div', 'ci-skel-row chips', el('i'), attrs(el('span'), { style: `width:${w}%` }))));
    side.replaceChildren(head, list, readFoot(fetchedAt, () => { void load(true); }, hasChanges(draft) ? 'Save or cancel the changes first' : undefined, loading));
    list.querySelector('.ci-srow.on')?.scrollIntoView({ block: 'nearest' });
  }

  // ── the colors of the chosen set ──────────────────────────────────

  function addMenu(): HTMLElement {
    const base = currentColor();
    const trigger = btn(`ui-btn ci-addmenu${menuOpen ? ' on' : ''}`, undefined, () => { menuOpen = !menuOpen; drawMain(); }, icon('i-plus', 'ic-sm'), 'Add colors', icon('i-chev', 'ic-sm'));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', String(menuOpen));
    const wrap = el('div', 'ci-menuwrap', trigger);
    if (menuOpen) {
      const scale = btn('', undefined, () => openMode('scale'), el('span', '', 'Scale from'), base ? swatch(base.hex) : null, el('span', 'ci-menu-sub', base?.name ?? 'a color'));
      if (!base) scale.disabled = true;
      const menu = attrs(el('div', 'ui-menu ci-menu'), { role: 'menu' });
      menu.append(btn('', undefined, () => openMode('paste'), el('span', '', 'Paste colors')), scale);
      for (const b of menu.querySelectorAll('button')) b.setAttribute('role', 'menuitem');
      wrap.append(menu);
      // A click elsewhere or Escape closes the menu.
      const close = (e: Event) => {
        if (e instanceof KeyboardEvent ? e.key !== 'Escape' : wrap.contains(e.target as Node)) return;
        document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', close);
        if (menuOpen) { menuOpen = false; drawMain(); if (e instanceof KeyboardEvent) main.querySelector<HTMLElement>('.ci-addmenu')?.focus(); }
      };
      setTimeout(() => { document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', close); }, 0);
    }
    return wrap;
  }

  function openMode(next: Mode): void {
    menuOpen = false;
    mode = next;
    if (next === 'paste') { pasteText = ''; pasteNames = {}; pasteRemoved = new Set(); }
    drawMain(); drawPanel();
    if (next === 'paste') panel.querySelector<HTMLTextAreaElement>('.ci-paste')?.focus();
  }

  function drawMain(): void {
    if (!sets) {
      if (loading) {
        main.replaceChildren(el('div', 'ci-mhead', el('div', 'ci-skel-bar short')),
          el('div', 'ci-scroll', el('div', 'ci-cgrid', ...Array.from({ length: 8 }, () => el('div', 'ci-ctile skel', el('div', 'ci-sw'), el('div', 'ci-skel-row'), attrs(el('div', 'ci-skel-row'), { style: 'width:50%' }))))));
      } else main.replaceChildren(statusBlock(loadError || 'The colors were not read.', () => { void load(true); }));
      return;
    }
    const set = currentSet();
    if (!set) { main.replaceChildren(el('div', 'ci-empty', el('div', 'ci-empty-t', 'No color sets yet'), el('div', 'ci-empty-s', 'Color sets are added in Configuration Studio'))); return; }
    const head = el('div', 'ci-mhead', el('span', 'ci-title', set.name), el('span', 'ci-id', set.id), el('span', 'ci-grow'),
      loadError ? el('span', 'ci-warn', loadError) : null,
      result ? el('span', `ci-result${resultBad ? ' bad' : ''}`, result) : null,
      addMenu());
    if (mode === 'edit') {
      const sel = selColor && set.colors.some(c => c.key === selColor) ? selColor : (set.colors[0]?.key ?? '');
      selColor = sel;
    }
    const tiles = set.colors.map(c => {
      const changed = !!c.was && (c.was.hex !== c.hex || c.was.name !== c.name);
      const hx = el('div', 'ci-hx', c.was && c.was.hex !== c.hex ? el('s', '', c.was.hex) : null, el('b', changed || c.isNew ? 'on' : '', c.hex));
      const on = mode === 'edit' && c.key === selColor;
      const t = btn(`ci-ctile${on ? ' on' : ''}${c.isNew ? ' new' : ''}`, undefined, () => { selColor = c.key; mode = 'edit'; drawMain(); drawPanel(); },
        attrs(el('div', 'ci-sw'), { style: `background:${c.hex}` }), el('div', 'ci-nm', c.name), hx);
      if (c.isNew) t.querySelector('.ci-sw')!.append(el('span', 'ci-newtag', 'New'));
      attrs(t, { title: `${c.name}  ${c.id}` });
      return t;
    });
    const add = btn('ci-ctile add', 'Add color', () => {
      if (!sets) return;
      const key = nextKey();
      const base = currentColor()?.hex ?? '#808080';
      const next = addColor(draft, sets, set.id, key, base);
      draft = next.draft; selColor = key; result = ''; mode = 'edit';
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

  function panelHead(title: string, sub: string, onClose?: () => void): HTMLElement {
    return el('div', 'ci-ph two', el('span', 'ci-title', title), el('span', 'ci-id', sub),
      onClose ? btn('ci-ib ci-ph-x', 'Close', onClose, icon('i-x', 'ic-sm')) : null);
  }

  function drawPanel(): void {
    picker = null;
    if (mode === 'paste' && sets && currentSet()) { drawPaste(); return; }
    if (mode === 'scale' && sets && currentColor()) { drawScale(); return; }
    mode = 'edit';
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
    const value = attrs(el('input', 'ci-inp mono') as HTMLInputElement, { 'aria-label': 'Color value', spellcheck: 'false' });
    value.value = formatColor(c.hex, format);
    const invalid = (on: boolean) => { if (on) value.setAttribute('aria-invalid', 'true'); else value.removeAttribute('aria-invalid'); };
    const fmtSel = attrs(el('select', 'ci-fmtsel') as HTMLSelectElement, { 'aria-label': 'Format' });
    for (const [v, label] of [['hex', 'Hex'], ['rgb', 'RGB'], ['hsl', 'HSL']] as const) {
      const o = el('option', '', label) as HTMLOptionElement; o.value = v; o.selected = v === format; fmtSel.append(o);
    }
    fmtSel.addEventListener('change', () => { format = fmtSel.value as ColorFormat; value.value = formatColor(currentColor()?.hex ?? c.hex, format); invalid(false); });

    const ontext = el('div', 'ci-ontext');
    const nudge = el('div', 'ci-nudge');
    const close = el('div', 'ci-close');
    const paintAround = (hex: string) => {
      const t = textOn(hex);
      ontext.replaceChildren(...[['#FFFFFF', 'White', t.white], ['#000000', 'Black', t.black]].map(([ink, label, ratio]) =>
        attrs(el('div', Number(ratio) >= 4.5 ? 'pass' : '', el('b', '', 'Aa'), el('span', '', Number(ratio).toFixed(1))), { style: `background:${hex};color:${ink}`, title: `${label} text, contrast ${ratio}` })));
      const n = whitePassNudge(hex);
      nudge.replaceChildren(...(n ? [swatch(n, 'ci-chip md'), el('span', '', 'White passes at '), el('span', 'mono', n), btn('ci-link', undefined, () => setValue(n), 'Use')] : []));
      nudge.hidden = !n;
      const near = c.isNew ? closeMatch(hex, knownColors(sets!, draft, c.key)) : null;
      close.replaceChildren(...(near ? [icon('i-warn', 'ic-sm'), el('span', '', `Close to ${near.name}`), swatch(near.hex)] : []));
      close.hidden = !near;
      if (near) close.title = `${near.name}  ${near.hex}`;
    };
    const setValue = (hex: string, from: 'picker' | 'input' | 'other' = 'other') => {
      hexChip.style.background = hex;
      if (from !== 'input') { value.value = formatColor(hex, format); invalid(false); }
      if (from !== 'picker') picker?.set(hex);
      paintAround(hex);
      apply('hex', hex);
    };
    paintAround(c.hex);

    picker = createPicker(c.hex, v => setValue(v, 'picker'));
    value.addEventListener('input', () => {
      const v = parseColor(value.value, format);
      invalid(!v);
      if (v) setValue(v, 'input');
    });
    value.addEventListener('blur', () => {
      const now = currentColor();
      if (now) { value.value = formatColor(now.hex, format); invalid(false); }
    });
    const drop = pickFromScreenButton(hex => setValue(hex));

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

    const head = el('div', 'ci-ph two');
    function paintHead(): void {
      const now = currentColor();
      head.replaceChildren(el('span', 'ci-title', now?.name || ' '), el('span', 'ci-id', now?.id ?? ''));
    }
    paintHead();
    panel.replaceChildren(...[
      head,
      el('div', 'ci-field', el('label', 'ci-lab', 'Name'), name),
      idField,
      el('div', 'ci-field', el('label', 'ci-lab', 'Color'), picker.el, el('div', 'ci-hexrow', hexChip, fmtSel, value, drop), close),
      el('div', 'ci-field', el('label', 'ci-lab', 'Text on it'), ontext, nudge),
      problem ? el('div', 'ci-problem', icon('i-warn', 'ic-sm'), el('span', '', problem)) : null,
      el('div', 'ci-end', c.isNew
        ? btn('ci-link', undefined, () => { draft = removeNewColor(draft, c.key); selColor = ''; drawAll(); }, 'Remove from this change')
        : changed ? btn('ci-link', undefined, () => {
          const rest = { ...draft.edits }; delete rest[c.id]; draft = { ...draft, edits: rest }; drawAll();
        }, 'Undo changes to this color') : null),
    ].filter((n): n is HTMLElement => n !== null));
  }

  // ── paste several ─────────────────────────────────────────────────

  function pasteRows(): FoundColor[] {
    return parsePastedColors(pasteText).filter(f => !pasteRemoved.has(f.hex)).map(f => ({ hex: f.hex, name: pasteNames[f.hex] ?? f.name }));
  }

  function drawPaste(): void {
    const set = currentSet()!;
    const area = attrs(el('textarea', 'ci-inp ci-paste') as HTMLTextAreaElement, { placeholder: 'Paste a list, CSS or a brand guide', 'aria-label': 'Pasted text', spellcheck: 'false' });
    area.value = pasteText;
    const list = el('div', 'ci-found');
    const addBtn = btn('ui-btn primary', undefined, () => {
      const rows = pasteRows();
      if (!rows.length || !sets) return;
      const r = addColors(draft, sets, set.id, rows.map((f, i) => ({ hex: f.hex, name: f.name || `Color ${i + 1}` })), nextKey);
      draft = r.draft; selColor = r.added[0]?.key ?? ''; mode = 'edit'; result = '';
      drawAll();
    }, '');
    const paintList = () => {
      const rows = pasteRows();
      const known = knownColors(sets!, draft);
      list.replaceChildren(...rows.flatMap((f, i) => {
        const nameIn = attrs(el('input', 'ci-inp sm') as HTMLInputElement, { 'aria-label': `Name of ${f.hex}`, placeholder: `Color ${i + 1}` });
        nameIn.value = f.name;
        nameIn.addEventListener('input', () => { pasteNames[f.hex] = nameIn.value; });
        const near = closeMatch(f.hex, known);
        const row = el('div', 'ci-frow', swatch(f.hex, 'ci-chip md'), nameIn, el('span', 'ci-fhex', f.hex),
          near ? attrs(el('span', 'ci-fwarn', icon('i-warn', 'ic-sm')), { title: `Close to ${near.name} ${near.hex}`, 'aria-label': `Close to ${near.name}` }) : el('span', ''),
          btn('ci-ib', `Leave out ${f.hex}`, () => { pasteRemoved.add(f.hex); paintList(); }, icon('i-x', 'ic-sm')));
        return near ? [row, el('div', 'ci-fnear', `Close to ${near.name} ${near.hex}`)] : [row];
      }));
      list.hidden = !rows.length;
      addBtn.textContent = rows.length ? `Add ${rows.length} color${rows.length === 1 ? '' : 's'}` : 'Add colors';
      addBtn.disabled = !rows.length;
      empty.hidden = rows.length > 0 || !pasteText.trim();
    };
    const empty = el('p', 'ci-hint', 'No hex or rgb() values found');
    area.addEventListener('input', () => { pasteText = area.value; paintList(); });
    panel.replaceChildren(
      panelHead('Paste colors', `Into ${set.name}`, () => { mode = 'edit'; drawMain(); drawPanel(); }),
      area, empty, list, el('div', 'ci-end near', addBtn));
    paintList();
  }

  // ── a scale from a color ──────────────────────────────────────────

  function drawScale(): void {
    const set = currentSet()!;
    const base = currentColor()!;
    const steps = scaleFrom(base.hex);
    const items = scaleColors(base.name, steps, base.id);
    // The IDs the steps would get, shown before anything is added.
    let n = 0;
    const preview = addColors(draft, sets!, set.id, items, () => `preview${++n}`).added;
    const strip = el('div', 'ci-strip', ...steps.map(s => attrs(el('i', s.step === 500 ? 'base' : ''), { style: `background:${s.hex}`, title: `${s.step}  ${s.hex}` })));
    const rows = steps.map(s => {
      const i = items.findIndex(it => it.step === s.step);
      const isBase = s.step === 500;
      return el('div', `ci-srowx${isBase ? ' base' : ''}`, swatch(s.hex, 'ci-chip md'),
        el('span', 'ci-sname', isBase ? base.name : items[i].name),
        el('span', 'ci-fhex', isBase ? 'In the set' : preview[i]?.id ?? ''),
        el('span', 'ci-fhex r', s.hex));
    });
    const addBtn = btn('ui-btn primary', undefined, () => {
      const r = addColors(draft, sets!, set.id, items, nextKey);
      draft = r.draft; selColor = r.added[0]?.key ?? selColor; mode = 'edit'; result = '';
      drawAll();
    }, `Add ${items.length} colors`);
    panel.replaceChildren(
      panelHead('Scale', `From ${base.name}`, () => { mode = 'edit'; drawMain(); drawPanel(); }),
      strip, el('div', 'ci-scale', ...rows), el('div', 'ci-end near', addBtn));
  }

  // ── the confirm bar ───────────────────────────────────────────────

  function drawBar(): void {
    if (!sets || !hasChanges(draft)) { drawConfirmBar(bar, null); return; }
    const { ops, rows } = pendingChanges(sets, draft);
    const probs = problems(sets, draft);
    const lines: ConfirmRow[] = rows.map(r => ({
      lead: r.kind === 'change' ? el('span', 'ci-pair', swatch(r.from!), icon('i-arrow', 'ic-sm'), swatch(r.to!))
        : r.kind === 'add' ? el('span', 'ci-pair', el('span', 'ci-plus', icon('i-plus', 'ic-sm')), swatch(r.to!)) : el('span', 'ci-pair', el('span', 'ci-plus', icon('i-plus', 'ic-sm'))),
      name: r.name,
      detail: r.kind === 'change' ? r.detail : r.kind === 'add' ? `${r.id}  ·  ${r.to}` : `${r.id}  ·  new set`,
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

