/**
 * Shared by the two tabs: what a tab gets from the page, the dated "Read"
 * line with its Refresh control, and the save bar.
 *
 * The save bar is one compact bar that floats at the bottom of the main area
 * while there is something to save: a small mark, one short phrase ("3
 * unsaved changes"), Review, Discard and Save. The list of changes is not in
 * the bar; Review opens it in a panel above the bar. Saving, saved and
 * failed are states of the same bar, so it never jumps: a failure is one
 * short sentence there, and Details opens the panel with BMP's full message
 * on the row it belongs to.
 */
import { attrs, btn, el, icon } from '../lib/dom';
import { readDate } from '../lib/read-date';

export { readDate };

export interface PageCtx {
  /** `profileId@server` of the server this page was opened for. */
  environment: string;
  /** Run a task while the page waits for the server: the mark reads. */
  work<T>(task: Promise<T>): Promise<T>;
  /** Open the other tab. */
  openTab(tab: 'colors' | 'images'): void;
}

/** The foot of a list: when the copy was read, and Refresh. */
export function readFoot(ms: number | null, onRefresh: () => void, disabledReason?: string, reading = false): HTMLElement {
  const refresh = btn('ci-link', undefined, onRefresh, 'Refresh');
  if (disabledReason || reading) { refresh.disabled = true; if (disabledReason) refresh.title = disabledReason; }
  return el('div', 'ci-side-f', el('span', 'ci-read', reading ? 'Reading…' : ms == null ? 'Not read' : `Read ${readDate(ms)}`), refresh);
}

/** One change in the Review list. */
export interface ConfirmRow {
  /** The lead: the two swatches or thumbnails of the change. */
  lead: Node;
  name: string;
  detail: string;
  /** The whole line, for a row that is cut short. */
  title?: string;
  /** What keeps this row from being saved (an ID that is taken …), in the error colour. */
  problem?: string;
  /** After a save that did not finish: this row was written, or not. */
  outcome?: 'saved' | 'failed' | 'not-saved';
  /** BMP's message for the row that failed. */
  message?: string;
}

/** A save that did not finish. */
export interface SaveFailure {
  /** One short sentence that fits the bar ("1 of 3 not saved."). */
  sentence: string;
  /** BMP's message when no single row carries it (a write that is all or nothing). */
  message?: string;
}

export interface SaveBarProps {
  /** How many changes Save writes. */
  count: number;
  rows: ConfirmRow[];
  /** Said in Review (what the change reaches). */
  note?: string;
  /** Said in Review above the rows (left out, too large …). */
  skipped?: string;
  /** Said after the count in the bar ("1 to fix"). */
  flag?: string;
  /** Why Save is off, as its tooltip. */
  blocked?: string;
  /** 'saving' while the write runs, 'checking' while the fresh read is compared. */
  phase?: 'saving' | 'checking';
  failure?: SaveFailure | null;
  canSave: boolean;
  onSave(): void;
  onDiscard(): void;
}

