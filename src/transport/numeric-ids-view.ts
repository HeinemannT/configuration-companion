/**
 * Numeric IDs tab, drawn: the Find bar's search box and Areas button, the
 * list (areas and folders as in Find, each object with its old ID, the new
 * ID as a field that looks like text until hovered or focused, and the
 * count of objects whose code names the old ID), a footer with one button,
 * and one confirmation before anything is written.
 *
 * Typing in a new ID changes that row only (its red field and reason on
 * hover), never the whole list, so focus stays where it is.
 */

import { attrs, btn, el, icon } from '../lib/dom';
import { areasFilter, rowBadge, searchBox } from './find-controls';
import { NumericIdsController, type AreaModel, type NumericChange } from './numeric-ids-controller';
import {
  AREA_LABELS, changeButtonText, codeNote, confirmTitle, footerCount, leftOutNote, notCheckedNote, NUMERIC_AREAS, readText, stampText, type NumericEntry,
} from './numeric-ids-model';
import { basisText } from '../lib/numeric-id-propose';
import { hasShownChildren, holdsWords, MATCH, plural, visibleNodes, wordsOf, type TreeNode } from './transport-model';

export interface NumericViewOptions {
  now?: () => Date;
  /** The name of the workspace for the confirmation. */
  workspace?: () => string;
  openCodeSearch?: () => void;
}

export interface NumericView {
  panel: HTMLElement;
  /** Draw everything (the tab was shown). */
  draw(): void;
  dispose(): void;
}

const BMP_GROUP = 'bmp';
const checkbox = (cls: string, label: string): HTMLInputElement => attrs(el('input', cls) as HTMLInputElement, { type: 'checkbox', 'aria-label': label });
const plainBtn = (cls: string, ...kids: Array<Node | string | null>): HTMLButtonElement => {
  const b = el('button', cls, ...kids.filter((k): k is Node | string => k != null)) as HTMLButtonElement;
  b.type = 'button';
  return b;
};

export const BMP_GROUP_TITLE = "Probably BMP's own";
export const BMP_GROUP_HELP_SYSTEM = "Marked as system objects. BMP uses these numbers itself, so they are left unticked.";
export const BMP_GROUP_HELP = "Created by System or marked as system objects. BMP uses these numbers itself, so they are left unticked.";
export const READING_LABELS: Readonly<Record<string, string>> = { 'who created them': 'Reading who created them' };

