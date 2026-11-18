/**
 * Transport window view: draws a TransportController and turns clicks into
 * its actions.
 *
 *  - Find: one box with the Changed, Areas and This page buttons (Stop only
 *    while something is read), then the tree of areas or one result list (a
 *    tree per group: caret, tick box, ID, an end button; rows built only for
 *    open groups and nodes; one delegated listener per event type), and a
 *    footer with the lines of the transport.
 *  - Transport: the target picker and its action, the summary and what is
 *    needed, the comparison script or the scripts, the options, then the
 *    transport as a list by place (a row opens in place) or as a map.
 *  - The transport log, over either tab.
 *
 * A tick draws the list again with its scroll and focus kept; nothing on the
 * page moves when ticking.
 */

import { attrs, btn, el, icon } from '../lib/dom';
import { copyWithFeedback } from '../lib/copy-feedback';
import type { UndoRecord } from '../lib/transport-undo';
import { FILE_LIMIT_KB_MAX, FILE_LIMIT_KB_MIN, isTransportRoot, sizeKb, uploadText, TRANSPORT_SCAN_CAP, TRANSPORT_SCAN_TOTAL, type BundlePart, type BundleWarning, type TransportRoot } from '../lib/transport-bundle';
import { PATCH_VALUE_ACTION_LABELS, type PatchPart, type PatchReviewObject, type PatchValue, type ProbePart, type RenameHint, type TargetOnlyObject, type TransportPatch } from '../lib/transport-patch';
import { TRANSPORT_SEARCH_CAP, TRANSPORT_USED_BY_CAP, type TransportLogEntry, type TransportScanRow } from '../lib/transport-read';
import {
  applyCounts, applySize, choiceOf, CHOICE_ANY, CHOICE_PASTE, IDLIST, NEED_KINDS, ONPAGE, TRANSPORT_APPLY_WARN_CHARS, UNDER,
  areaKey, type AreaResult, type BrowseNode, type Change, type DirectState, type NeedKind, type GroupKey, type TargetState, type TransportController,
} from './transport-controller';
import {
  AREA_LABELS, AREA_ORDER, areasValue, changedValue, dayText, downloadName, filtersActive, hasShownChildren, isDefaultArea, isNumericId, MATCH, orderedAreas, plural,
  shortTime, subLabel, usersOf, visibleNodes, wordsOf, type SinceKey, type SubSpec, type TreeNode, type TreeShow,
} from './transport-model';
import {
  draftAgeLine, draftLine, linesText, PATH_SEP, STATE_LABELS, summaryLine, USE_STATE_TITLES,
  type CollectionItem, type ItemStateInfo, type MapLink, type PlaceGroup, type TransportMapModel, type UsedObject, type UseState,
} from './transport-collection';

export interface TransportViewOptions {
  now?: () => Date;
  /** Save a text file (tests replace it). */
  download?: (name: string, text: string) => void;
  /** Write to the clipboard (tests replace it). */
  copy?: (text: string) => Promise<boolean>;
}

/** Lines of a part shown before "Show all". */
export const PART_LINES_SHOWN = 12;
/** Objects only the target has listed at most. */
export const TARGET_ONLY_SHOWN = 300;
/** "Used by" lists the objects one by one up to this many, else by class. */
export const USED_BY_LISTED = 8;
/** IDs a "not found" line names before "and n more". */
export const NAMES_SHOWN = 20;

/** The title of the tag on a row with a numeric ID. */
export const NUMERIC_ID_TITLE = 'BMP assigned this ID. It may name another object on the target, so "all" leaves this row out.';

/** Depth a row is indented by at most (tr-d1 … tr-d6), so a deep row keeps
 *  a readable ID. */
export const DEPTH_CAP = 6;

/** The one sentence above the comparison script. */
export const PROBE_LEAD = 'Run each part with Preview on the target, then paste the whole answer of every part below.';
/** The empty transport. */
export const EMPTY_TRANSPORT = 'Nothing in the transport yet. Tick objects under Find.';
/** Always shown at the top of the Transport tab: what a transport is for. */
export const TRANSPORT_PURPOSE = 'Carries the objects you ticked under Find from this workspace to another one. Compare shows what would be added, changed, moved or deleted there. Nothing is written until you apply.';
/** Shown while the objects are a stored draft that was not read again. */
export const DRAFT_NOTE = 'These objects are from an earlier session. Refresh reads them again; Clear removes them.';
export const TARGET_DEFAULT_TITLE = 'The first other connected workspace is chosen. Pick another one here.';
/** The target picker's choices without a connection. */
export const PASTE_TARGET = 'Another workspace: compare by pasted script';
export const ANY_TARGET = 'Another workspace: scripts only, no comparison';
export const NO_TARGETS = 'No other workspace connected';
/** The delete line of the confirmation. */
export const CONFIRM_DELETE = 'Deleting cannot be undone and removes everything under each object.';
/** The delete line of an undo's confirmation: only objects with nothing under them. */
export const undoDeleteSentence = (n: number): string => (n === 1 ? '1 object the apply added is deleted again.' : `${n.toLocaleString('en-US')} objects the apply added are deleted again.`);
/** The help under a dry run that names objects. */
export const DRY_RUN_HELP = 'Remove these objects from the transport or make the target accept them, then compare again.';
/** Under the areas of Find: what Transport does not carry. */
export const NOT_TRANSPORTED = 'Not transported: Process Management, custom periods, organisations and their linked copies.';
/** Lines under the summary shown before "n more". */
export const NEEDS_SHOWN = 4;

/** "2 class links are removed: …", next to CONFIRM_DELETE. */
export const unlinkSentence = (n: number): string => (n === 1
  ? '1 class link is removed: the values of the property on objects of this class are lost.'
  : `${n.toLocaleString('en-US')} class links are removed: the values of the property on objects of these classes are lost.`);

/** "16 Nov 21:40": when an apply was (local time). */
export function applyTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${mon} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Last apply to Demo TEST: 16 Nov 21:40 · 3 added, 12 changed, 1 moved". */
export function lastApplyLine(r: UndoRecord): string {
  const bits = [r.added.length ? `${r.added.length} added` : '', r.changed.length ? `${r.changed.length} changed` : '', r.moved.length ? `${r.moved.length} moved` : ''].filter(Boolean);
  return `Last apply to ${r.targetLabel}: ${applyTime(r.at)}${bits.length ? ` · ${bits.join(', ')}` : ''}${r.stoppedAfter ? ` · stopped after part ${r.stoppedAfter.part} of ${r.stoppedAfter.total}` : ''}`;
}

/** "2 class links to remove", in the summary and the confirmation's counts. */
export const unlinkCount = (n: number): string => `${n.toLocaleString('en-US')} class link${n === 1 ? '' : 's'} to remove`;
/** Said in the confirmation above TRANSPORT_APPLY_WARN_CHARS. */
export const MEMORY_WARNING = 'This much script text stays in the target server\'s memory until it restarts.';
/** The help line of the Files option. */
export const FILES_HELP = 'Larger files are added without content. Upload them on the target afterwards.';
export const FILES_OFF_HELP = 'Off: files are added without content. Upload them on the target afterwards.';
export const FILES_ON_HELP = 'On: reading and writing file content can be slow on the workspace and makes the scripts large.';

/** "2 schedules are in this transport: they run on the target as they are set here." */
export const scheduleSentence = (n: number, target = 'the target'): string => (n === 1
  ? `1 schedule is in this transport: it runs on ${target} as it is set here.`
  : `${n.toLocaleString('en-US')} schedules are in this transport: they run on ${target} as they are set here.`);

/** "3 files are added without content: upload them on Test". */
export const uploadSentence = (n: number, target: string): string => (n === 1
  ? `1 file is added without content: upload it on ${target}`
  : `${n.toLocaleString('en-US')} files are added without content: upload them on ${target}`);

/** "Used by" when nothing was found, and after what was found. */
export const NOT_SEARCHED = 'Expressions outside this transport are not searched.';
export const NOTHING_USES = `Nothing found. ${NOT_SEARCHED}`;
/** A row opened before anything was read. */
export const COMPARE_TO_SEE = 'Compare to see what it uses.';
export const BUILD_TO_SEE = 'Build scripts to see what it uses.';