export interface SaveBar {
  /** The bar's host: placed over the bottom of the main area. */
  el: HTMLElement;
  /** Draw the bar, or put it away when there is nothing to save (null). */
  draw(p: SaveBarProps | null): void;
  /** Say that the save went through ("Saved 3 changes"), then leave. */
  saved(text: string): void;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The bar's sentence and the full message of a write that did not finish (`written` of `total` went through). */
export function saveFailure(total: number, written: number, error: string | undefined, outcomeUnknown = false): SaveFailure {
  if (outcomeUnknown) {
    return { sentence: 'No answer from BMP.', message: `${error ?? 'BMP did not answer.'} It may have saved. Discard, then Refresh to see what it holds.` };
  }
  const left = Math.max(1, total - written);
  return { sentence: total === 1 ? 'Not saved.' : `${left} of ${total} not saved.`, message: error ?? 'BMP did not write it.' };
}

/** How long "Saved 3 changes" stays before the bar leaves. */
export const SAVED_MS = 2400;

/**
 * The save bar. `view` is the tab's root: while the bar shows it carries
 * `ci-has-bar`, which gives the scroll area room under its last row.
 */
export function createSaveBar(view: HTMLElement): SaveBar {
  const host = attrs(el('div', 'ci-savebar'), { role: 'region', 'aria-label': 'Unsaved changes' });
  host.hidden = true;
  let props: SaveBarProps | null = null;
  let open = false;
  let confirming = false;
  let flash = '';
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let listScroll = 0;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (open) { open = false; paint(); host.querySelector<HTMLElement>('.ci-sb-review')?.focus(); } else if (confirming) { confirming = false; paint(); }
  };
  const onDown = (e: PointerEvent) => {
    if (host.contains(e.target as Node)) return;
    if (open || confirming) { open = false; confirming = false; paint(); }
  };
  function listen(on: boolean): void {
    if (on) { document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onDown, true); } else { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); }
  }

  function rowEl(r: ConfirmRow): HTMLElement {
    const state = r.outcome === 'saved' ? el('span', 'ci-pstate ok', icon('i-check', 'ic-sm'), 'Saved')
      : r.outcome === 'failed' ? el('span', 'ci-pstate bad', 'Not saved') : r.outcome ? el('span', 'ci-pstate', 'Not saved') : null;
    const text = el('span', 'ci-ptext',
      el('span', 'ci-pline', el('span', 'ci-pname', r.name), state),
      el('span', 'ci-pdetail', r.detail),
      r.problem ? el('span', 'ci-pmsg', r.problem) : null,
      r.message ? el('span', 'ci-pmsg', r.message) : null);
    return attrs(el('div', `ci-prow${r.outcome ? ` ${r.outcome}` : ''}`, el('span', 'ci-pair', r.lead), text), { title: r.title ?? `${r.name}  ${r.detail}` });
  }

  function panel(p: SaveBarProps): HTMLElement {
    const fail = p.failure;
    const head = el('div', 'ci-sb-ph',
      el('span', 'ci-sb-pt', fail ? 'Not all saved' : plural(p.rows.length, 'change')),
      p.note ? el('span', 'ci-sb-pnote', p.note) : null,
      btn('ci-ib ci-sb-px', 'Close', () => { open = false; paint(); }, icon('i-x', 'ic-sm')));
    const list = el('div', 'ci-prows', ...p.rows.map(rowEl));
    const box = attrs(el('div', 'ci-sb-panel', head,
      fail?.message ? el('div', 'ci-sb-pmsg', icon('i-warn', 'ic-sm'), el('span', '', fail.message)) : null,
      p.skipped ? el('div', 'ci-confirm-skip', p.skipped) : null,
      list), { role: 'dialog', 'aria-label': fail ? 'What was not saved' : 'Unsaved changes' });
    queueMicrotask(() => { list.scrollTop = listScroll; });
    list.addEventListener('scroll', () => { listScroll = list.scrollTop; });
    return box;
  }

  function paint(): void {
    const p = props;
    if (flash && !p) {
      host.replaceChildren(el('div', 'ci-sb ok', el('span', 'ci-sb-mark ok', icon('i-check', 'ic-sm')), attrs(el('span', 'ci-sb-text', flash), { role: 'status' })));
      show(true);
      return;
    }
    if (flash) { flash = ''; clearTimeout(flashTimer); }
    if (!p) { open = false; confirming = false; listScroll = 0; host.replaceChildren(); show(false); return; }
    const busy = !!p.phase;
    if (busy) { confirming = false; }
    const fail = p.failure ?? null;
    let tone = fail ? 'bad' : p.flag ? 'warn' : '';
    let mark: Node = fail || p.flag ? icon('i-warn', 'ic-sm') : el('i', 'ci-sb-dot');
    let text = fail ? fail.sentence : p.count > 0 ? `${plural(p.count, 'unsaved change')}${p.flag ? `, ${p.flag}` : ''}` : `Nothing to save${p.flag ? `, ${p.flag}` : ''}`;
    if (p.phase === 'saving') { tone = ''; mark = el('span', 'ci-spin'); text = `Saving ${plural(p.count, 'change')}…`; }
    if (p.phase === 'checking') { tone = ''; mark = el('span', 'ci-spin'); text = 'Checking what BMP holds…'; }
    const n = p.rows.length;
    if (confirming && !busy) {
      const keep = btn('ui-btn ghost', undefined, () => { confirming = false; paint(); }, 'Keep');
      const go = btn('ui-btn danger', undefined, () => { confirming = false; open = false; p.onDiscard(); }, 'Discard');
      host.replaceChildren(el('div', 'ci-sb warn', el('span', 'ci-sb-mark warn', icon('i-warn', 'ic-sm')),
        attrs(el('span', 'ci-sb-text', `Discard ${plural(n, 'change')}?`), { role: 'status' }), el('span', 'ci-sb-acts', keep, go)));
      show(true);
      listen(true);
      go.focus();
      return;
    }
    const review = btn(`ci-sb-review${open ? ' on' : ''}`, undefined, () => { open = !open; paint(); }, fail ? 'Details' : 'Review');
    review.setAttribute('aria-expanded', String(open));
    const discard = btn('ui-btn ghost', undefined, () => {
      if (n > 1) { confirming = true; open = false; paint(); } else { open = false; p.onDiscard(); }
    }, 'Discard');
    const save = btn('ui-btn primary', undefined, () => { p.onSave(); }, 'Save') as HTMLButtonElement;
    save.disabled = busy || !p.canSave;
    if (!p.canSave && p.blocked) save.title = p.blocked;
    (discard as HTMLButtonElement).disabled = busy;
    review.disabled = n === 0;
    const bar = el('div', `ci-sb${tone ? ` ${tone}` : ''}`,
      el('span', `ci-sb-mark${tone ? ` ${tone}` : ''}`, mark),
      attrs(el('span', 'ci-sb-text', text), { role: 'status', 'aria-live': 'polite' }),
      review,
      el('span', 'ci-sb-acts', discard, save));
    host.replaceChildren(...(open && n ? [panel(p)] : []), bar);
    show(true);
    listen(open);
  }

  function show(on: boolean): void {
    host.hidden = !on;
    view.classList.toggle('ci-has-bar', on);
    if (!on) listen(false);
  }

  return {
    el: host,
    draw(p) {
      props = p;
      paint();
    },
    saved(text) {
      props = null; open = false; confirming = false; listScroll = 0; flash = text;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flash = ''; paint(); }, SAVED_MS);
      paint();
    },
  };
}