export function mountNumericIds(ctl: NumericIdsController, opts: NumericViewOptions = {}): NumericView {
  const now = opts.now ?? (() => new Date());

  // ── bar ─────────────────────────────────────────────────────────
  const { field } = searchBox({ placeholder: 'Name or ID', label: 'Name or ID', onInput: text => ctl.setText(text) });
  const areas = areasFilter({
    areas: NUMERIC_AREAS,
    onChoose: (root, on) => ctl.setArea(root, on), onReset: () => ctl.resetAreas(),
    onToggle: open => areas.setOpen(open),
  });
  const readAt = el('span', 'ni-read');
  const refreshBtn = btn('ni-refresh ui-tbtn', 'Read the objects again', () => ctl.refresh(), icon('i-retry', 'ic-sm'), 'Refresh');
  const stopBtn = btn('tr-stop ui-btn', undefined, () => ctl.stop(), 'Stop');
  stopBtn.hidden = true;
  const bar = el('div', 'tr-findbar ni-bar', field, el('span', 'tr-filters', areas.wrap), stopBtn, el('span', 'tr-sp'), readAt, refreshBtn);
  const onDocDown = (e: MouseEvent) => { if (!areas.pop.hidden && !areas.wrap.contains(e.target as Node)) areas.setOpen(false); };
  document.addEventListener('mousedown', onDocDown);

  const status = attrs(el('div', 'tr-status ni-status'), { role: 'status', 'aria-live': 'polite' });
  const note = el('div', 'tr-status ni-note');

  // ── list ────────────────────────────────────────────────────────
  const allBox = checkbox('ni-ck ni-all', 'All shown');
  const cols = el('div', 'ni-cols', allBox, el('span', 'ni-c-obj', 'Object'), el('span', 'ni-c-id', 'ID'), el('span', 'ni-c-new', 'New ID'));
  const list = attrs(el('div', 'ni-list'), { role: 'list', 'aria-label': 'Objects with a numeric ID' });

  // ── footer ──────────────────────────────────────────────────────
  const count = el('span', 'tr-selcount');
  const backBtn = btn('tr-link ni-back', undefined, () => { void ctl.undo(); }, 'Change back');
  const goBtn = btn('tr-open ui-btn primary', undefined, () => { void ctl.requestChange(); }, 'Change IDs');
  const foot = el('div', 'tr-foot', count, backBtn, el('span', 'tr-sp'), goBtn);

  // ── confirmation ────────────────────────────────────────────────
  const scrim = attrs(el('div', 'ni-scrim'), { role: 'presentation' });
  scrim.hidden = true;

  const panel = attrs(el('section', 'tr-panel ni', bar, status, note, cols, list, foot, scrim), { id: 'tr-numeric', role: 'tabpanel', 'aria-labelledby': 'tr-tab-numeric' });

  // ── rows ────────────────────────────────────────────────────────
  const words = () => wordsOf(ctl.text);

  /** Text with the words of the box marked. */
  function marked(text: string): Array<Node | string> {
    const ws = words();
    if (!ws.length) return [text];
    const lower = text.toLowerCase();
    const on = new Array<boolean>(text.length).fill(false);
    for (const w of ws) for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) for (let k = i; k < i + w.length; k++) on[k] = true;
    const out: Array<Node | string> = [];
    for (let i = 0; i < text.length;) {
      let j = i;
      while (j < text.length && on[j] === on[i]) j++;
      out.push(on[i] ? el('mark', '', text.slice(i, j)) : text.slice(i, j));
      i = j;
    }
    return out;
  }

  function entryRow(e: NumericEntry, depth: number): HTMLElement {
    const rid = e.row.rid;
    const state = ctl.stateOf(rid);
    const ck = checkbox('ni-ck', `Change ${e.row.name || e.row.id}`);
    ck.dataset.rid = rid;
    ck.checked = ctl.ticked.has(rid);
    const name = e.row.name || e.row.id;
    const why = ctl.notes.get(rid);
    const nameCell = el('span', 'ni-nm', ...marked(name));
    nameCell.title = e.bmp ? `${name}. ${ctl.whyBmp(e)}` : name;
    const nm = el('span', 'ni-nmc', nameCell, ...(why ? [attrs(el('span', 'ni-why', why), { title: why })] : []));
    const input = attrs(el('input', 'ni-nid') as HTMLInputElement, { value: state?.value ?? '', spellcheck: 'false', 'aria-label': `New ID of ${name}`, autocomplete: 'off' });
    input.dataset.rid = rid;
    const proposal = ctl.proposalOf(rid);
    input.title = proposal && !ctl.edits.has(rid) ? basisText(proposal) : '';
    const codeCount = ctl.codeCount(e);
    const code = codeCount ? attrs(el('span', 'ni-code', icon('k-code', 'ic-sm'), String(codeCount)), { title: `Code in ${plural(codeCount, 'object')} names this ID` }) : el('span');
    const row = el('div', `ni-row${ck.checked ? '' : ' off'}`, ck, rowBadge(e.row.className), nm, attrs(el('span', 'ni-old', ...marked(e.row.id)), { title: 'The ID BMP assigned' }), icon('i-arrow', 'ni-to'), input, code);
    row.style.setProperty('--d', String(depth));
    attrs(row, { role: 'listitem', 'data-rid': rid });
    return row;
  }

  /** A folder (an object without a number, or an area) over rows. */
  function folderRow(m: AreaModel, n: TreeNode | null, bmp: boolean, depth: number, open: boolean, label: string, shown: number, key: string): HTMLElement {
    const ck = checkbox('ni-ck', `Change everything under ${label}`);
    ck.dataset.fold = key;
    const toggle = attrs(plainBtn('ni-caret', icon('i-chev', `ui-disc-chev${open ? '' : ' closed'}`), attrs(el('span', 'ni-ft', label), { title: label }), el('span', 'ni-fn', String(shown))), { 'aria-expanded': String(open), 'data-key': key });
    const row = el('div', `ni-row ni-fold${n ? '' : ' ni-area'}`, ck, toggle);
    row.style.setProperty('--d', String(depth));
    attrs(row, { role: 'listitem', 'data-fold': key, 'data-area': m.root, 'data-bmp': String(bmp), ...(n ? { 'data-node': n.key } : {}) });
    return row;
  }

  function areaRows(m: AreaModel, bmp: boolean, depth0: number, into: DocumentFragment): number {
    const show = ctl.show(m, bmp);
    const entries = ctl.entriesIn(m, bmp);
    if (!entries.length) return 0;
    const prefix = `${bmp ? 'b' : 'a'}:${m.root}`;
    const open = !ctl.isClosed(prefix);
    into.append(folderRow(m, null, bmp, depth0, open, AREA_LABELS[m.root], entries.length, prefix));
    if (!open) return entries.length;
    for (const n of visibleNodes(m.tree, show, x => ctl.isClosed(`${prefix}|${x.key}`))) {
      const e = n.row ? m.byRid.get(n.row.rid) : undefined;
      if (e && show.state[n.index] === MATCH) { into.append(entryRow(e, depth0 + 1 + n.depth)); continue; }
      const under = ctl.entriesIn(m, bmp, n);
      if (!under.length) continue;
      const label = n.row ? n.row.name || n.row.id : n.name || n.id;
      into.append(folderRow(m, n, bmp, depth0 + 1 + n.depth, hasShownChildren(n, show) && !ctl.isClosed(`${prefix}|${n.key}`), label, under.length, `${prefix}|${n.key}`));
    }
    return entries.length;
  }

  function drawList(): void {
    const top = list.scrollTop;
    const frag = document.createDocumentFragment();
    let own = 0;
    for (const m of ctl.areaModels) own += areaRows(m, false, 0, frag);
    const bmpAll = ctl.bmpEntries.filter(e => holdsWords(e.row, words()));
    if (bmpAll.length) {
      const open = ctl.bmpOpen;
      const toggle = attrs(plainBtn('ni-caret', icon('i-chev', `ui-disc-chev${open ? '' : ' closed'}`), attrs(el('span', 'ni-ft', BMP_GROUP_TITLE), { title: ctl.byCreator ? BMP_GROUP_HELP : BMP_GROUP_HELP_SYSTEM }), el('span', 'ni-fn', String(bmpAll.length))), { 'aria-expanded': String(open), 'data-key': BMP_GROUP });
      const head = el('div', 'ni-row ni-fold ni-bmp', el('span'), toggle);
      head.style.setProperty('--d', '0');
      attrs(head, { role: 'listitem', 'data-group': BMP_GROUP });
      frag.append(head);
      if (open) for (const m of ctl.areaModels) areaRows(m, true, 1, frag);
    }
    if (!frag.childNodes.length) {
      frag.append(el('p', 'tr-empty ni-empty', emptyText(own)));
    }
    list.replaceChildren(frag);
    list.scrollTop = top;
    syncRows();
  }

  function emptyText(own: number): string {
    if (ctl.reading) return '';
    if (!ctl.opened || (!ctl.areaModels.length && ctl.error)) return '';
    if (!ctl.chosen.size) return 'No area chosen.';
    if (!ctl.areaModels.length) return '';
    if (!own && ctl.text.trim()) return 'None match.';
    return ctl.result ? 'No numeric IDs left in these areas.' : 'No numeric IDs in these areas.';
  }

  /** Tick boxes, field states and the footer, in place. */
  function syncRows(): void {
    for (const row of list.querySelectorAll<HTMLElement>('.ni-row[data-rid]')) {
      const rid = row.dataset.rid!;
      const on = ctl.ticked.has(rid);
      const ck = row.querySelector<HTMLInputElement>('.ni-ck');
      if (ck) ck.checked = on;
      row.classList.toggle('off', !on);
      const input = row.querySelector<HTMLInputElement>('.ni-nid');
      const state = ctl.stateOf(rid);
      if (input && state) {
        if (document.activeElement !== input && input.value !== state.value) input.value = state.value;
        const bad = !!state.problem && on;
        input.classList.toggle('bad', bad);
        input.setAttribute('aria-invalid', String(bad));
        const basis = ctl.proposalOf(rid);
        input.title = bad ? state.problem! : (basis && !ctl.edits.has(rid) ? basisText(basis) : '');
      }
    }
    for (const row of list.querySelectorAll<HTMLElement>('.ni-row[data-fold]')) {
      const m = ctl.areaModels.find(x => x.root === row.dataset.area);
      const ck = row.querySelector<HTMLInputElement>('.ni-ck');
      if (!m || !ck) continue;
      const node = row.dataset.node ? m.tree.byKey.get(row.dataset.node) : undefined;
      const s = ctl.tickState(ctl.entriesIn(m, row.dataset.bmp === 'true', node));
      ck.checked = s === 'all';
      ck.indeterminate = s === 'some';
    }
    const shown = ctl.shown;
    const s = ctl.tickState(shown);
    allBox.checked = s === 'all';
    allBox.indeterminate = s === 'some';
    allBox.disabled = !shown.length || ctl.busy;
    drawFoot();
  }

  // ── bar, status, footer ─────────────────────────────────────────

  function drawBar(): void {
    areas.draw(ctl.chosen, ctl.defaultAreas);
    readAt.textContent = readText(ctl.readAt, now());
    refreshBtn.disabled = ctl.busy;
    stopBtn.hidden = !ctl.reading;
  }

  function drawStatus(): void {
    status.replaceChildren();
    status.className = 'tr-status ni-status';
    status.setAttribute('role', 'status');
    if (ctl.reading) {
      const r = ctl.reading;
      const label = READING_LABELS[r.label] ?? (r.label in AREA_LABELS ? `Reading ${AREA_LABELS[r.label as keyof typeof AREA_LABELS]}` : 'Reading');
      status.append(el('span', '', `${label}${r.total > 1 ? ` (${Math.min(r.done + 1, r.total)} of ${r.total})` : ''}`));
    } else if (ctl.error) {
      status.classList.add('err');
      status.setAttribute('role', 'alert');
      status.append(icon('i-warn'), el('span', '', ctl.error));
    } else if (ctl.result) {
      status.append(el('span', '', ctl.result));
    } else if (ctl.cut.length) {
      status.append(el('span', '', `More objects than can be read in ${ctl.cut.map(r => AREA_LABELS[r]).join(', ')}. Choose fewer areas.`));
    }
    // The code copy: said once, quietly.
    note.replaceChildren();
    const c = ctl.code;
    if (ctl.opened && !ctl.reading && c && !c.ready) {
      note.append(el('span', '', notCheckedNote(c.reason)));
      if (c.canMake) note.append(btn('tr-link', undefined, () => opts.openCodeSearch?.(), 'Make a copy'));
    }
  }

  function drawFoot(): void {
    const ready = ctl.ready.length;
    count.textContent = ctl.opened && ctl.areaModels.length ? footerCount(ready, ctl.listed) : '';
    goBtn.textContent = changeButtonText(ready);
    goBtn.disabled = ready === 0 || ctl.busy || !!ctl.confirm;
    const r = ctl.record;
    backBtn.hidden = !r;
    backBtn.disabled = ctl.busy;
    if (r) backBtn.title = `Put back the ${plural(r.ids.length, 'ID')}${r.code.length ? ` and ${plural(r.code.length, 'script')}` : ''} of the last change (${stampText(Date.parse(r.at), now())})`;
  }

  // ── confirmation ────────────────────────────────────────────────

  function drawConfirm(): void {
    const c = ctl.confirm;
    scrim.hidden = !c || c.phase === 'asking' && !c.items.length;
    if (!c || (c.phase === 'asking' && !c.items.length)) { scrim.replaceChildren(); return; }
    const running = c.phase === 'ids' || c.phase === 'code';
    const rows = c.items.map(i => el('div', 'ni-drow', rowBadge(i.className), el('span', 'ni-old', i.from), icon('i-arrow', 'ni-to'), attrs(el('span', 'ni-new', i.to), { title: i.to })));
    const dlist = c.items.length ? el('div', 'ni-dlist', ...rows) : null;
    const dnote = c.codeObjects || c.leftOut ? el('p', 'ni-dnote', [c.codeObjects ? codeNote(c.codeObjects) : '', c.leftOut ? leftOutNote(c.leftOut) : ''].filter(Boolean).join(' ')) : null;
    const progress = running ? el('p', 'ni-dnote', c.phase === 'ids' ? `Changing IDs${c.total ? ` (${Math.min(c.done + 1, c.total)} of ${c.total})` : ''}` : `Changing code${c.total ? ` (${Math.min(c.done + 1, c.total)} of ${c.total})` : ''}`) : null;
    const cancel = btn('ui-btn', undefined, () => ctl.cancelConfirm(), 'Cancel');
    cancel.disabled = running;
    const go = btn('ui-btn primary', undefined, () => { void ctl.confirmChange(); }, 'Change IDs');
    go.disabled = running;
    const title = c.items.length ? confirmTitle(c.items.length, opts.workspace?.() ?? '') : 'Changing back';
    const dlg = attrs(el('div', 'ni-dlg', el('h2', '', title), ...(dlist ? [dlist] : []), ...(dnote ? [dnote] : []), ...(progress ? [progress] : []), ...(c.items.length ? [el('div', 'ni-dfoot', cancel, go)] : [])), { role: 'dialog', 'aria-label': title, 'aria-modal': 'true' });
    scrim.replaceChildren(dlg);
    if (c.phase === 'ready') go.focus();
  }

  // ── events ──────────────────────────────────────────────────────

  list.addEventListener('change', e => {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('ni-ck')) return;
    if (t.dataset.rid) { ctl.setTicked([t.dataset.rid], t.checked); return; }
    const row = t.closest<HTMLElement>('.ni-row[data-fold]');
    const m = ctl.areaModels.find(x => x.root === row?.dataset.area);
    if (!row || !m) return;
    const node = row.dataset.node ? m.tree.byKey.get(row.dataset.node) : undefined;
    ctl.setTicked(ctl.entriesIn(m, row.dataset.bmp === 'true', node).map(x => x.row.rid), t.checked);
  });
  allBox.addEventListener('change', () => ctl.setTicked(ctl.shown.map(x => x.row.rid), allBox.checked));
  list.addEventListener('click', e => {
    const caret = (e.target as HTMLElement).closest<HTMLElement>('.ni-caret');
    if (!caret?.dataset.key) return;
    if (caret.dataset.key === BMP_GROUP) ctl.toggleBmp(); else ctl.toggleNode(caret.dataset.key);
  });
  list.addEventListener('input', e => {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('ni-nid') && t.dataset.rid) ctl.setValue(t.dataset.rid, t.value);
  });
  // Leaving an empty or unchanged field shows the proposal again.
  list.addEventListener('focusout', e => {
    const t = e.target as HTMLInputElement;
    if (!t.classList.contains('ni-nid') || !t.dataset.rid) return;
    const s = ctl.stateOf(t.dataset.rid);
    if (s && !t.value.trim()) { ctl.resetValue(t.dataset.rid); t.value = ctl.stateOf(t.dataset.rid)?.value ?? ''; }
  });

  function drawAll(): void {
    drawBar();
    drawStatus();
    drawList();
    drawConfirm();
  }

  const off = ctl.onChange((c: NumericChange) => {
    switch (c.kind) {
      case 'data': drawBar(); drawStatus(); drawList(); break;
      case 'filters': drawList(); break;
      case 'ticks': syncRows(); break;
      case 'status': drawBar(); drawStatus(); drawFoot(); break;
      case 'confirm': drawConfirm(); drawFoot(); drawBar(); break;
      case 'result': drawStatus(); drawFoot(); break;
    }
  });

  return {
    panel,
    draw: drawAll,
    dispose: () => { off(); document.removeEventListener('mousedown', onDocDown); },
  };
}