/** "12 s", "3 min 5 s". */
export function elapsedText(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

type AnyPart = BundlePart | ProbePart | PatchPart;

/** The level of a line under the summary. */
export type NeedLevel = 'danger' | 'needs' | 'know';
const NEED_RANK: Readonly<Record<NeedLevel, number>> = { danger: 0, needs: 1, know: 2 };

/**
 * The lines under the summary (each with `data-level`): danger, then needs
 * you, then to know, each level in the order given; after NEEDS_SHOWN the
 * rest folds behind "n more". `state.open` keeps the fold across redraws.
 */
export function needsBlock(lines: readonly HTMLElement[], state: { open: boolean }): HTMLElement {
  const rank = (e: HTMLElement) => NEED_RANK[(e.dataset.level ?? 'know') as NeedLevel] ?? 2;
  const sorted = lines.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map(x => x.e);
  const box = el('div', 'tr-needs', ...sorted.slice(0, NEEDS_SHOWN));
  const rest = sorted.slice(NEEDS_SHOWN);
  if (!rest.length) return box;
  const more = el('div', 'tr-needs-more', ...rest);
  more.hidden = !state.open;
  const label = () => (state.open ? 'Show fewer' : `${rest.length.toLocaleString('en-US')} more`);
  const toggle = attrs(btn('tr-link tr-needs-toggle', undefined, () => {
    state.open = !state.open;
    more.hidden = !state.open;
    toggle.textContent = label();
    toggle.setAttribute('aria-expanded', String(state.open));
  }, label()), { 'aria-expanded': String(state.open) });
  box.append(more, toggle);
  return box;
}

const STEP_TITLES: Readonly<Record<AnyPart['step'], string>> = {
  probe: 'Compare', listing: 'What the target has', check: 'Check', rename: 'Change ID', create: 'Add', set: 'Change', link: 'Link', own: 'Change per class', setAgain: 'Change (uses added objects)', order: 'Move', delete: 'Delete',
  record: 'Log entry', report: 'Report',
};

/** "Part 2 of 6 · Change · run with Execute" (the Extended Code window's
 *  words for its two runs: Preview and Execute). */
export function partTitle(p: AnyPart): string {
  const step = p.stepTotal > 1 ? `${STEP_TITLES[p.step]} (${p.stepIndex} of ${p.stepTotal})` : STEP_TITLES[p.step];
  return `Part ${p.index} of ${p.total} · ${step} · ${p.run === 'committed' ? 'run with Execute' : 'run with Preview'}`;
}

function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const checkbox = (cls: string, label: string): HTMLInputElement => attrs(el('input', cls) as HTMLInputElement, { type: 'checkbox', 'aria-label': label });

/** A button for a delegated listener (none of its own). */
function plainBtn(cls: string, ...kids: Array<Node | string | null>): HTMLButtonElement {
  const b = el('button', cls, ...kids) as HTMLButtonElement;
  b.type = 'button';
  return b;
}

const count = (n: number) => n.toLocaleString('en-US');

/** "t.a, t.b and 3 more". */
function namesText(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(', ');
  return names.length > NAMES_SHOWN ? `${shown} and ${count(names.length - NAMES_SHOWN)} more` : shown;
}

export interface TransportView {
  dispose(): void;
}

export function mountTransportView(host: HTMLElement, ctl: TransportController, opts: TransportViewOptions = {}): TransportView {
  const now = opts.now ?? (() => new Date());
  const download = opts.download ?? saveText;
  const write = opts.copy;

  // ── tabs ────────────────────────────────────────────────────────
  const tabFind = attrs(btn('tr-tab', undefined, () => ctl.showTab('find'), 'Find'), { role: 'tab', 'data-tab': 'find', id: 'tr-tab-find', 'aria-controls': 'tr-find' });
  const tabCount = el('span', 'tr-tab-n');
  const tabTransport = attrs(btn('tr-tab', undefined, () => ctl.showTab('transport'), 'Transport', tabCount), { role: 'tab', 'data-tab': 'transport', id: 'tr-tab-transport', 'aria-controls': 'tr-transport' });
  const logBtn = btn('tr-logbtn ui-tbtn', 'Transport log of this workspace', () => { void ctl.openLog(); }, icon('i-clock'), 'Log');
  const tabs = attrs(el('div', 'tr-tabs', tabFind, tabTransport), { role: 'tablist', 'aria-label': 'Transport' });
  const top = el('div', 'tr-top', tabs, el('span', 'tr-sp'), logBtn);

  // ── find bar: one box and three filter buttons ──────────────────
  const queryInput = attrs(el('input', 'tr-q') as HTMLInputElement, { type: 'search', placeholder: 'ID or name, or paste IDs', 'aria-label': 'Find', spellcheck: 'false', autocomplete: 'off' });
  queryInput.addEventListener('input', () => ctl.setBox(queryInput.value));
  // Lines pasted into the box become one line, separated by commas: a list.
  queryInput.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    const list = text.trim().split(/\s*[\r\n]+\s*/).join(', ');
    queryInput.setRangeText(list, queryInput.selectionStart ?? queryInput.value.length, queryInput.selectionEnd ?? queryInput.value.length, 'end');
    ctl.setBox(queryInput.value);
  });
  const queryField = el('span', 'tr-qf ui-search', icon('i-search'), queryInput);

  const chev = () => icon('i-chev', 'ic-sm ui-disc-chev');
  const fbClear = (cls: string, label: string, fn: () => void) => { const b = btn(`fb-x ${cls}`, label, fn, icon('i-x', 'ic-sm')); b.hidden = true; return b; };

  // Changed
  const changedVal = el('span', 'fb-v');
  const changedBtn = attrs(btn('fb-b tr-changed', undefined, () => setPopover('changed', changedPop.hidden !== false), el('span', 'fb-l', 'Changed:'), ' ', changedVal, chev()), { 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const changedClear = fbClear('tr-changedclear', 'Clear Changed', () => ctl.clearChanged());
  const changedBox = el('span', 'fb tr-changedbox', changedBtn, changedClear);
  const SINCE_CHOICES: ReadonlyArray<{ key: SinceKey; label: string }> = [
    { key: 'any', label: 'Any date' }, { key: 'today', label: 'Today' }, { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: 'last', label: 'Since the last transport' },
  ];
  const sinceSeg = attrs(el('span', 'tr-seg tr-sinceseg'), { role: 'group', 'aria-label': 'Changed' });
  const sinceBtns = SINCE_CHOICES.map(c => {
    const b = btn('', undefined, () => ctl.setChanged(c.key), c.label);
    b.dataset.since = c.key;
    sinceSeg.append(b);
    return b;
  });
  const since = attrs(el('input', 'tr-since ui-input') as HTMLInputElement, { type: 'date', 'aria-label': 'Changed since' });
  since.addEventListener('change', () => (since.value ? ctl.setChanged('custom', since.value) : ctl.setChanged('any')));
  const userSel = attrs(el('select', 'tr-user ui-input') as HTMLSelectElement, { 'aria-label': 'Changed by' });
  userSel.addEventListener('change', () => ctl.setFilters({ user: userSel.value }));
  const newOnly = attrs(btn('tr-new ui-sw', 'New only', () => ctl.setFilters({ newOnly: !ctl.filters.newOnly })), { role: 'switch', 'aria-checked': 'false' });
  const newOnlyField = el('label', 'tr-fl tr-fl-sw pop-line pop-sw', newOnly, el('span', 'tr-fl-t', 'New only'));
  const userField = el('label', 'tr-fl pop-line', el('span', 'tr-fl-t', 'By'), userSel);
  const changedPop = attrs(el('div', 'tr-pop ui-menu pop-changed', sinceSeg, el('label', 'tr-fl pop-line', el('span', 'tr-fl-t', 'Since'), since), userField, newOnlyField), { role: 'group', 'aria-label': 'Changed' });
  changedPop.hidden = true;
  const changedWrap = el('span', 'fb-wrap tr-changed-wrap', changedBox, changedPop);

  // Areas
  const whereVal = el('span', 'fb-v');
  const whereBtn = attrs(btn('fb-b tr-where', undefined, () => setPopover('areas', pop.hidden !== false), el('span', 'fb-l', 'Areas:'), ' ', whereVal, chev()), { 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const whereClear = fbClear('tr-areasclear', 'Back to the default areas', () => ctl.resetAreas());
  const whereBox = el('span', 'fb tr-areasbox', whereBtn, whereClear);
  const pop = attrs(el('div', 'tr-pop ui-menu pop-areas'), { role: 'group', 'aria-label': 'Areas to look in' });
  pop.hidden = true;
  const areaBoxes = new Map<TransportRoot, HTMLInputElement>();
  const areaOption = (root: TransportRoot) => {
    const box = attrs(el('input', 'tr-area-ck') as HTMLInputElement, { type: 'checkbox', 'data-root': root });
    areaBoxes.set(root, box);
    return el('label', 'tr-opt', box, el('span', '', AREA_LABELS[root]));
  };
  pop.append(...AREA_ORDER.filter(isDefaultArea).map(areaOption), el('div', 'tr-pop-sep'), ...AREA_ORDER.filter(r => !isDefaultArea(r)).map(areaOption), el('p', 'tr-pop-note', NOT_TRANSPORTED));
  pop.addEventListener('change', e => {
    const t = e.target as HTMLInputElement;
    const root = t.dataset.root as TransportRoot | undefined;
    if (root) ctl.setAreaChoice(root, t.checked);
  });
  const whereWrap = el('span', 'fb-wrap tr-where-wrap', whereBox, pop);

  // This page
  const pageBtn = attrs(btn('fb-b plain tr-page', undefined, () => ctl.setOnPage(!ctl.onPage), 'This page'), { 'aria-pressed': 'false' });
  const pageClear = fbClear('tr-pageclear', 'Clear This page', () => ctl.setOnPage(false));
  const pageBox = el('span', 'fb tr-pagebox', pageBtn, pageClear);

  const stopBtn = btn('tr-stop ui-btn', undefined, () => ctl.stopFind(), 'Stop');
  stopBtn.hidden = true;
  const filterBtns = el('span', 'tr-filters', changedWrap, whereWrap, pageBox);
  const findBar = el('div', 'tr-findbar', queryField, filterBtns, stopBtn);

  const popovers = { changed: { btn: changedBtn, pop: changedPop, wrap: changedWrap }, areas: { btn: whereBtn, pop, wrap: whereWrap } } as const;
  function setPopover(name: keyof typeof popovers | null, open: boolean): void {
    for (const [k, p] of Object.entries(popovers)) {
      const on = k === name && open;
      p.pop.hidden = !on;
      p.btn.setAttribute('aria-expanded', String(on));
    }
  }
  const onDocDown = (e: MouseEvent) => {
    for (const [k, p] of Object.entries(popovers)) if (!p.pop.hidden && !p.wrap.contains(e.target as Node)) setPopover(k as keyof typeof popovers, false);
  };
  document.addEventListener('mousedown', onDocDown);

  const findStatus = attrs(el('div', 'tr-status'), { role: 'status', 'aria-live': 'polite' });

  // ── result list ─────────────────────────────────────────────────
  const list = attrs(el('div', 'tr-list'), { role: 'list', 'aria-label': 'Workspace' });

  const footCount = el('span', 'tr-selcount');
  const openBtn = btn('tr-open ui-btn primary', undefined, () => ctl.showTab('transport'), 'Open transport');
  const foot = el('div', 'tr-foot', footCount, el('span', 'tr-sp'), openBtn);

  const findMain = el('div', 'tr-main', list);
  const findPanel = attrs(el('section', 'tr-panel tr-find', findBar, findStatus, findMain, foot), { id: 'tr-find', role: 'tabpanel', 'aria-labelledby': 'tr-tab-find' });

  // ── transport ───────────────────────────────────────────────────
  const targetSel = attrs(el('select', 'tr-target ui-input') as HTMLSelectElement, { 'aria-label': 'Target', title: TARGET_DEFAULT_TITLE });
  targetSel.addEventListener('change', () => ctl.setChoice(targetSel.value));
  const actBtn = btn('tr-act ui-btn primary', undefined, () => { void ctl.compareOrBuild(); }, 'Compare');
  const applyBtn = btn('tr-apply ui-btn', undefined, () => ctl.requestApply(), 'Apply');
  const busyLine = attrs(el('span', 'tr-busy'), { role: 'status', 'aria-live': 'polite' });
  const thead = el('div', 'tr-thead', el('label', 'tr-fl', el('span', 'tr-fl-t', 'Target'), targetSel), actBtn, applyBtn, busyLine);
  // The last apply to the chosen target, when it was kept here: Undo, Remove.
  const lastLine = el('div', 'tr-lastapply');

  const stateBox = el('div', 'tr-direct-state');
  const sumBox = el('div', 'tr-sumbox');
  const pasteBox = el('div', 'tr-pastebox');
  const scriptsBox = el('div', 'tr-scriptsbox');
  const optsBox = el('div', 'tr-optsbox');

  const viewSeg = attrs(el('span', 'tr-seg tr-viewseg'), { role: 'group', 'aria-label': 'View' });
  const viewBtns = (['list', 'map'] as const).map(v => {
    const b = btn('', undefined, () => ctl.setTransportView(v), v === 'list' ? 'List' : 'Map');
    b.dataset.view = v;
    viewSeg.append(b);
    return b;
  });
  const draftText = el('span', 'tr-draft-t');
  const refreshBtn = btn('tr-refresh ui-tbtn', 'Read the objects again on this workspace', () => { if (ctl.refreshing) ctl.stopRefresh(); else void ctl.refreshTransport(); }, 'Refresh');
  const clearBtn = btn('tr-clearall ui-tbtn', 'Remove every object from the transport', () => ctl.clearTransport(), 'Clear');
  const copyIdsLabel = el('span', '', 'Copy IDs');
  const copyIdsBtn = btn('tr-copyids ui-tbtn', 'Copy the addresses of the transport, one per line, for an ID list', () => {
    void copyWithFeedback(ctl.transportAddresses().join('\n'), copyIdsBtn, { textTarget: copyIdsLabel, ms: 2000, ...(write ? { write } : {}) });
  }, copyIdsLabel);
  const ttools = el('div', 'tr-ttools', viewSeg, el('span', 'tr-sp'), draftText, refreshBtn, copyIdsBtn, clearBtn);
  const tlist = attrs(el('div', 'tr-tlist'), { role: 'list', 'aria-label': 'Objects in the transport' });
  const tmap = el('div', 'tr-mapview');
  const draftNote = el('p', 'tr-draftnote', DRAFT_NOTE);
  draftNote.hidden = true;
  const tempty = el('p', 'tr-empty tr-tempty', EMPTY_TRANSPORT);
  const transportMain = el('div', 'tr-main tr-tmain', stateBox, sumBox, pasteBox, ttools, draftNote, tempty, tlist, tmap, scriptsBox, optsBox);
  transportMain.addEventListener('click', e => {
    // A clamped value opens to its full text, and closes again.
    const v = (e.target as HTMLElement).closest<HTMLElement>('.tr-val');
    if (v && !(e.target as HTMLElement).closest('button, a, input')) v.classList.toggle('open');
  });
  const transportPanel = attrs(el('section', 'tr-panel tr-transport', el('p', 'tr-purpose', TRANSPORT_PURPOSE), thead, lastLine, transportMain), { id: 'tr-transport', role: 'tabpanel', 'aria-labelledby': 'tr-tab-transport' });

  // ── transport log ───────────────────────────────────────────────
  const logView = el('div', 'tr-main tr-logview');

  const root = el('div', 'tr ui', top, findPanel, transportPanel, logView);
  host.replaceChildren(root);

  // Delegated result list events.
  list.addEventListener('change', e => {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('tr-ck') && t.dataset.rid) ctl.setTicked(t.dataset.rid, t.checked);
  });
  const groupOf = (t: Element) => t.closest<HTMLElement>('.tr-grp')?.dataset.root as GroupKey | undefined;
  const inTree = (t: Element) => !!t.closest('.tr-grp.browse');
  /** The end button of a row or a header. */
  function onSub(sub: HTMLElement): void {
    const mode = sub.dataset.mode;
    const pressed = sub.getAttribute('aria-pressed') === 'true';
    const head = sub.closest<HTMLElement>('.tr-gh');
    if (mode === 'whole') { if (sub.dataset.rid) ctl.releaseWhole(sub.dataset.rid); return; }
    if (mode === 'all') { if (sub.dataset.rid) void ctl.takeAll(sub.dataset.rid); return; }
    if (mode === 'area') {
      const root = sub.dataset.root as TransportRoot | undefined;
      if (root) { if (pressed) ctl.releaseArea(root); else void ctl.takeArea(root); }
      return;
    }
    const r = groupOf(sub);
    if (!r) return;
    if (head) { ctl.setGroupTicked(r, !pressed); return; }
    const key = sub.closest<HTMLElement>('.tr-row')?.dataset.key;
    if (key) ctl.setSubtreeTicked(r, key, !pressed);
  }
  list.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const caret = t.closest<HTMLElement>('.tr-caret');
    if (caret) {
      if (inTree(caret)) { if (caret.dataset.key) ctl.toggleBrowse(caret.dataset.key); return; }
      const r = groupOf(caret);
      if (r && caret.dataset.key) ctl.toggleNode(r, caret.dataset.key);
      return;
    }
    const sub = t.closest<HTMLElement>('.tr-sub');
    if (sub) { onSub(sub); return; }
    // A click between the cells of a row ticks its box, as one on a cell does.
    if (t.classList.contains('tr-row')) { t.querySelector<HTMLInputElement>(':scope > .tr-lb > .tr-tc > .tr-ck')?.click(); return; }
    const restBtn = t.closest<HTMLElement>('.tr-rest');
    if (restBtn?.dataset.root) { void ctl.readRest(restBtn.dataset.root as GroupKey); return; }
    const retry = t.closest<HTMLElement>('.tr-retry');
    if (retry?.dataset.key) { ctl.retryBrowse(retry.dataset.key); return; }
    if (retry?.dataset.root) { void ctl.retry(retry.dataset.root as GroupKey); return; }
    const head = t.closest<HTMLElement>('.tr-gh');
    if (!head) return;
    const sec = head.closest<HTMLElement>('.tr-grp');
    if (sec?.classList.contains('browse')) { if (sec.dataset.key) ctl.toggleBrowse(sec.dataset.key); return; }
    if (head.dataset.root) ctl.toggleGroup(head.dataset.root as GroupKey);
  });

  // Delegated transport list events.
  tlist.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const rm = t.closest<HTMLElement>('.tr-rm');
    if (rm?.dataset.rid) { ctl.remove(rm.dataset.rid); return; }
    const caret = t.closest<HTMLElement>('.tr-tcaret');
    if (caret?.dataset.rid) { ctl.toggleRow(caret.dataset.rid); return; }
    const head = t.closest<HTMLElement>('.tr-pgt');
    if (head?.dataset.key) { ctl.togglePlace(head.dataset.key); return; }
    const used = t.closest<HTMLElement>('.tr-usedby-go');
    if (used?.dataset.rid) { void ctl.readUsedBy(used.dataset.rid); return; }
    const stopUsed = t.closest<HTMLElement>('.tr-usedby-stop');
    if (stopUsed?.dataset.rid) { ctl.stopUsedBy(stopUsed.dataset.rid); return; }
    const chip = t.closest<HTMLElement>('.tr-chip[data-rid]');
    if (chip?.dataset.rid) { ctl.showInList(chip.dataset.rid); return; }
  });
  tlist.addEventListener('change', e => {
    const t = e.target as HTMLInputElement;
    if (t.classList.contains('tr-ren') && t.dataset.key) ctl.setRename(t.dataset.key, t.checked);
  });

  // ── find: drawing ───────────────────────────────────────────────

  /** The users of the rows shown, by key: the label of the By button. */
  let userLabels = new Map<string, string>();

  function drawFindBar(): void {
    const day = ctl.changedDay;
    changedVal.textContent = changedValue(ctl.sinceKey, day, ctl.filters.user ? userLabels.get(ctl.filters.user) ?? ctl.filters.user : '', ctl.filters.newOnly, now());
    changedBox.classList.toggle('set', ctl.changedSet);
    changedClear.hidden = !ctl.changedSet;
    for (const b of sinceBtns) {
      b.classList.toggle('on', b.dataset.since === ctl.sinceKey);
      if (b.dataset.since === 'last') b.hidden = !ctl.lastTransportDay;
    }
    since.value = day;
    userSel.disabled = !day;
    newOnly.disabled = !day;
    newOnly.setAttribute('aria-checked', String(ctl.filters.newOnly));

    whereVal.textContent = areasValue(ctl.chosen);
    whereBox.classList.toggle('set', !ctl.defaultAreas);
    whereClear.hidden = ctl.defaultAreas;
    for (const [r, box] of areaBoxes) box.checked = ctl.chosen.has(r);

    pageBox.classList.toggle('set', ctl.onPage);
    pageBtn.setAttribute('aria-pressed', String(ctl.onPage));
    pageClear.hidden = !ctl.onPage;

    if (queryInput.value !== ctl.box && document.activeElement !== queryInput) queryInput.value = ctl.box;
    stopBtn.hidden = !ctl.findReading;
    logBtn.disabled = ctl.busy;
  }

  function errorLine(target: HTMLElement, text: string, ...extra: HTMLElement[]): void {
    target.classList.add('err');
    target.setAttribute('role', 'alert');
    target.append(icon('i-warn'), el('span', '', text), ...extra);
  }

  function drawFindStatus(): void {
    findStatus.replaceChildren();
    findStatus.className = 'tr-status';
    findStatus.setAttribute('role', 'status');
    if (ctl.error && !ctl.bundle?.error) { errorLine(findStatus, ctl.error); return; }
    const taking = ctl.taking;
    if (taking) {
      findStatus.append(el('span', '', taking.key.startsWith('a:') ? `Reading ${taking.label}` : `Reading everything under ${taking.label}`));
      return;
    }
    const run = ctl.run;
    if (run) {
      const ra = run.rest ? ctl.areas.find(x => x.root === run.current) : undefined;
      let text: string;
      if (run.stopped) text = 'Stopping';
      else if (ra) text = `Reading the rest of ${ctl.groupLabel(ra)} · ${plural(ra.rows.length, 'object')} read`;
      else if (run.current === UNDER) text = `Reading ${ctl.startAddress}`;
      else if (run.current === IDLIST) text = `Looking up ${count(run.done ?? 0)} of ${count(run.total ?? 0)}`;
      else if (run.current === ONPAGE) text = run.total ? `Reading ${count(run.done ?? 0)} of ${count(run.total)}` : 'Reading the page';
      else text = `Reading ${AREA_LABELS[run.current as TransportRoot]} · ${run.index + 1} of ${run.roots.length} · ${count(ctl.found())} found`;
      findStatus.append(el('span', '', text));
      return;
    }
    if (ctl.findMode === 'browse') return;
    const o = ctl.outcome;
    if (!o || o.kind === 'failed') return;
    const n = ctl.found();
    const a = ctl.areas.find(x => x.root === IDLIST) ?? ctl.areas[0];
    let text = '';
    switch (ctl.scannedScope) {
      case 'under':
        if (o.kind !== 'done' || a?.status !== 'done') return;
        text = `${plural(n, ctl.scannedSince ? 'change' : 'object')} under ${ctl.startAddress}${ctl.scannedSince ? ` since ${dayText(ctl.scannedSince)}` : ''}`;
        break;
      case 'ids': {
        const asked = (a?.rows.length ?? 0) + (a?.notFound?.length ?? 0);
        text = o.kind === 'stopped' ? `Stopped · ${count(n)} found` : `${count(n)} of ${count(asked)} found`;
        break;
      }
      case 'page':
        text = o.kind === 'stopped' ? `Stopped · ${count(n)} found` : `${plural(n, 'object')} on this page`;
        break;
      case 'search': {
        const shown = ctl.areas.filter(x => x.root !== UNDER && ctl.visibleRows(x).length).length;
        text = o.kind === 'stopped' ? `Stopped after ${o.areas} of ${o.of} ${o.of === 1 ? 'area' : 'areas'} · ${count(n)} found` : `${plural(n, 'match', 'matches')} in ${plural(shown, 'area')}`;
        break;
      }
      default:
        text = o.kind === 'stopped' ? `Stopped after ${o.areas} of ${o.of} ${o.of === 1 ? 'area' : 'areas'} · ${count(n)} found` : `${plural(n, 'change')} since ${dayText(ctl.scannedSince ?? '')}`;
    }
    if (n === 0 && o.kind === 'done') return;
    findStatus.append(el('span', '', text));
    if (ctl.scannedScope === 'ids' && o.kind === 'done' && n) {
      const add = btn('tr-link tr-addfound', undefined, () => ctl.addFound(), `Add the ${count(n)} found`);
      add.disabled = ctl.locked;
      findStatus.append(add);
    }
  }

  function drawUsers(): void {
    const users = usersOf(ctl.allRows());
    userLabels = new Map(users.map(u => [u.key, u.label]));
    const keep = ctl.filters.user;
    userSel.replaceChildren(attrs(el('option', '', 'Anyone') as HTMLOptionElement, { value: '' }), ...users.map(u => attrs(el('option', '', u.label) as HTMLOptionElement, { value: u.key })));
    userSel.value = users.some(u => u.key === keep) ? keep : '';
    if (userSel.value !== keep) ctl.filters = { ...ctl.filters, user: '' };
  }

  /** The tag of a linked copy. */
  const linkedTag = (template: string) => attrs(el('span', 'tr-tag linked', 'linked copy'), { title: `Linked to ${template}` });

  /** `text` with the words marked. */
  function marked(text: string, words: readonly string[]): Array<Node | string> {
    if (!words.length || !text) return [text];
    const low = text.toLowerCase();
    const on = new Array<boolean>(text.length).fill(false);
    for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) for (let j = i; j < i + w.length; j++) on[j] = true;
    const out: Array<Node | string> = [];
    for (let i = 0; i < text.length;) {
      let j = i;
      while (j < text.length && on[j] === on[i]) j++;
      out.push(on[i] ? el('mark', '', text.slice(i, j)) : text.slice(i, j));
      i = j;
    }
    return out;
  }

  /** Objects (rid) that have an object of the transport below them, as far as
   *  the tree and the results know the way up: their tick box is partly on. */
  function partlyTicked(): Set<string> {
    const set = new Set<string>();
    const parentOf = (rid: string) => ctl.row(rid)?.parentRid ?? ctl.browsedRow(rid)?.parentRid ?? ctl.collection.get(rid)?.row.parentRid ?? '';
    for (const item of ctl.collection.list()) {
      for (let p = item.row.parentRid, guard = 0; p && !set.has(p) && guard < 64; p = parentOf(p), guard++) set.add(p);
    }
    return set;
  }

  /** The end button of a row or area: what it takes and how it reads. */
  interface SubCtl { spec: SubSpec; pressed: boolean; attrs: Record<string, string> }
  function subBtn(s: SubCtl): HTMLButtonElement {
    const b = attrs(plainBtn(`tr-sub${s.spec.mode === 'whole' ? ' on' : ''}`, subLabel(s.spec)), { 'aria-pressed': String(s.pressed), 'data-mode': s.spec.mode, ...s.attrs });
    b.disabled = ctl.locked || !!ctl.taking;
    b.title = s.spec.mode === 'whole' ? 'Remove the folder and everything under it' : s.spec.mode === 'hits' ? (s.pressed ? 'Remove its matches' : 'Add its matches') : s.spec.mode === 'area' ? (s.pressed ? 'Remove what it added' : 'Add every object in the area') : 'Add it and everything under it as one folder';
    return b;
  }

  interface RowSpec {
    row?: TransportScanRow;
    id: string;
    name: string;
    depth: number;
    dim?: boolean;
    exact?: boolean;
    caret?: { open: boolean; key: string };
    sub?: SubCtl | null;
    words: readonly string[];
    partly: ReadonlySet<string>;
    /** What the row's data attributes say. */
    key?: string;
  }

  /** One line: a row (its tick box, `dim` when only an ancestor of a match),
   *  or a context line for a parent that is not among the rows. The caret and
   *  the end button sit outside the row's label (`tr-lb`), so a click on them
   *  never ticks the box. */
  function rowEl(o: RowSpec): HTMLElement {
    const r = o.row;
    const cell = el('span', 'tr-tc');
    if (r) {
      const box = checkbox('tr-ck', `In transport: ${r.id || r.name || r.rid}`);
      box.dataset.rid = r.rid;
      box.checked = ctl.inTransport(r.rid);
      box.indeterminate = !box.checked && o.partly.has(r.rid);
      box.disabled = ctl.locked;
      cell.append(box);
    } else {
      cell.append(el('span', 'tr-ck-none'));
    }
    cell.append(attrs(el('span', 'tr-id', ...marked(o.id, o.words)), { title: o.id }));
    const kids: Array<Node | null> = [cell];
    if (r) {
      const tags = el('span', 'tr-tags');
      if (ctl.isNew(r)) tags.append(el('span', 'tr-tag new', 'new'));
      if (r.linkedTo) tags.append(linkedTag(r.linkedTo));
      if (isNumericId(r)) tags.append(attrs(el('span', 'tr-tag auto', 'auto ID'), { title: NUMERIC_ID_TITLE }));
      kids.push(
        attrs(el('span', 'tr-nm', ...marked(r.name, o.words)), { title: r.name }),
        el('span', 'tr-cls', r.className),
        tags,
        attrs(el('span', 'tr-when', shortTime(r.modifiedIso, r.modified, now())), { title: r.modified }),
        attrs(el('span', 'tr-who', r.modifiedBy), { title: r.modifiedBy }),
      );
    } else {
      kids.push(attrs(el('span', 'tr-nm', o.name), { title: o.name }), el('span', 'tr-cls'), el('span', 'tr-tags'), el('span', 'tr-when'), el('span', 'tr-who'));
    }
    let caret: HTMLButtonElement | null = null;
    if (o.caret) {
      caret = attrs(plainBtn('tr-caret', icon('i-chev', `ui-disc-chev${o.caret.open ? '' : ' closed'}`)), {
        'aria-expanded': String(o.caret.open), 'aria-label': o.id || o.name || o.caret.key, 'data-key': o.caret.key,
      });
    }
    const subc = el('span', 'tr-subc');
    if (o.sub) subc.append(subBtn(o.sub));
    const d = Math.min(o.depth, DEPTH_CAP);
    const cov = !!r && ctl.coveredBy(r.rid);
    const cls = `tr-row${d ? ` tr-d${d}` : ''}${!r ? ' ctx' : ''}${o.dim ? ' dim' : ''}${cov ? ' cov' : ''}${o.exact ? ' hit-exact' : ''}`;
    const row = el('div', cls, caret, el(r ? 'label' : 'span', 'tr-lb', ...kids), subc);
    attrs(row, { role: 'listitem', 'data-depth': String(o.depth), ...(o.key ? { 'data-key': o.key } : {}), ...(r ? { 'data-rid': r.rid } : {}) });
    return row;
  }

  /** The end button of a row: a folder taken whole (pressed), none under one,
   *  else `hits` under a text or a date, else everything under it (`under`:
   *  the count the caller knows, or null to use the count read). */
  function rowSub(r: TransportScanRow | undefined, under: number | null, hits: { count: number; done: boolean } | null): SubCtl | null {
    if (!r) return null;
    const w = ctl.wholeFolder(r.rid);
    if (w) { const u = ctl.underCount(w); return { spec: { mode: 'whole', total: u.total, taken: u.taken }, pressed: true, attrs: { 'data-rid': r.rid } }; }
    if (ctl.coveredBy(r.rid)) return null;
    if (hits) return hits.count > 0 ? { spec: { mode: 'hits', count: hits.count, done: hits.done }, pressed: hits.done, attrs: {} } : null;
    const known = under ?? ctl.countOf(r.rid);
    if (known === 0) return null;
    return { spec: { mode: 'all', ...(known != null ? { count: known } : {}) }, pressed: false, attrs: { 'data-rid': r.rid } };
  }

  /** One line of a result group's tree. */
  function nodeEl(a: AreaResult, n: TreeNode, show: TreeShow, ticked: Int32Array, partly: ReadonlySet<string>, words: readonly string[]): HTMLElement {
    const r = n.row;
    const inUnder = a.root === UNDER;
    const state = show.state[n.index];
    const open = !ctl.nodeClosed(a.root, n);
    const c = show.ticks[n.end] - show.ticks[n.index + 1];
    const hits = inUnder ? null : { count: c, done: ticked[n.end] - ticked[n.index + 1] === c };
    const sub = rowSub(r, inUnder ? n.end - n.index - 1 : null, hits);
    const exact = inUnder && ctl.scannedScope === 'search' && !!a.origin && r?.rid === a.origin.rid;
    return rowEl({
      ...(r ? { row: r } : {}), id: n.id, name: n.name, depth: n.depth, key: n.key,
      dim: !!r && state !== MATCH, ...(exact ? { exact: true } : {}),
      ...(hasShownChildren(n, show) ? { caret: { open, key: n.key } } : {}), sub, words: inUnder ? [] : words, partly,
    });
  }

  function groupNotes(a: AreaResult, shown: number): HTMLElement[] {
    const notes: HTMLElement[] = [];
    const note = (cls: string, ...kids: Array<Node | string>) => notes.push(el('div', `tr-gnote ${cls}`, ...kids));
    const action = (cls: string, label: string) => attrs(plainBtn(`tr-link ${cls}`, label), { 'data-root': a.root });
    const again = (label: string) => action('tr-retry', label);
    const single = a.root === IDLIST || a.root === ONPAGE;
    if (a.status === 'waiting') note('', 'Waiting');
    else if (a.status === 'scanning' && !single) note('', 'Reading');
    else if (a.status === 'missing') note('', 'Not on this workspace');
    else if (a.status === 'failed') note('err', el('span', '', a.error ?? 'The search failed.'), ...(single ? [] : [again('Try again')]));
    else if (a.status === 'stopped' && !single) note('', el('span', '', 'Not read'), again(a.root === UNDER ? 'Find again' : 'Read this area'));
    if (a.root === IDLIST) {
      if (a.notFound?.length) note('cap', `Not found: ${namesText(a.notFound)}`);
      if (a.invalid?.length) note('err', `Not IDs: ${namesText(a.invalid)}`);
      if (a.more) note('cap', 'Only the first 500 IDs were looked up.');
    }
    const under = a.root === UNDER;
    const search = ctl.scannedScope === 'search';
    if (search && a.more && !under) note('cap', `More than ${count(TRANSPORT_SEARCH_CAP)} matches: make the text longer`);
    const unit = under && !ctl.scannedSince ? 'objects' : 'changes';
    const hint = under && !ctl.scannedSince ? 'choose an object further down' : 'choose a later date';
    const rest = a.rest;
    const read = plural(a.rows.length, 'object');
    if (rest?.full) note('cap', `More than ${count(TRANSPORT_SCAN_TOTAL)} ${unit}: ${hint}`);
    else if (rest?.status === 'reading') note('', 'Reading');
    else if (rest?.status === 'stopped') note('cap', el('span', '', `Stopped · ${read} read`), action('tr-rest', 'Read the rest'));
    else if (rest?.status === 'done' && rest.failed.length) note('err', el('span', '', `${plural(rest.failed.length, 'child', 'children')} could not be read`), action('tr-rest', 'Try again'));
    else if (a.more && !rest && !search && !single) note('cap', el('span', '', `More than ${count(TRANSPORT_SCAN_CAP)} ${unit}: ${hint}`), action('tr-rest', 'Read the rest'));
    if (a.status === 'done' && a.rows.length && !shown && !ctl.collapsed.has(a.root)) note('', 'None match the filters');
    for (const b of notes.flatMap(x => [...x.querySelectorAll<HTMLButtonElement>('button')])) b.disabled = ctl.busy;
    return notes;
  }

  /** The header of a group or an area: its caret, name and count, and its end button. */
  function headEl(root: string, label: string, open: boolean, n: string | null, sub: SubCtl | null, extra: Record<string, string> = {}): HTMLElement {
    const toggle = attrs(plainBtn('tr-gt', icon('i-chev', `ui-disc-chev${open ? '' : ' closed'}`), attrs(el('span', 't', label), { title: label }), n ? el('span', 'n', n) : null), { 'aria-expanded': String(open) });
    const subc = el('span', 'tr-subc');
    if (sub) subc.append(subBtn(sub));
    return attrs(el('div', 'tr-gh ui-band ui-disc', toggle, subc), { 'data-root': root, ...extra });
  }

  function groupEl(a: AreaResult, partly: ReadonlySet<string>): HTMLElement {
    const visible = ctl.visibleRows(a);
    const open = !ctl.collapsed.has(a.root);
    const total = isTransportRoot(a.root) && (ctl.scannedScope === 'search' || ctl.scannedScope === 'changed') ? ctl.countOf(areaKey(a.root)) : undefined;
    const c = a.rows.length ? (total != null ? `${count(visible.length)} of ${count(total)}` : filtersActive(ctl.filters) && visible.length !== a.rows.length ? `${count(visible.length)} of ${count(a.rows.length)}` : count(a.rows.length)) : null;
    const label = ctl.groupLabel(a);
    const addable = visible.filter(r => !isNumericId(r));
    const done = ctl.groupTick(a) === 'all';
    const sub: SubCtl | null = addable.length && a.root !== UNDER ? { spec: { mode: 'hits', count: addable.length, done }, pressed: done, attrs: {} } : null;
    const head = headEl(a.root, label, open, c, sub);
    const sec = attrs(el('section', 'tr-grp', head, ...groupNotes(a, visible.length)), { 'data-root': a.root, 'aria-label': label });
    if (open && visible.length) {
      const tree = ctl.groupTree(a);
      const show = ctl.groupShow(a);
      const ticked = ctl.subtreeTicked(a);
      const words = wordsOf(ctl.filters.text);
      const rows = el('div', 'tr-rows');
      const frag = document.createDocumentFragment();
      for (const n of visibleNodes(tree, show, x => ctl.nodeClosed(a.root, x))) frag.append(nodeEl(a, n, show, ticked, partly, words));
      rows.append(frag);
      sec.append(rows);
    }
    return sec;
  }

  /** A node opened or closed: its rows below are added or removed in place. */
  function drawNode(r: GroupKey, key: string): void {
    const a = ctl.areas.find(x => x.root === r);
    const sec = list.querySelector<HTMLElement>(`:scope > .tr-grp[data-root="${r}"]`);
    const rowNode = sec?.querySelector<HTMLElement>(`.tr-row[data-key="${key}"]`);
    if (!a || !sec || !rowNode) return;
    const tree = ctl.groupTree(a);
    const show = ctl.groupShow(a);
    const n = tree.byKey.get(key);
    if (!n) return;
    let next = rowNode.nextElementSibling as HTMLElement | null;
    while (next && Number(next.dataset.depth) > n.depth) {
      const after = next.nextElementSibling as HTMLElement | null;
      next.remove();
      next = after;
    }
    const open = !ctl.nodeClosed(r, n);
    if (open) {
      const ticked = ctl.subtreeTicked(a);
      const partly = partlyTicked();
      const words = wordsOf(ctl.filters.text);
      const frag = document.createDocumentFragment();
      for (const x of visibleNodes(tree, show, y => ctl.nodeClosed(r, y), n)) frag.append(nodeEl(a, x, show, ticked, partly, words));
      rowNode.after(frag);
    }
    const caret = rowNode.querySelector<HTMLElement>('.tr-caret');
    caret?.setAttribute('aria-expanded', String(open));
    caret?.querySelector('.ui-disc-chev')?.classList.toggle('closed', !open);
  }

  function drawNotes(r: GroupKey): void {
    const a = ctl.areas.find(x => x.root === r);
    const sec = list.querySelector<HTMLElement>(`:scope > .tr-grp[data-root="${r}"]`);
    if (!a || !sec) return;
    for (const old of sec.querySelectorAll(':scope > .tr-gnote')) old.remove();
    sec.querySelector(':scope > .tr-gh')?.after(...groupNotes(a, ctl.visibleRows(a).length));
  }

  /** Is a group worth showing: one with rows, or with something to say? An
   *  object that is not there is said in one sentence instead. */
  const groupShown = (a: AreaResult) => !!a.rows.length || (a.status !== 'done' && !(a.root === UNDER && a.status === 'missing')) || !!a.notFound?.length || !!a.invalid?.length;

  /** The sentence for a finished search that found nothing. */
  function emptyLine(): string | null {
    const finished = !ctl.scanning && !!ctl.outcome && ctl.areas.every(a => a.status === 'done' || a.status === 'missing');
    if (!finished || ctl.found() !== 0) return null;
    switch (ctl.scannedScope) {
      case 'under':
        if (ctl.areas[0]?.status === 'missing') return `No object ${ctl.startAddress} on this workspace.`;
        return ctl.scannedSince ? `Nothing under ${ctl.startAddress} changed since ${dayText(ctl.scannedSince)}.` : null;
      case 'search': return ctl.areas.some(a => a.root === UNDER && a.rows.length) ? null : `No objects match “${ctl.searchedText}”.`;
      case 'ids': return null;
      case 'page': return 'No objects found on this page.';
      default: return ctl.scannedSince ? `Nothing changed since ${dayText(ctl.scannedSince)} in the chosen areas.` : null;
    }
  }

  // The tree: the chosen areas as rows, each read when it opens.

  function browseNote(depth: number, node: BrowseNode | undefined, key: string): HTMLElement | null {
    if (!node || node.status === 'done') return null;
    const d = Math.min(depth, DEPTH_CAP);
    if (node.status === 'reading') return el('div', `tr-note${d ? ` tr-d${d}` : ''}`, 'Reading');
    const again = attrs(plainBtn('tr-link tr-retry', 'Try again'), { 'data-key': key });
    return el('div', `tr-note err${d ? ` tr-d${d}` : ''}`, el('span', '', node.error ?? 'The children could not be read.'), again);
  }

  function browseRows(rows: readonly TransportScanRow[], depth: number, partly: ReadonlySet<string>, out: DocumentFragment): void {
    for (const r of rows) {
      const node = ctl.browseNodes.get(r.rid);
      const open = ctl.browseOpen.has(r.rid);
      const known = ctl.countOf(r.rid);
      out.append(rowEl({
        row: r, id: r.id, name: r.name, depth, key: r.rid,
        ...(known === 0 ? {} : { caret: { open, key: r.rid } }), sub: rowSub(r, null, null), words: [], partly,
      }));
      if (!open) continue;
      const note = browseNote(depth + 1, node, r.rid);
      if (note) out.append(note);
      else if (node) browseRows(node.rows, depth + 1, partly, out);
    }
  }

  function browseArea(root: TransportRoot, partly: ReadonlySet<string>): HTMLElement {
    const key = areaKey(root);
    const open = ctl.browseOpen.has(key);
    const node = ctl.browseNodes.get(key);
    const known = ctl.countOf(key);
    const taken = ctl.areaTakenAll(root);
    const sub: SubCtl | null = known === 0 ? null : { spec: { mode: 'area', ...(known != null ? { count: known } : {}) }, pressed: taken, attrs: { 'data-root': root } };
    const head = headEl(root, AREA_LABELS[root], open, known != null ? count(known) : null, sub, { 'data-key': key });
    const sec = attrs(el('section', 'tr-grp browse', head), { 'data-root': root, 'data-key': key, 'aria-label': AREA_LABELS[root] });
    if (open) {
      const note = browseNote(0, node, key);
      const body = el('div', 'tr-rows');
      if (note) { note.classList.add('band'); body.append(note); }
      else if (node) { const frag = document.createDocumentFragment(); browseRows(node.rows, 0, partly, frag); body.append(frag); }
      sec.append(body);
    }
    return sec;
  }

  function drawList(): void {
    const frag = document.createDocumentFragment();
    const partly = partlyTicked();
    if (ctl.findMode === 'browse') {
      for (const root of orderedAreas(ctl.chosen)) frag.append(browseArea(root, partly));
    } else {
      const empty = emptyLine();
      if (empty) {
        const p = el('p', 'tr-empty', empty);
        if (ctl.onPage || ctl.changedDay) p.append(' ', btn('tr-link tr-clearfilters', undefined, () => { ctl.setOnPage(false); ctl.clearChanged(); }, 'Clear filters'));
        frag.append(p);
      }
      for (const a of ctl.areas.filter(groupShown)) frag.append(groupEl(a, partly));
    }
    list.replaceChildren(frag);
  }

  /** The whole list again, as it was scrolled and focused: a tick changes
   *  the boxes and buttons around it, and nothing moves. */
  function redrawList(): void {
    const active = document.activeElement as HTMLElement | null;
    const inList = !!active && list.contains(active);
    const rid = inList ? active!.closest<HTMLElement>('[data-rid]')?.dataset.rid : undefined;
    const kind = inList ? (['tr-ck', 'tr-caret', 'tr-sub'].find(c => active!.classList.contains(c)) ?? '') : '';
    const top = findMain.scrollTop;
    drawList();
    findMain.scrollTop = top;
    if (rid && kind) list.querySelector<HTMLElement>(`.tr-row[data-rid="${rid}"] .${kind}`)?.focus();
  }

  function drawGroup(r: GroupKey): void {
    const a = ctl.areas.find(x => x.root === r);
    const old = list.querySelector<HTMLElement>(`:scope > .tr-grp[data-root="${r}"]`);
    if (!a || !groupShown(a)) { old?.remove(); return; }
    const next = groupEl(a, partlyTicked());
    if (old) { old.replaceWith(next); return; }
    const order = ctl.areas.map(x => x.root);
    const after = [...list.querySelectorAll<HTMLElement>(':scope > .tr-grp')].find(g => order.indexOf(g.dataset.root as GroupKey) > order.indexOf(r));
    list.insertBefore(next, after ?? null);
    list.querySelector(':scope > .tr-empty')?.remove();
  }

  function drawCounts(): void {
    const l = ctl.lines();
    footCount.textContent = linesText(l);
    openBtn.disabled = l.objects + l.folders === 0;
    tabCount.textContent = l.objects + l.folders ? ` ${count(l.objects + l.folders)}` : '';
  }

  // ── transport: header ───────────────────────────────────────────

  function drawHeader(): void {
    const targets = ctl.targets ?? [];
    const want: Array<{ v: string; l: string; disabled?: boolean }> = [
      ...(targets.length ? targets.map(t => ({ v: choiceOf(t.environment), l: t.host ? `${t.label} · ${t.host}` : t.label })) : [{ v: '', l: NO_TARGETS, disabled: true }]),
      { v: CHOICE_PASTE, l: PASTE_TARGET },
      { v: CHOICE_ANY, l: ANY_TARGET },
    ];
    const same = targetSel.options.length === want.length && want.every((w, i) => targetSel.options[i].value === w.v && targetSel.options[i].text === w.l);
    if (!same) {
      targetSel.replaceChildren(...want.map(w => {
        const o = attrs(el('option', '', w.l) as HTMLOptionElement, { value: w.v });
        o.disabled = !!w.disabled;
        return o;
      }));
    }
    targetSel.value = ctl.choice;
    targetSel.disabled = ctl.locked;
    const d = ctl.direct;
    const t = ctl.chosenTarget;
    actBtn.textContent = t ? (d && ctl.bundle?.status === 'done' && !ctl.stale && !ctl.showingUndo ? 'Compare again' : 'Compare') : 'Build scripts';
    actBtn.disabled = ctl.busy || ctl.locked || !ctl.transportItems().length;
    applyBtn.hidden = !t;
    applyBtn.textContent = ctl.showingUndo ? `Undo on ${t?.label ?? ''}` : `Apply to ${t?.label ?? ''}`;
    applyBtn.disabled = !ctl.canApply();
    applyBtn.classList.toggle('primary', ctl.canApply());
    actBtn.classList.toggle('primary', !ctl.canApply());
    drawBusy();
    drawLastApply();
  }

  function drawLastApply(): void {
    lastLine.replaceChildren();
    const r = ctl.lastApply;
    const t = ctl.chosenTarget;
    if (!r || !t || r.target !== t.environment) { lastLine.hidden = true; return; }
    lastLine.hidden = false;
    const undo = btn('tr-undo ui-btn', undefined, () => ctl.startUndo(), 'Undo');
    undo.disabled = ctl.busy || ctl.locked;
    const remove = btn('tr-link tr-undo-remove', undefined, () => { void ctl.removeUndo(); }, 'Remove');
    remove.disabled = ctl.busy;
    lastLine.append(el('span', 'tr-lastapply-t', lastApplyLine(r)), undo, remove);
  }

  /** The local busy line next to the action: reading, comparing, its Stop. */
  function drawBusy(): void {
    busyLine.replaceChildren();
    busyLine.className = 'tr-busy';
    const b = ctl.bundle;
    const link = (label: string, fn: () => void) => btn('tr-link', undefined, fn, label);
    if (ctl.refs) {
      const round = ctl.missing ? `Adding what is missing, round ${ctl.missing.round} of ${ctl.missing.of} · ` : '';
      busyLine.append(el('span', '', `${round}Looking up ${count(ctl.refs.done)} of ${count(ctl.refs.addresses.length)}`),...(ctl.refs.status === 'reading' ? [link('Stop', () => ctl.stopRefs())] : []));
      return;
    }
    if (b?.error && b.status === 'failed') {
      errorLine(busyLine, b.error, link('Try again', () => { void ctl.continueReading(); }));
      return;
    }
    const creation = b?.target?.creation;
    if (creation?.status === 'failed') { errorLine(busyLine, creation.error ?? 'The links of the property definitions could not be read.', link('Try again', () => { void ctl.continueCreation(); })); return; }
    if (b?.status === 'reading') { busyLine.append(el('span', '', `Reading ${count(b.reads.size)} of ${count(b.rids.length)}`), link('Stop', () => ctl.stopReading())); return; }
    if (b?.status === 'stopped') { busyLine.append(el('span', '', `Stopped · ${count(b.reads.size)} of ${count(b.rids.length)} read`), link('Continue', () => { void ctl.continueReading(); })); return; }
    if (creation?.status === 'reading' && b?.target) { busyLine.append(el('span', '', `Reading the links of ${plural(creation.rids.length, 'property definition')}`), link('Stop', () => ctl.stopCreation())); return; }
    if (creation?.status === 'stopped' && b?.target) { busyLine.append(el('span', '', `Stopped · links of ${count(ctl.creationDone(b.target))} of ${count(creation.rids.length)} property definitions read`), link('Continue', () => { void ctl.continueCreation(); })); return; }
    const ph = ctl.direct?.phase;
    const d = ctl.direct;
    if (d && ph && (ph.kind === 'comparing' || ph.kind === 'verifying')) {
      const what = ph.kind === 'comparing' ? `Comparing with ${d.target.label}` : 'Comparing again';
      const stop = btn('tr-link tr-compare-stop', undefined, () => ctl.stopCompare(), d.stopping ? 'Stopping' : 'Stop');
      stop.disabled = d.stopping;
      busyLine.append(el('span', 'tr-progress-t', `${what} · part ${ph.part} of ${ph.total}`), stop);
      return;
    }
    if (ctl.notice) busyLine.append(el('span', '', ctl.notice));
  }

  // ── transport: state (confirmation, apply, outcome) ─────────────

  let tick: ReturnType<typeof setInterval> | null = null;
  const stopTick = () => { if (tick) { clearInterval(tick); tick = null; } };

  function drawDirect(): void {
    stopTick();
    const t = ctl.bundle?.target;
    const d = t?.direct;
    stateBox.replaceChildren();
    if (!t || !d) { stateBox.className = 'tr-direct-state'; return; }
    stateBox.append(...directState(t, d));
    const ph = d.phase;
    stateBox.className = `tr-direct-state ${ph.kind}`;
    stateBox.setAttribute('role', ph.kind === 'failed' ? 'alert' : 'status');
    if (ph.kind === 'applying') {
      const time = stateBox.querySelector<HTMLElement>('.tr-progress-time');
      tick = setInterval(() => { if (time) time.textContent = elapsedText(now().getTime() - ph.startedAt); }, 1000);
    }
  }

  function directState(t: TargetState, d: DirectState): HTMLElement[] {
    const ph = d.phase;
    const line = (cls: string, text: string) => el('p', cls, text);
    switch (ph.kind) {
      case 'idle': case 'reviewed': case 'comparing': case 'verifying': return [];
      case 'confirming': {
        const p = t.patch!;
        const size = applySize(p);
        const counts = [applyCounts(p.counts), ...(p.unlinks.length ? [unlinkCount(p.unlinks.length)] : [])].filter(Boolean).join(', ') + (t.record ? ', 1 log entry to add' : '');
        const undo = t.undoOf;
        const yes = btn('tr-confirm-apply ui-btn primary', undefined, () => { void ctl.apply(); }, undo ? 'Undo' : 'Apply');
        const no = btn('tr-confirm-cancel ui-btn', undefined, () => ctl.cancelApply(), 'Cancel');
        const host = d.target.host ? ` (${d.target.host})` : '';
        const draft = !undo && ctl.draftUnread ? draftAgeLine(ctl.transportItems()) : '';
        return [attrs(el('div', 'tr-confirm',
          el('p', 'tr-confirm-h', undo ? `Undo the apply of ${applyTime(undo.at)} on ${d.target.label}${host}?` : `Apply to ${d.target.label}${host}?`),
          draft ? line('tr-confirm-draft', draft) : null,
          line('tr-confirm-counts', counts),
          p.counts.delete ? (undo ? line('tr-confirm-undel', undoDeleteSentence(p.counts.delete)) : line('tr-confirm-del', CONFIRM_DELETE)) : null,
          p.unlinks.length ? line('tr-confirm-unlink', unlinkSentence(p.unlinks.length)) : null,
          p.uploads.length ? line('tr-confirm-upload', uploadSentence(p.uploads.length, d.target.label)) : null,
          !undo && ctl.schedules() ? line('tr-confirm-schedules', scheduleSentence(ctl.schedules(), d.target.label)) : null,
          el('p', 'tr-confirm-size', `${plural(size.parts, 'part')}, ${count(size.chars)} characters.`,
            size.chars > TRANSPORT_APPLY_WARN_CHARS ? el('span', 'tr-confirm-mem', ` ${MEMORY_WARNING}`) : null),
          el('div', 'tr-confirm-f', yes, no),
        ), { role: 'group', 'aria-label': undo ? 'Confirm the undo' : 'Confirm the apply' })];
      }
      case 'applying': {
        const step = STEP_TITLES[ph.step];
        const stop = btn('tr-link tr-apply-stop', 'The part that runs is finished first', () => ctl.stopApply(), d.stopping ? 'Stopping after this part' : 'Stop');
        stop.disabled = d.stopping;
        return [el('p', 'tr-progress',
          el('span', 'tr-progress-t', `${step}, part ${ph.part} of ${ph.total}`),
          el('span', 'tr-progress-time', elapsedText(now().getTime() - ph.startedAt)),
          stop)];
      }
      case 'trying': {
        const stop = btn('tr-link tr-apply-stop', undefined, () => ctl.stopApply(), d.stopping ? 'Stopping' : 'Stop');
        stop.disabled = d.stopping;
        return [el('p', 'tr-progress', el('span', 'tr-progress-t', `Trying the scripts on ${d.target.label} · part ${ph.part} of ${ph.total}`), stop)];
      }
      case 'done': {
        if (ph.undone) {
          return [line('tr-outcome', ph.kept ? `Undone, apart from ${plural(ph.kept, 'object')} that ${ph.kept === 1 ? 'was' : 'were'} kept.` : `Undone. ${d.target.label} is as it was before the apply.`)];
        }
        const up = d.uploads ?? [];
        return [
          line('tr-outcome', ph.remaining ? `Applied. ${plural(ph.remaining, 'difference')} ${ph.remaining === 1 ? 'remains' : 'remain'}.`
            : t.patch?.counts.targetOnly ? `Applied. ${d.target.label} matches, apart from ${plural(t.patch.counts.targetOnly, 'object')} only on ${d.target.label}.` : `Applied. ${d.target.label} matches.`),
          ...(up.length ? [el('div', 'tr-outcome-uploads', el('p', '', `Upload ${up.length === 1 ? 'this file' : 'these files'} on ${d.target.label}:`), el('ul', 'tr-uploadlist', ...up.map(u => el('li', '', uploadText(u)))))] : []),
        ];
      }
      case 'stopped':
        return [line('tr-stopped', ph.stage === 'compare' ? 'Stopped.'
          : `Stopped after part ${ph.after} of ${ph.total}. ${ph.applied ? `${plural(ph.applied, 'part')} applied.` : 'Nothing was changed.'} Compare again to see what ${d.target.label} holds.`)];
      case 'failed': {
        const kids: Array<HTMLElement | null> = [];
        if (ph.stage === 'apply') {
          kids.push(line('tr-failure-h', `${ph.step ? STEP_TITLES[ph.step] : 'A part'} failed: part ${ph.part} of ${ph.total}.`));
          kids.push(el('pre', 'tr-failure-msg', ph.error));
          kids.push(line('tr-failure-t', ph.unknown
            ? 'Outcome unknown: the server did not answer, so this part may have been applied.'
            : 'This part stored nothing.'));
          kids.push(line('tr-failure-t', ph.applied ? `The ${plural(ph.applied, 'part')} before it ${ph.applied === 1 ? 'is' : 'are'} applied.` : 'Nothing before it was changed.'));
        } else if (ph.stage === 'check') {
          kids.push(line('tr-failure-h', ph.lines ? ph.error : 'The check failed. Nothing was changed.'));
          kids.push(el('pre', 'tr-failure-msg', ph.lines ? ph.lines.join('\n') : ph.error));
        } else if (ph.stage === 'dryrun') {
          kids.push(line('tr-failure-h', ph.error));
          kids.push(el('pre', 'tr-failure-msg tr-dryrun-lines', (ph.lines ?? []).join('\n')));
          // The objects it names: removed from the transport here.
          if (ph.objects?.length) {
            kids.push(line('tr-failure-t tr-dryrun-help', DRY_RUN_HELP));
            kids.push(el('ul', 'tr-dryrun-objects', ...ph.objects.map(a => {
              const rm = attrs(btn('tr-link tr-dryrun-rm', undefined, () => ctl.removeAddress(a), 'Remove from transport'), { 'data-address': a });
              rm.disabled = ctl.busy || ctl.locked || !ctl.addressInTransport(a);
              return el('li', '', el('span', 'tr-dryrun-a', a), rm);
            })));
          }
        } else {
          kids.push(line('tr-failure-h', ph.stage === 'verify' ? 'Applied, but the comparison afterwards failed.' : 'The comparison failed.'));
          kids.push(el('pre', 'tr-failure-msg', ph.error));
        }
        kids.push(line('tr-failure-t', `Compare again to see what ${d.target.label} holds.`));
        return [el('div', 'tr-failure', ...kids)];
      }
    }
  }

  // ── transport: summary and what is needed ───────────────────────

  /** The one action for every need that can be added. */
  const ADD_MISSING = 'Add what is missing and compare again';
  const ADD_MISSING_TITLE = 'Adds the used objects, the parents and the flow steps that are missing to the transport, then compares again.';

  /** The target's name in a sentence. */
  const targetName = () => ctl.bundle?.direct?.label ?? 'the target';
  /** The target's name at the start of a sentence. */
  const TargetName = () => { const n = targetName(); return n.charAt(0).toUpperCase() + n.slice(1); };

  function drawSummary(): void {
    sumBox.replaceChildren();
    const b = ctl.bundle;
    if (!b || b.status !== 'done') return;
    const p = b.target?.patch;
    const res = b.result;
    if (ctl.stale) sumBox.append(el('p', 'tr-stale', res ? 'The transport changed since the scripts were built.' : 'The transport changed since the comparison.'));
    let sum: HTMLElement | null = null;
    // After an apply the outcome line says it; the summary does not repeat it.
    const outcome = b.target?.direct?.phase.kind === 'done';
    if (p) {
      const line = p.nothingToDo ? matchLine(p) : [summaryLine(p.counts), ...(p.unlinks.length ? [unlinkCount(p.unlinks.length)] : [])].join(' · ');
      if (!(outcome && p.nothingToDo)) sum = attrs(el('p', 'tr-sum', line), { 'data-summary': '' });
    }
    else if (res) {
      const left = res.leftOut.length ? ` · ${count(res.leftOut.length)} left out` : '';
      sum = attrs(el('p', 'tr-sum', `${plural(res.objects.length, 'object')} in ${plural(res.parts.length, 'script')}${left}`), { 'data-summary': '' });
    }
    if (!p && !res) return;
    const undoOf = b.target?.undoOf;
    if (undoOf) {
      const back = btn('tr-link tr-undo-back', undefined, () => ctl.backToTransport(), 'Back to the transport');
      back.disabled = ctl.busy || ctl.locked;
      sumBox.append(el('div', 'tr-undo-hl', el('p', 'tr-undo-h', `Undo of the apply of ${applyTime(undoOf.at)}`), back));
    }
    // Without a connected target the scripts are the result: copy them from here.
    const text = res?.text ?? p?.text ?? '';
    const parts = res?.parts.length ?? p?.parts.length ?? 0;
    if (sum) sumBox.append(el('div', 'tr-sumline', sum, !b.target?.direct && parts ? copyActions(text, fileName(res ? undefined : 'patch')) : null));
    const where = p ? `on ${targetName()}` : 'in this transport';
    const addBtn = (which: NeedKind) => {
      if (!ctl.referencedAddresses(which).length) return null;
      const add = attrs(btn(`tr-addref ui-btn`, undefined, () => { void ctl.addReferenced(which); }, 'Add them'), { 'data-need': which });
      add.disabled = ctl.busy || ctl.locked;
      return add;
    };
    const lines: HTMLElement[] = [];
    const t = b.target;
    // Danger: deletes and removed class links.
    const plan = t?.undoPlan;
    if (plan && (plan.cannot.length || plan.kept.length)) {
      lines.push(needLine('cannot-undo', plan.cannot.length ? 'danger' : 'needs', `${plural(plan.cannot.length + plan.kept.length, 'object')}: cannot be undone`, {
        cls: 'tr-cannot', body: [el('ul', 'tr-cannotlist', ...plan.cannot.map(c => el('li', '', c.reason)), ...plan.kept.map(k => el('li', '', `${k.address} ${k.reason}`)))],
      }));
    }
    if (p && (p.counts.targetOnly || p.linksOnlyOnTarget)) lines.push(targetOnlyBlock(p));
    // Needs you: what is left out or fails unless the person acts.
    const needed = ctl.neededAddresses().size;
    if (needed) lines.push(needLine('uses', 'needs', `Uses ${plural(needed, 'object')} that ${needed === 1 ? 'is' : 'are'} not ${where}`, { action: addBtn('uses') }));
    const parents = ctl.neededParents();
    if (parents.objects) {
      const n = parents.objects;
      const lead = n === 1 ? '1 object is' : `${count(n)} objects are`;
      lines.push(needLine('parents', 'needs', p ? `${lead} under a parent that ${targetName()} does not have` : `${lead} under a parent that is not in this transport`, { action: addBtn('parents') }));
    }
    const steps = ctl.neededSteps().size;
    if (steps) lines.push(needLine('steps', 'needs', `${steps === 1 ? '1 step of a flow project is' : `${count(steps)} steps of flow projects are`} not in this transport`, { action: addBtn('steps') }));
    if (p?.typesOff.length) {
      const n = p.typesOff.length;
      const classes = [...new Set(p.typesOff.map(x => x.className))].sort();
      lines.push(needLine('types-off', 'needs', `${n === 1 ? '1 object has a type' : `${count(n)} objects have a type`} that is switched off on ${targetName()}`, {
        cls: 'tr-typesoff', body: [el('ul', 'tr-typesofflist', ...classes.map(c => el('li', '', c)))],
      }));
    }
    if (p && t?.unreadHere) {
      lines.push(needLine('unread', 'needs', `${t.unreadHere === 1 ? '1 object' : `${count(t.unreadHere)} objects`} could not be read here, so nothing is deleted on ${targetName()}.`));
    }
    // To know.
    const unchecked = p ? ctl.uncheckedUses() : [];
    if (unchecked.length) {
      lines.push(needLine('unchecked', 'know', `${plural(unchecked.length, 'used object')} could not be checked on ${targetName()}`, {
        cls: 'tr-unchecked', body: [el('ul', 'tr-uncheckedlist', ...unchecked.map(a => el('li', '', a)))],
      }));
    }
    const schedules = ctl.schedules();
    if (schedules) lines.push(needLine('schedules', 'know', scheduleSentence(schedules, p ? targetName() : 'the target')));
    const uploads = ctl.uploads();
    if (uploads.length) {
      lines.push(needLine('uploads', 'know', uploadSentence(uploads.length, p ? targetName() : 'the target'), {
        cls: 'tr-uploads', body: [el('ul', 'tr-uploadlist', ...uploads.map(u => attrs(el('li', '', [u.address, u.name, ...(u.size != null ? [sizeKb(u.size)] : [])].join(' · ')), { 'data-rid': u.rid })))],
      }));
    }
    const templates = ctl.templates();
    if (templates.length) lines.push(templateBlock(templates, !!res));
    if (p && !t?.unreadHere && t?.listing && t.sourceError) {
      lines.push(needLine('source-listing', 'know', `What this workspace has under ${t.listing.start} could not be read, so no object counts as only on ${targetName()} and nothing is deleted: ${t.sourceError}`));
    }
    if (p?.listing?.state === 'missing') lines.push(needLine('listing-missing', 'know', `${TargetName()} has no ${p.listing.start}.`));
    // One action for all of the needs that can be looked up here, with a connected target.
    if (b.target?.direct && NEED_KINDS.some(k => ctl.referencedAddresses(k).length)) {
      const all = attrs(btn('tr-addmissing ui-btn primary', undefined, () => { void ctl.addMissing(); }, ADD_MISSING), { title: ADD_MISSING_TITLE });
      all.disabled = ctl.busy || ctl.locked || !!ctl.missing;
      sumBox.append(all);
    }
    appendNeeds(lines);
  }

  /** Lines under the summary in one form: danger, then needs you, then to
   *  know (each in the order made); after NEEDS_SHOWN, "n more". */
  function appendNeeds(lines: HTMLElement[]): void {
    if (lines.length) sumBox.append(needsBlock(lines, needs));
  }

  /** What a comparison with nothing to do says. */
  const matchLine = (p: TransportPatch) => {
    // Objects left out for a missing parent are not compared: "already matches" would be wrong.
    const out = ctl.neededParents().objects;
    if (out) return `Nothing to apply yet: ${out === 1 ? '1 object is' : `${count(out)} objects are`} left out.`;
    return matchText(p);
  };
  const matchText = (p: TransportPatch) => (p.review.some(r => r.values.some(v => v.action === 'keep' && v.name.toLowerCase() !== 'id'))
    ? `Nothing to change: ${targetName()} only has values of its own, and they are kept.`
    : `${TargetName()} already matches.`);

  /** "n more" under the summary is open (kept across redraws). */
  const needs = { open: false };

  /**
   * One line under the summary: a state dot, the sentence, at most one action
   * on the right (a button, or the chevron of a list that folds out).
   * Levels: danger (deletes and removed class links), needs (left out or
   * fails unless the person acts), know (to know).
   */
  function needLine(kind: string, level: NeedLevel, text: string, opts: { cls?: string; action?: HTMLElement | null; body?: Array<Node | null> } = {}): HTMLElement {
    const cls = `tr-need lvl-${level}${opts.cls ? ` ${opts.cls}` : ''}`;
    const dot = attrs(el('span', 'tr-need-dot'), { 'aria-hidden': 'true' });
    const a = { 'data-need': kind, 'data-level': level };
    if (opts.body) {
      return attrs(el('details', cls,
        el('summary', 'tr-need-row', dot, el('span', 'tr-need-t', text), icon('i-chev', 'ui-disc-chev tr-need-chev')),
        el('div', 'tr-need-b', ...opts.body)), a);
    }
    return attrs(el('div', cls, el('div', 'tr-need-row', dot, el('span', 'tr-need-t', text), opts.action ?? null)), a);
  }

  /** "n objects only on <target>": the list, and the switch to delete them. */
  function targetOnlyBlock(p: TransportPatch): HTMLElement {
    const t = ctl.bundle!.target!;
    const deleting = p.deletes.length > 0;
    const sw = attrs(btn('tr-delx ui-sw', `Delete objects only ${targetName()} has`, () => ctl.setDeleteExtra(!t.deleteExtra)), { role: 'switch', 'aria-checked': String(t.deleteExtra) });
    sw.disabled = ctl.busy || ctl.direct?.phase.kind === 'confirming';
    const rows = p.targetOnly.slice(0, TARGET_ONLY_SHOWN).map((o: TargetOnlyObject) => {
      const d = Math.min(o.depth, DEPTH_CAP);
      const fate = !deleting ? null : o.fate === 'keep' ? attrs(el('span', 'tr-ro-p', `stays: ${o.reason ?? ''}`), { title: o.reason ?? '' }) : el('span', 'tr-ro-p', o.fate === 'delete' ? 'to delete' : 'deleted with the object above');
      return attrs(el('div', `tr-ro tr-only${d ? ` tr-d${d}` : ''}${deleting ? ` ${o.fate}` : ''}`,
        ...objectCells(o.address || o.id, o.name, o.className),
        o.under ? el('span', 'tr-ro-u', `${count(o.under)} under it`) : null,
        fate,
      ), { 'data-depth': String(o.depth) });
    });
    const more = p.targetOnly.length - TARGET_ONLY_SHOWN;
    const what = [p.counts.targetOnly ? plural(p.counts.targetOnly, 'object') : '', p.linksOnlyOnTarget ? plural(p.linksOnlyOnTarget, 'class link') : ''].filter(Boolean).join(' and ');
    // Danger while it deletes or removes class links; else to know.
    return needLine('target-only', deleting || p.unlinks.length ? 'danger' : 'know', `${what} only on ${targetName()}`, {
      cls: 'tr-onlyblk',
      body: [
        el('label', 'tr-fl tr-fl-sw', sw, el('span', 'tr-fl-t', `Delete objects only ${targetName()} has`)),
        ...rows,
        ...(more > 0 ? [el('p', 'tr-limits', `… and ${plural(more, 'more object')}`)] : []),
      ],
    });
  }

  /** "n objects are templates: a change reaches every linked copy". */
  function templateBlock(templates: CollectionItem[], scripts: boolean): HTMLElement {
    const n = templates.length;
    const text = `${n === 1 ? '1 object is a template' : `${count(n)} objects are templates`}: a change reaches every linked copy`;
    return needLine('templates', 'know', text, {
      cls: 'tr-tplblk',
      ...(scripts ? { body: [el('p', 'tr-warnline', 'These scripts change every value of a template on the target, and each value written walks every linked copy. Compare with the target instead where you can.')] } : {}),
    });
  }

  // ── transport: comparison script, scripts, options ──────────────

  function partCard(p: AnyPart): HTMLElement {
    const label = el('span', '', 'Copy');
    const copyBtn = btn('tr-copy ui-tbtn', `Copy part ${p.index}`, () => {
      void copyWithFeedback(p.text, copyBtn, { textTarget: label, ...(write ? { write } : {}) });
    }, icon('i-copy'), label);
    const lines = p.text.split('\n').length - (p.text.endsWith('\n') ? 1 : 0);
    const code = attrs(el('pre', 'tr-code', el('code', '', p.text)), { tabindex: '0', 'aria-label': `Part ${p.index} text` });
    const card = attrs(el('section', 'tr-card', el('div', 'tr-card-h', el('span', 'tr-card-t', partTitle(p)), copyBtn), code), { 'data-part': String(p.index), 'data-step': p.step });
    if (lines > PART_LINES_SHOWN) {
      code.classList.add('clip');
      const more = btn('tr-link tr-showall', undefined, () => {
        const clipped = code.classList.toggle('clip');
        more.textContent = clipped ? 'Show all' : 'Show less';
      }, 'Show all');
      card.append(el('div', 'tr-card-f', more));
    }
    return card;
  }

  /** "Copy all" and "Download" of a whole text. */
  function copyActions(text: string, file: string): HTMLElement {
    const allLabel = el('span', '', 'Copy all');
    const copyAll = btn('tr-copyall ui-btn', undefined, () => {
      void copyWithFeedback(text, copyAll, { textTarget: allLabel, ...(write ? { write } : {}) });
    }, icon('i-copy'), allLabel);
    const save = btn('tr-download ui-btn', undefined, () => download(file, text), 'Download');
    return el('div', 'tr-actions', copyAll, save);
  }

  /** The whole text's actions (unless `withActions` is false), then one card per part. */
  function partsOf(parts: readonly AnyPart[], text: string, file: string, withActions = true): HTMLElement[] {
    if (!parts.length) return [];
    const cards = el('div', 'tr-cards');
    for (const p of parts) cards.append(partCard(p));
    return withActions ? [copyActions(text, file), cards] : [cards];
  }

  const fileName = (kind?: 'probe' | 'patch') => {
    const d = now();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return downloadName(ctl.connection?.label ?? '', day, kind);
  };

  /** Warnings other than the needed objects and templates (said above). */
  function warningsBlock(warnings: readonly BundleWarning[]): HTMLElement | null {
    const rest = warnings.filter(w => w.kind !== 'outside-reference' && w.kind !== 'outside-parent' && w.kind !== 'template');
    if (!rest.length) return null;
    return el('details', 'tr-block warn', el('summary', '', `Warnings (${count(rest.length)})`), el('ul', 'tr-items', ...rest.map(w => el('li', '', w.detail))));
  }

  /** The paste flow: the comparison script open until an answer is read. */
  let pasteNodes: { t: TargetState; details: HTMLDetailsElement; area: HTMLTextAreaElement; readBtn: HTMLButtonElement; err: HTMLElement } | null = null;

  function drawPaste(): void {
    const t = ctl.bundle?.status === 'done' ? ctl.bundle.target : undefined;
    if (!t || t.direct) { pasteBox.replaceChildren(); pasteNodes = null; return; }
    if (pasteNodes?.t === t) { syncPaste(); return; }
    const probe = t.probe;
    if (!probe.parts.length) { pasteBox.replaceChildren(); pasteNodes = null; return; }
    const details = el('details', 'tr-step', el('summary', 'tr-step-h', `Comparison script · ${plural(probe.parts.length, 'part')}`)) as HTMLDetailsElement;
    details.open = !t.patch;
    details.append(el('p', 'tr-lead', PROBE_LEAD), ...[warningsBlock(probe.warnings)].filter((x): x is HTMLElement => !!x), ...partsOf(probe.parts, probe.text, fileName('probe')));
    const area = attrs(el('textarea', 'tr-answer ui-input') as HTMLTextAreaElement, { rows: '4', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Answer' });
    area.value = t.answerText;
    const readBtn = btn('tr-readans ui-btn primary', undefined, () => { void ctl.readAnswer(area.value); }, 'Read answer');
    area.addEventListener('input', () => { readBtn.disabled = !area.value.trim() || ctl.busy; });
    const err = attrs(el('div', 'tr-answer-err'), { role: 'alert' });
    const answer = el('div', 'tr-ans', el('label', 'tr-ans-l', el('span', 'tr-fl-t', 'Answer'), area), el('div', 'tr-ans-f', readBtn, err));
    pasteBox.replaceChildren(details, answer);
    pasteNodes = { t, details, area, readBtn, err };
    syncPaste();
  }

  let hadPatch = false;
  function syncPaste(): void {
    const n = pasteNodes;
    if (!n) return;
    n.err.textContent = n.t.answerError?.error ?? '';
    n.readBtn.disabled = !n.area.value.trim() || ctl.busy;
    if (!!n.t.patch !== hadPatch) { n.details.open = !n.t.patch; hadPatch = !!n.t.patch; }
  }

  /** The build whose scripts block the person opened. */
  let scriptsOpenFor: object | null = null;
  function drawScripts(): void {
    scriptsBox.replaceChildren();
    const b = ctl.bundle;
    if (!b || b.status !== 'done') return;
    const res = b.result;
    const p = b.target?.patch;
    const parts: readonly AnyPart[] = res?.parts ?? p?.parts ?? [];
    if (!parts.length) {
      // Nothing can be compared: the objects say why (left out).
      return;
    }
    const d = el('details', 'tr-scripts', el('summary', '', `Scripts · ${plural(parts.length, 'part')}`)) as HTMLDetailsElement;
    d.open = scriptsOpenFor === b;
    d.addEventListener('toggle', () => { scriptsOpenFor = d.open ? b : null; });
    const w = warningsBlock(res?.warnings ?? p?.warnings ?? []);
    if (w) d.append(w);
    // Copy all and Download sit on the summary line, except with a connected target.
    d.append(...partsOf(parts, res?.text ?? p!.text, fileName(res ? undefined : 'patch'), !!b.target?.direct));
    scriptsBox.append(d);
  }

  function drawOptions(): void {
    optsBox.replaceChildren();
    if (!ctl.collection.size) return;
    const t = ctl.bundle?.status === 'done' ? ctl.bundle.target : undefined;
    const p = t?.patch;
    // Files: off by default; on, how much of a file's content travels.
    const sw = attrs(btn('tr-filesw ui-sw', 'Carry the content of files', () => ctl.setFileContent(!ctl.fileContent)), { role: 'switch', 'aria-checked': String(ctl.fileContent) });
    sw.disabled = ctl.busy || ctl.locked;
    const limit = attrs(el('input', 'tr-filelimit ui-input') as HTMLInputElement, {
      type: 'number', min: String(FILE_LIMIT_KB_MIN), max: String(FILE_LIMIT_KB_MAX), step: '1', 'aria-label': 'Carry the content of files up to, in KB',
    });
    limit.value = String(ctl.fileLimitKb);
    limit.disabled = ctl.busy || ctl.locked;
    limit.addEventListener('change', () => ctl.setFileLimit(Number(limit.value)));
    const files = el('div', 'tr-filesopt',
      el('div', 'tr-opt-row',
        el('label', 'tr-fl tr-fl-sw', sw, el('span', 'tr-fl-t', 'Carry the content of files')),
        ctl.fileContent ? el('label', 'tr-fl tr-filelimit-l', el('span', 'tr-fl-t', 'up to'), limit, el('span', 'tr-fl-t', 'KB')) : null),
      el('p', 'tr-help', FILES_OFF_HELP),
      el('p', 'tr-help', FILES_ON_HELP));
    const d = el('details', 'tr-optblk', el('summary', '', 'Options'), el('div', 'tr-opts', files)) as HTMLDetailsElement;
    d.open = optsOpen;
    d.addEventListener('toggle', () => { optsOpen = d.open; });
    optsBox.append(d);
    if (!t || !p) return;
    const locked = ctl.busy || t.direct?.phase.kind === 'confirming';
    const clearSw = attrs(btn('tr-clearx ui-sw', 'Remove values only the target has', () => ctl.setClearExtra(!t.clearExtra)), { role: 'switch', 'aria-checked': String(t.clearExtra) });
    clearSw.disabled = locked;
    const recBox = attrs(el('input', 'tr-rec') as HTMLInputElement, { type: 'checkbox' });
    recBox.checked = t.record;
    recBox.disabled = locked;
    recBox.addEventListener('change', () => ctl.setRecord(recBox.checked));
    const recTitle = attrs(el('input', 'tr-rec-t ui-input') as HTMLInputElement, { type: 'text', placeholder: 'Title', 'aria-label': 'Entry title', spellcheck: 'false', autocomplete: 'off', maxlength: '200' });
    recTitle.value = t.recordTitle;
    recTitle.hidden = !t.record;
    recTitle.disabled = locked;
    recTitle.addEventListener('input', () => ctl.setRecordTitle(recTitle.value));
    d.querySelector('.tr-opts')!.append(
      el('label', 'tr-fl tr-fl-sw', clearSw, el('span', 'tr-fl-t', 'Remove values only the target has')),
      ...(p.nothingToDo ? [] : [el('div', 'tr-opt-row', el('label', 'tr-fl tr-fl-ck', recBox, el('span', 'tr-fl-t', 'Add an entry to the transport log on the target')), recTitle)]),
    );
  }
  let optsOpen = false;

  // ── transport: the list ─────────────────────────────────────────

  function objectCells(address: string, name: string | undefined, className: string): HTMLElement[] {
    return [
      attrs(el('span', 'tr-ro-a', address), { title: address }),
      attrs(el('span', 'tr-ro-n', name ?? ''), { title: name ?? '' }),
      attrs(el('span', 'tr-ro-c', className), { title: className }),
    ];
  }

  const clamp = (cls: string, text: string) => attrs(el('span', `tr-clamp ${cls}`, text), { title: text });

  function valueRow(v: PatchValue): HTMLElement {
    const text = el('span', 'tr-val-t');
    if (v.target != null) text.append(clamp('old', v.target));
    if (v.target != null && v.source != null) text.append(el('span', 'tr-val-to', '→'));
    if (v.source != null) text.append(clamp('new', v.source));
    return attrs(el('div', `tr-val ${v.action}`,
      attrs(el('span', 'tr-val-n', v.name), { title: v.name }),
      text,
      el('span', 'tr-val-a', PATCH_VALUE_ACTION_LABELS[v.action]),
    ), { 'data-name': v.name });
  }

  /** "upload needed" (a file added without its content) or "content not
   *  compared" (a file the target has, its content over the limit). */
  function fileTag(rid: string): 'upload needed' | 'content not compared' | null {
    const f = ctl.stale ? null : ctl.fileOf(rid);
    if (!f || f.carried) return null;
    const p = ctl.bundle?.target?.patch;
    if (!p) return ctl.bundle?.result ? 'upload needed' : null;
    const r = p.review.find(x => x.rid === rid);
    return r?.upload ? 'upload needed' : r?.contentNotCompared ? 'content not compared' : null;
  }

  const stateTag = (s: ItemStateInfo | undefined) => (s ? attrs(el('span', `tr-tag st-${s.state}`, STATE_LABELS[s.state]), { ...(s.title ? { title: s.title } : {}), 'data-state': s.state }) : null);

  function transportRow(i: CollectionItem, states: Map<string, ItemStateInfo>): HTMLElement[] {
    const r = i.row;
    const open = ctl.openRows.has(i.rid);
    const label = r.id || r.name || r.rid;
    const rm = attrs(plainBtn('tr-rm', icon('i-x', 'ic-sm')), { 'data-rid': i.rid, title: 'Remove from transport', 'aria-label': `Remove ${label} from transport` });
    rm.disabled = ctl.locked;
    const caret = attrs(plainBtn('tr-tcaret', icon('i-chev', `ui-disc-chev${open ? '' : ' closed'}`)), { 'data-rid': i.rid, 'aria-expanded': String(open), 'aria-label': `Details of ${label}` });
    const tags = el('span', 'tr-tags', stateTag(states.get(i.rid)));
    if (i.gone) tags.append(attrs(el('span', 'tr-tag gone', 'not found'), { title: 'Not on this workspace any more' }));
    const ft = fileTag(i.rid);
    if (ft) tags.append(attrs(el('span', `tr-tag file ${ft === 'upload needed' ? 'upload' : 'nocompare'}`, ft), { title: ft === 'upload needed' ? 'Added without content: upload it on the target afterwards.' : 'Its content is not carried and stays as the target has it.' }));
    if (r.linkedTo) tags.append(linkedTag(r.linkedTo));
    const row = attrs(el('div', `tr-trow${i.gone ? ' gone' : ''}`, rm, caret,
      attrs(el('span', 'tr-id', r.id), { title: r.id }),
      attrs(el('span', 'tr-nm', r.name), { title: r.name }),
      el('span', 'tr-cls', r.className),
      tags,
    ), { role: 'listitem', 'data-rid': i.rid });
    return open ? [row, detailEl(i, states.get(i.rid))] : [row];
  }

  /** What a row shows when it is opened. */
  function detailEl(i: CollectionItem, s: ItemStateInfo | undefined): HTMLElement {
    const box = attrs(el('div', 'tr-detail'), { 'data-rid': i.rid });
    const p = ctl.bundle?.status === 'done' && !ctl.stale ? ctl.bundle.target?.patch : undefined;
    const review: PatchReviewObject | undefined = p?.review.find(x => x.rid === i.rid);
    const section = (title: string, ...kids: Array<Node | null>) => el('div', 'tr-dsec', el('span', 'tr-dsec-h', title), el('div', 'tr-dsec-b', ...kids));
    if (s?.state === 'left' && s.title) box.append(section('Left out', el('span', '', s.title)));
    if (review && review.outcome === 'change') {
      const shown = review.values.filter(v => v.action !== 'same');
      if (shown.length) box.append(section('Changes', el('div', 'tr-vals', ...shown.map(valueRow))));
    }
    // A property definition: the classes it gets linked to, and those only the target links it to.
    if (review?.links?.add.length) box.append(section('Linked to classes', el('span', '', review.links.add.join(', '))));
    if (review?.links?.remove?.length) box.append(section('Unlinked from classes', el('span', '', review.links.remove.join(', '))));
    else if (review?.links?.targetOnly.length) box.append(section('Links', el('span', '', `Also linked on the target: ${review.links.targetOnly.join(', ')}`)));
    // A flow project: the links between its steps it gets, and those only the target has.
    const pairs = (list: readonly string[]) => list.map(x => x.replace('>', ' > ')).join(', ');
    if (review?.flowLinks?.unknown) box.append(section('Links between steps', el('span', 'tr-help', 'The links between steps on the target could not be read.')));
    else if (review?.flowLinks && (review.flowLinks.add.length || review.flowLinks.targetOnly.length)) {
      box.append(section('Links between steps',
        review.flowLinks.add.length ? el('div', '', pairs(review.flowLinks.add)) : null,
        review.flowLinks.targetOnly.length ? el('div', 'tr-help', `Links between steps removed: ${pairs(review.flowLinks.targetOnly)}`) : null));
    }
    // A property definition: its own values per class that change.
    for (const o of review?.own ?? []) {
      const shown = o.values.filter(v => v.action !== 'same');
      if (shown.length) box.append(section(`Own values on ${o.className}`, el('div', 'tr-vals', ...shown.map(valueRow))));
    }
    if (review?.place?.labels.length) box.append(section('Place', el('span', '', review.place.labels.join(' · '))));
    const hint: RenameHint | undefined = p?.renames.find(h => h.rid === i.rid);
    if (hint && p) {
      const ren = checkbox('tr-ren', `Change the ID from ${hint.from} to ${hint.to}`);
      ren.dataset.key = hint.key;
      ren.checked = hint.on;
      const parent = hint.after ? p.renames.find(x => x.key === hint.after) : undefined;
      ren.disabled = ctl.busy || (!!parent && !parent.on);
      box.append(section('ID', el('label', 'tr-fl tr-fl-ck', ren, el('span', '', `Change the ID from ${hint.from} to ${hint.to}`))));
    }
    if (i.row.linkedTo) box.append(section('Linked copy', el('span', '', `Linked to ${i.row.linkedTo}: only its own values are changed.`)));
    const f = ctl.fileOf(i.rid);
    if (f) {
      const why = f.part ? "over a script part's limit" : `over the ${f.limitKb} KB limit`;
      // Without file content a file is not measured: no size.
      const text = f.size == null ? (f.carried ? 'carried' : 'not carried') : f.carried ? `carried (${sizeKb(f.size)})` : `not carried (${sizeKb(f.size)}, ${why})`;
      box.append(section('Content', el('span', '', text)));
    }
    if (ctl.isTemplate(i)) {
      box.append(section('Template', el('span', '', 'A change reaches every linked copy.')));
    }
    // Uses: read with the objects' text.
    const uses = ctl.stale ? null : ctl.usesOf(i.rid);
    if (!uses) box.append(section('Uses', el('span', 'tr-help', ctl.mode === 'any' ? BUILD_TO_SEE : COMPARE_TO_SEE)));
    else if (!uses.length) box.append(section('Uses', el('span', 'tr-help', 'No other objects.')));
    else box.append(section('Uses', el('div', 'tr-chips', ...uses.map(u => chip(u.address, u.name, u.state, u.rid)))));
    box.append(section('Used by', usedByEl(i.rid)));
    return box;
  }

  function chip(address: string, name: string, state: UseState, rid?: string): HTMLElement {
    const title = [USE_STATE_TITLES[state], rid ? 'Show in list' : ''].filter(Boolean).join(' · ');
    const kids = [el('span', `tr-dot ${state}`), el('span', 'tr-chip-a', address), name ? el('span', 'tr-chip-n', name) : null];
    const c = rid ? plainBtn('tr-chip', ...kids) : el('span', 'tr-chip', ...kids);
    return attrs(c, { 'data-state': state, ...(rid ? { 'data-rid': rid } : {}), ...(title ? { title } : {}) });
  }

  /** "Used by": the objects of this transport whose text uses it (known
   *  from the build), then, on request, what `rref()` finds on this
   *  workspace, each object once. */
  function usedByEl(rid: string): HTMLElement {
    const st = ctl.usedBy.get(rid);
    const go = (label: string) => {
      const b = attrs(plainBtn('tr-usedby-go ui-btn', label), { 'data-rid': rid });
      b.disabled = ctl.busy;
      return b;
    };
    const inside = ctl.usersInside(rid);
    const users = [
      ...inside.map(i => ({ rid: i.rid, id: i.row.id, name: i.row.name, className: i.row.className })),
      ...(st?.status === 'done' ? st.users.filter(u => !inside.some(i => i.rid === u.rid)) : []),
    ];
    const out = el('div', 'tr-usedby');
    if (users.length) {
      const n = st?.status === 'done' && st.more ? `${count(TRANSPORT_USED_BY_CAP)} or more objects` : plural(users.length, 'object');
      out.append(el('span', 'tr-help', n));
      if (users.length > USED_BY_LISTED) {
        const by = new Map<string, number>();
        for (const u of users) by.set(u.className, (by.get(u.className) ?? 0) + 1);
        out.append(el('ul', 'tr-usedby-cls', ...[...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, k]) => el('li', '', `${c} · ${count(k)}`))));
      } else {
        out.append(el('div', 'tr-chips', ...users.map(u => {
          const own = ctl.collection.has(u.rid);
          return chip(u.id || u.rid, u.name, own ? 'transport' : 'unknown', own ? u.rid : undefined);
        })));
      }
    }
    if (!st) out.append(go('Find what uses this'));
    else if (st.status === 'reading') out.append(el('span', 'tr-help', 'Reading'), attrs(plainBtn('tr-link tr-usedby-stop', 'Stop'), { 'data-rid': rid }));
    else if (st.status === 'failed') out.append(el('span', 'tr-err', st.error ?? 'What uses it could not be read.'), go('Try again'));
    else if (st.status === 'stopped') out.append(el('span', 'tr-help', 'Stopped.'), go('Find what uses this'));
    else if (!users.length) out.append(el('span', 'tr-help', NOTHING_USES));
    else out.append(el('span', 'tr-help tr-usedby-note', NOT_SEARCHED));
    return out;
  }

  function placeEl(g: PlaceGroup, states: Map<string, ItemStateInfo>): HTMLElement {
    const closed = ctl.placeClosed(g);
    const title = g.path.join(PATH_SEP);
    const head = attrs(plainBtn('tr-pgt', icon('i-chev', `ui-disc-chev${closed ? ' closed' : ''}`), attrs(el('span', 't', title), { title }), el('span', 'n', count(g.items.length))), {
      'data-key': g.key, 'aria-expanded': String(!closed),
    });
    const sec = attrs(el('section', 'tr-pg', el('div', 'tr-pgh ui-band ui-disc', head)), { 'data-key': g.key, 'aria-label': title });
    if (!closed) {
      const rows = el('div', 'tr-rows');
      const frag = document.createDocumentFragment();
      for (const i of g.items) frag.append(...transportRow(i, states));
      rows.append(frag);
      sec.append(rows);
    }
    return sec;
  }

  /** The list waits while its tab is hidden (the tab draws it when it is
   *  shown): a tick on Find does not redraw a long transport nobody sees. */
  function drawTransportList(): void {
    if (transportPanel.hidden) return;
    const groups = ctl.placeGroups();
    tempty.hidden = groups.length > 0;
    ttools.hidden = !groups.length;
    tlist.hidden = ctl.transportView !== 'list' || !groups.length;
    tmap.hidden = ctl.transportView !== 'map' || !groups.length;
    if (!tlist.hidden) {
      const states = ctl.stale ? new Map<string, ItemStateInfo>() : ctl.states();
      const frag = document.createDocumentFragment();
      for (const g of groups) frag.append(placeEl(g, states));
      tlist.replaceChildren(frag);
    } else tlist.replaceChildren();
    if (!tmap.hidden) drawMap(); else tmap.replaceChildren();
    drawTools();
  }

  /** One row opened or closed (or its "Used by" changed): redrawn in place. */
  function drawRow(rid: string): void {
    const row = tlist.querySelector<HTMLElement>(`.tr-trow[data-rid="${rid}"]`);
    const item = ctl.collection.get(rid);
    if (!row || !item) return;
    const states = ctl.stale ? new Map<string, ItemStateInfo>() : ctl.states();
    const next = row.nextElementSibling;
    if (next?.classList.contains('tr-detail')) next.remove();
    row.replaceWith(...transportRow(item, states));
  }

  /** The controls that change the transport, while an apply is confirmed or runs. */
  function syncLocks(): void {
    for (const b of tlist.querySelectorAll<HTMLButtonElement>('.tr-rm')) b.disabled = ctl.locked;
    drawTools();
  }

  function drawTools(): void {
    for (const b of viewBtns) {
      const on = b.dataset.view === ctl.transportView;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const items = ctl.collection.list();
    const r = ctl.refresh;
    draftText.textContent = r?.status === 'reading' ? `Reading ${count(r.done)} of ${count(r.total)}`
      : r?.status === 'failed' ? r.error ?? 'The objects could not be read.'
        : ctl.draftRestored ? draftLine(items, now()) : plural(items.length, 'object');
    draftText.classList.toggle('err', r?.status === 'failed');
    const gone = items.filter(i => i.gone).length;
    if (gone && r?.status !== 'reading') draftText.textContent += ` · ${count(gone)} not found`;
    refreshBtn.textContent = ctl.refreshing ? 'Stop' : 'Refresh';
    refreshBtn.hidden = !ctl.draftRestored && !ctl.refresh;
    refreshBtn.disabled = !ctl.refreshing && (ctl.busy || ctl.locked);
    clearBtn.disabled = ctl.locked || !items.length;
    draftNote.hidden = !(ctl.draftUnread && items.length);
  }

  function drawUndo(): void {
    tempty.replaceChildren(EMPTY_TRANSPORT);
    if (ctl.cleared && !ctl.collection.size) tempty.append(' ', btn('tr-link tr-undo-btn', undefined, () => ctl.undoClear(), 'Undo the clear'));
  }

  // ── transport: the map ──────────────────────────────────────────

  type MapSel = { kind: 'left'; key: string } | { kind: 'right'; key: string } | { kind: 'link'; key: string; right: string } | null;
  let mapSel: MapSel = null;
  let mapModelNow: TransportMapModel | null = null;
  let resizeObs: ResizeObserver | null = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag: string, a: Record<string, string>) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
    return e;
  };

  function drawMap(): void {
    const m = ctl.mapModel();
    mapModelNow = m;
    const compared = m.right.length > 0 || !!ctl.uses();
    const targetLabel = ctl.bundle?.direct?.label ?? 'the target';
    const left = el('div', 'tr-mcol tr-mleft', el('div', 'tr-mhead', 'In this transport'),
      ...m.left.map(b => {
        const on = mapSel?.kind === 'left' && mapSel.key === b.key;
        const box = attrs(plainBtn(`tr-mbox${on ? ' on' : ''}`,
          attrs(el('span', 'tr-mbox-t', b.label), { title: b.label }),
          el('span', 'tr-mbox-n', plural(b.rids.length, 'object')),
          b.counts ? el('span', 'tr-mbox-c', b.counts) : null,
          b.uploads ? el('span', 'tr-mbox-c warn', `${count(b.uploads)} to upload`) : null,
        ), { 'data-box': b.key, 'aria-pressed': String(on) });
        box.addEventListener('click', () => selectMap({ kind: 'left', key: b.key }));
        return box;
      }));
    const right = el('div', 'tr-mcol tr-mright', el('div', 'tr-mhead', 'Uses'));
    if (!compared) right.append(el('p', 'tr-help', ctl.mode === 'any' ? BUILD_TO_SEE : COMPARE_TO_SEE));
    else if (!m.right.length) right.append(el('p', 'tr-help', 'No objects outside this transport.'));
    for (const r of m.right) {
      const on = mapSel?.kind === 'right' && mapSel.key === r.kind;
      const box = attrs(plainBtn(`tr-mbox${on ? ' on' : ''}${r.missing ? ' danger' : ''}`,
        el('span', 'tr-mbox-t', r.label),
        el('span', 'tr-mbox-n', plural(r.keys.length, 'object')),
        r.missing ? el('span', 'tr-mbox-c danger', `${count(r.missing)} missing on ${targetLabel}`) : null,
        r.uploads ? el('span', 'tr-mbox-c warn', `${count(r.uploads)} to upload`) : null,
      ), { 'data-kind': r.kind, 'aria-pressed': String(on) });
      box.addEventListener('click', () => selectMap({ kind: 'right', key: r.kind }));
      right.append(box);
    }
    const svg = svgEl('svg', { class: 'tr-mlinks', 'aria-hidden': 'true' });
    const grid = el('div', 'tr-mgrid', left, el('div', 'tr-mgap'), right);
    grid.prepend(svg as unknown as HTMLElement);
    const legend = compared && m.links.length ? el('p', 'tr-mlegend', 'Numbers on the lines count the objects used.') : null;
    tmap.replaceChildren(el('div', 'tr-mscroll', grid), ...(legend ? [legend] : []), mapPanel(m));
    layoutLinks();
    if (!resizeObs && typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => { if (!tmap.hidden) layoutLinks(); });
      resizeObs.observe(tmap);
    }
  }

  /** The connectors, from the boxes' places. */
  function layoutLinks(): void {
    const m = mapModelNow;
    const grid = tmap.querySelector<HTMLElement>('.tr-mgrid');
    const svg = grid?.querySelector('svg');
    if (!m || !grid || !svg) return;
    const g = grid.getBoundingClientRect();
    svg.setAttribute('width', String(Math.max(0, g.width)));
    svg.setAttribute('height', String(Math.max(0, g.height)));
    svg.replaceChildren();
    const at = (sel: string) => grid.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
    for (const l of m.links) {
      const a = at(`.tr-mbox[data-box="${CSS.escape(l.left)}"]`);
      const b = at(`.tr-mbox[data-kind="${CSS.escape(l.right)}"]`);
      if (!a || !b) continue;
      const x1 = a.right - g.left, y1 = a.top - g.top + a.height / 2;
      const x2 = b.left - g.left, y2 = b.top - g.top + b.height / 2;
      const mx = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      const on = mapSel?.kind === 'link' && mapSel.key === l.left && mapSel.right === l.right;
      const w = Math.min(4, 1 + Math.log2(l.keys.length));
      const grp = svgEl('g', { class: `tr-mlink${l.missing ? ' danger' : ''}${on ? ' on' : ''}`, 'data-left': l.left, 'data-right': l.right });
      grp.append(
        svgEl('path', { d, class: 'tr-mlink-line', 'stroke-width': String(w) }),
        svgEl('path', { d, class: 'tr-mlink-hit' }),
      );
      const label = svgEl('text', { x: String(mx), y: String((y1 + y2) / 2 - 4), class: 'tr-mlink-n', 'text-anchor': 'middle' });
      label.textContent = count(l.keys.length);
      grp.append(label);
      grp.addEventListener('click', () => selectMap({ kind: 'link', key: l.left, right: l.right }));
      svg.append(grp);
    }
  }

  function selectMap(sel: MapSel): void {
    const same = mapSel && sel && mapSel.kind === sel.kind && mapSel.key === sel.key && (sel.kind !== 'link' || (mapSel.kind === 'link' && mapSel.right === sel.right));
    mapSel = same ? null : sel;
    drawMap();
  }

  /** The objects behind the selected box or connector. */
  function mapPanel(m: TransportMapModel): HTMLElement {
    const panel = attrs(el('div', 'tr-mpanel'), { 'aria-live': 'polite' });
    const sel = mapSel;
    if (!sel) return panel;
    const states = ctl.stale ? new Map<string, ItemStateInfo>() : ctl.states();
    const outside = new Map((ctl.uses()?.outside ?? []).map(o => [o.key, o]));
    const showBtn = (rid: string) => btn('tr-link tr-showin', undefined, () => ctl.showInList(rid), 'Show in list');
    const usedRow = (o: UsedObject, inBox?: Set<string>) => {
      const by = inBox ? o.by.find(r => inBox.has(r)) : o.by[0];
      return attrs(el('div', 'tr-mrow', el('span', `tr-dot ${o.state}`), attrs(el('span', 'tr-ro-a', o.address), { title: o.address }), attrs(el('span', 'tr-ro-n', o.name), { title: o.name }),
        el('span', 'tr-mrow-s', USE_STATE_TITLES[o.state]), by ? showBtn(by) : null), { 'data-key': o.key });
    };
    if (sel.kind === 'left') {
      const b = m.left.find(x => x.key === sel.key);
      if (!b) return panel;
      panel.append(el('div', 'tr-mpanel-h', `${b.label} · ${plural(b.rids.length, 'object')}`));
      for (const rid of b.rids) {
        const i = ctl.collection.get(rid);
        if (!i) continue;
        panel.append(attrs(el('div', 'tr-mrow', attrs(el('span', 'tr-ro-a', i.row.id), { title: i.row.id }), attrs(el('span', 'tr-ro-n', i.row.name), { title: i.row.name }),
          el('span', 'tr-mrow-s', stateTag(states.get(rid))), showBtn(rid)), { 'data-rid': rid }));
      }
    } else if (sel.kind === 'right') {
      const r = m.right.find(x => x.kind === sel.key);
      if (!r) return panel;
      panel.append(el('div', 'tr-mpanel-h', `${r.label} · ${plural(r.keys.length, 'object')}`));
      for (const k of r.keys) { const o = outside.get(k); if (o) panel.append(usedRow(o)); }
    } else {
      const l: MapLink | undefined = m.links.find(x => x.left === sel.key && x.right === sel.right);
      const lb = m.left.find(x => x.key === sel.key);
      const rb = m.right.find(x => x.kind === sel.right);
      if (!l || !lb || !rb) return panel;
      panel.append(el('div', 'tr-mpanel-h', `${lb.label} uses ${plural(l.keys.length, 'object')} of ${rb.label}`));
      const inBox = new Set(lb.rids);
      for (const k of l.keys) { const o = outside.get(k); if (o) panel.append(usedRow(o, inBox)); }
    }
    return panel;
  }

  function drawTransport(): void {
    drawHeader();
    drawDirect();
    drawSummary();
    drawPaste();
    drawScripts();
    drawOptions();
    drawUndo();
    drawTransportList();
  }

  // ── log view ────────────────────────────────────────────────────

  function logEntry(e: TransportLogEntry): HTMLElement {
    const name = e.name || e.id;
    const head = [
      attrs(el('span', 'tr-le-n', name), { title: name }),
      attrs(el('span', 'tr-le-w', shortTime(e.createdIso, e.created, now())), { title: e.created }),
      attrs(el('span', 'tr-le-b', e.createdBy), { title: e.createdBy }),
    ];
    if (!e.description) return attrs(el('div', 'tr-le', el('div', 'tr-le-h', ...head)), { 'data-rid': e.rid });
    return attrs(el('details', 'tr-le', el('summary', 'tr-le-h', ...head), el('pre', 'tr-le-d', e.description)), { 'data-rid': e.rid });
  }

  function drawLog(): void {
    const log = ctl.log;
    const back = btn('tr-link tr-back', undefined, () => ctl.closeLog(), icon('i-back', 'ic-sm'), 'Back');
    const refresh = btn('tr-logref ui-tbtn', undefined, () => { void ctl.readLog(); }, icon('i-retry'), 'Refresh');
    refresh.disabled = ctl.busy;
    const status = attrs(el('div', 'tr-status'), { role: 'status' });
    if (log?.status === 'reading') status.append(el('span', '', 'Reading the transport log'), btn('tr-link', undefined, () => ctl.stopLog(), 'Stop'));
    else if (log?.status === 'stopped') status.append(el('span', '', 'Stopped'));
    else if (log?.status === 'failed') errorLine(status, log.error ?? 'The transport log could not be read.');
    const kids: HTMLElement[] = [el('div', 'tr-logbar', back, el('span', 'tr-logbar-t', 'Transport log'), el('span', 'tr-sp'), refresh), status];
    if (log?.read) {
      if (log.missingLog) kids.push(el('p', 'tr-empty', 'No transport log on this workspace yet.'));
      else if (!log.entries.length) kids.push(el('p', 'tr-empty', 'The transport log has no entries.'));
      else {
        kids.push(attrs(el('div', 'tr-log', ...log.entries.map(logEntry)), { role: 'list' }));
        if (log.more) kids.push(el('p', 'tr-limits', `Showing the newest ${plural(log.entries.length, 'entry', 'entries')}.`));
      }
    }
    logView.replaceChildren(...kids);
  }

  // ── the whole ───────────────────────────────────────────────────

  function drawTabs(): void {
    const t = ctl.logOpen ? null : ctl.tab;
    for (const b of [tabFind, tabTransport]) {
      const on = b.dataset.tab === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    findPanel.hidden = ctl.logOpen || ctl.tab !== 'find';
    transportPanel.hidden = ctl.logOpen || ctl.tab !== 'transport';
    logView.hidden = !ctl.logOpen;
  }

  function drawView(): void {
    drawTabs();
    drawCounts();
    drawFindBar();
    drawFindStatus();
    drawUsers();
    drawList();
    drawTransport();
    drawLog();
  }

  const onChange = (c: Change) => {
    switch (c.kind) {
      case 'scan': drawFindStatus(); drawFindBar(); drawHeader(); break;
      case 'where': drawFindBar(); break;
      case 'find': drawFindBar(); drawFindStatus(); break;
      case 'browse': redrawList(); drawFindBar(); drawFindStatus(); break;
      case 'taking': drawFindStatus(); drawFindBar(); redrawList(); drawHeader(); break;
      case 'area': drawGroup(c.root); drawUsers(); drawFindStatus(); drawFindBar(); break;
      case 'node': drawNode(c.root, c.key); break;
      case 'rest': drawNotes(c.root); drawFindStatus(); break;
      case 'areas': drawUsers(); drawList(); break;
      case 'filters': drawFindBar(); drawUsers(); redrawList(); break;
      case 'collection': redrawList(); drawCounts(); drawHeader(); drawSummary(); drawUndo(); drawTransportList(); if (!optsBox.firstChild !== !ctl.collection.size) drawOptions(); break;
      case 'bundle': drawHeader(); drawDirect(); drawSummary(); drawPaste(); drawScripts(); drawOptions(); drawTransportList(); drawFindBar(); break;
      case 'patch':
        if (c.partsOnly) { drawScripts(); drawHeader(); break; }
        drawHeader(); drawDirect(); drawSummary(); syncPaste(); drawScripts(); drawOptions(); drawTransportList(); break;
      case 'apply':
        drawHeader(); drawDirect(); drawSummary(); drawOptions(); redrawList(); syncLocks();
        if (ctl.direct?.phase.kind === 'reviewed' || ctl.direct?.phase.kind === 'done') drawTransportList();
        break;
      case 'targets': drawFindBar(); drawHeader(); drawSummary(); drawPaste(); drawScripts(); drawOptions(); drawTransportList(); break;
      case 'log': drawLog(); drawFindBar(); break;
      case 'view': drawView(); break;
      case 'tview': drawTransportList(); break;
      case 'detail': drawRow(c.rid); break;
      case 'usedby': drawRow(c.rid); drawHeader(); break;
      case 'facts': drawSummary(); if (ctl.transportView === 'map' || ctl.openRows.size) drawTransportList(); break;
      case 'draft': drawTools(); drawUndo(); drawHeader(); break;
      case 'fileLimit': drawOptions(); drawHeader(); break;
    }
  };
  const off = ctl.onChange(onChange);
  drawView();

  return {
    dispose: () => {
      off();
      stopTick();
      resizeObs?.disconnect();
      document.removeEventListener('mousedown', onDocDown);
    },
  };
}

/** Close the Changed or Areas menu if one is open; true when it was. */
export function closeWherePopover(host: HTMLElement): boolean {
  const pop = [...host.querySelectorAll<HTMLElement>('.tr-pop')].find(p => !p.hidden);
  if (!pop) return false;
  pop.hidden = true;
  const opener = pop.parentElement?.querySelector<HTMLElement>('.fb-b');
  opener?.setAttribute('aria-expanded', 'false');
  opener?.focus();
  return true;
}