/** A row of a sidebar tree, drawn like Browse's: a chevron column, the glyph, the name, then the count against the right edge. */
export interface TreeRow {
  label: string;
  /** Depth in the tree: each level is one indent step. */
  depth: number;
  /** A sprite id (`o-folder`), or 'dot' for a child that has no glyph of its own. */
  glyph: string;
  count?: number;
  on?: boolean;
  /** Undefined: nothing to fold. */
  expanded?: boolean;
  onToggle?(): void;
  onOpen(): void;
  /** Said before the count (the "+3" of unsaved images). */
  extra?: Node | null;
  title?: string;
}

export function treeRow(r: TreeRow): HTMLButtonElement {
  const chev = el('span', `ci-tchev${r.expanded === false ? ' closed' : ''}`);
  if (r.expanded !== undefined) {
    chev.append(icon('i-chev', 'ic-sm'));
    attrs(chev, { title: r.expanded ? 'Fold' : 'Unfold' });
    chev.addEventListener('click', e => { e.stopPropagation(); r.onToggle?.(); });
  }
  const glyph = r.glyph === 'dot' ? el('span', 'ci-tglyph', el('i', 'ci-tdot')) : el('span', 'ci-tglyph', icon(r.glyph));
  const b = btn(`ci-srow ci-trow${r.on ? ' on' : ''}`, undefined, () => r.onOpen(),
    chev, glyph, el('span', 'ci-srow-name', r.label), r.extra ?? null, r.count === undefined ? null : el('span', 'ci-n', String(r.count))) as HTMLButtonElement;
  b.style.setProperty('--d', String(r.depth));
  if (r.expanded !== undefined) b.setAttribute('aria-expanded', String(r.expanded));
  if (r.on) b.setAttribute('aria-current', 'true');
  b.title = r.title ?? r.label;
  return b;
}

/** The line a tab shows over its content while it loads or after a failure. */
export function statusBlock(text: string, retry?: () => void): HTMLElement {
  return el('div', 'ci-state', el('span', '', text), retry ? btn('ui-btn', undefined, retry, 'Retry') : null);
}
