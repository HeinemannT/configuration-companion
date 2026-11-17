/**
 * Code references in the object window (and the editor, via
 * code-ref-links.ts): links in read-only code, the peek
 * card (hover or keyboard focus), inline peeks under the calling line
 * (nestable, collapsible) and the "Calls" section.
 *
 * References come from the shared finder (lib/code-refs), their identities
 * from one batched resolve per render (`flush`), a target's code from one
 * object read on its first peek. State that must survive a re-render (open
 * peeks, folded peeks, expanded Calls rows) lives in the view's per-root
 * state; the card lives outside the pane and is re-anchored after each
 * render.
 *
 * Card: opens after the pointer rests on a link (as in the Extended Code
 * window), stays while the pointer moves into it, never shows for a link
 * whose code is already unfolded, and hides at once when the link is used.
 * Escape closes the innermost thing first: the card, then the peek that has
 * focus or was opened last (`escape`). Pure DOM, no chrome.*.
 */

import { formatCombo, shortcutLabel, whichShortcut, withShortcut } from '../lib/shortcuts';
import { findCodeRefs, refLabel, type CodeRef } from '../lib/code-refs';
import type { CodeRefCache } from '../lib/code-ref-client';
import type { RefTarget } from '../lib/code-ref-resolve';
import { EXPRESSIONS, propLabel, typeInfo, typeLabel } from '../lib/object-window-table';
import type { FullObject } from '../lib/object-read';
import { formatCount, renderCode } from './code-view';
import { btn as kitBtn, el, icon } from '../lib/dom';

/** Where a piece of code sits: whose code, which property, its state key. */
export interface RefCtx {
  rid: string;
  prop: string;
  /** State key prefix; peeks under this code nest below it. */
  path: string;
  /** Peeked objects between the selected node and `rid` (outermost first),
   *  each with the line and property of the call that reached it. */
  chain: Array<{ rid: string; line: number; prop: string }>;
  depth: number;
}

export interface RefUiState {
  /** Open inline peeks (keys from `peekKey`). */
  peeks: Set<string>;
  /** Peeks showing all their lines. */
  full: Set<string>;
  /** Peeks folded to their header. */
  folded: Set<string>;
  /** Expanded Calls rows; `open` = the section itself is open. */
  calls: Set<string>;
}

export interface RefUiHost {
  cache(): CodeRefCache | null;
  state(): RefUiState | null;
  rerender(): void;
  /** Ctrl/Cmd+Click or the open control: go to the target in the window. */
  open(target: RefTarget, ref: CodeRef, ctx: RefCtx): void;
  /** Code search: every place that calls `target`. */
  findRefs?(target: RefTarget): void;
}

/** Lines a peek shows before "Show all". */
const PEEK_LINES = 12;
/** Lines of code on the hover card. */
const CARD_LINES = 6;
/** Peeks inside peeks, at most (each level costs width). */
const MAX_DEPTH = 4;
/** Rest on a link before the card opens (same as the Extended Code window). */
export const CARD_DELAY_MS = 300;
/** Time to cross the gap from the link into the card. */
const CARD_GRACE_MS = 150;
/** No card right after a link was used (the peek it opened stays clear). */
const AFTER_USE_MS = 450;
/** The "Data" group of Calls starts collapsed above this many rows. */
const DATA_OPEN_MAX = 3;

/** A labelled button whose click does not reach the code line behind it. */
function btn(cls: string, label: string, onClick: (e: MouseEvent) => void, ...kids: Node[]): HTMLButtonElement {
  return kitBtn(cls, label, e => { e.stopPropagation(); onClick(e); }, ...kids);
}

function kbd(text: string): HTMLElement {
  return el('kbd', '', text);
}

export function targetName(t: RefTarget): string {
  return t.name || t.businessId || '(unnamed)';
}

/** The type as a small coloured tile; its name is the tooltip (names get
 *  the space, types the colour). Callers put the type in accessible names. */
export function typeTile(type: string): HTMLElement {
  const info = typeInfo(type);
  const tile = el('span', 'ow-tt', icon(info.icon));
  tile.style.background = `var(${info.fam})`;
  tile.title = typeLabel(type);
  tile.setAttribute('aria-hidden', 'true');
  return tile;
}

/** Lines of code; a final line break does not add an empty line. */
export function countLines(text: string): number {
  return text.replace(/\r?\n$/, '').split('\n').length;
}

/** "12 lines" when all are shown, else "12 of 97 lines". */
export function linesText(shown: number, total: number): string {
  return shown >= total ? `${formatCount(total)} ${total === 1 ? 'line' : 'lines'}` : `${formatCount(shown)} of ${formatCount(total)} lines`;
}

const propWord = (prop: string): string => propLabel(prop).toLowerCase();

/** What the Calls header says about the references it looked up, so a short
 *  list never reads as the whole story:
 *  "3 of 5 references resolved; 1 not found, 1 could not be read." */
export function callsStatus(c: { total: number; found: number; notFound: number; failed: number; pending: number }): string {
  const refs = (n: number): string => `${n} ${n === 1 ? 'reference' : 'references'}`;
  if (c.pending) return `Looking up ${c.pending} of ${refs(c.total)}…`;
  const rest = [c.notFound ? `${c.notFound} not found` : '', c.failed ? `${c.failed} could not be read` : ''].filter(Boolean);
  return `${c.found} of ${refs(c.total)} resolved${rest.length ? `; ${rest.join(', ')}` : ''}.`;
}

/** "No object t.x on this server." for a reference that does not resolve. */
export function notFoundText(ref: Pick<CodeRef, 'ns' | 'id'>): string {
  return ref.ns ? `No object ${ref.ns}.${ref.id} on this server.` : `No object with RID ${ref.id} on this server.`;
}

export const peekKey = (ctx: RefCtx, ref: CodeRef): string => `${ctx.path}/${ref.start}`;


export class RefUi {
  private readonly card: HTMLElement;
  private cardFor: { fk: string; ref: CodeRef; ctx: RefCtx } | null = null;
  private wanted = new Set<string>();
  private showTimer = 0;
  private hideTimer = 0;
  /** No card before this time (a link was just used, focus was restored). */
  private quietUntil = 0;
  /** Peek keys in opening order (Escape closes the last one). */
  private opened: string[] = [];
  /** Peek to bring into view after the next render. */
  private reveal: string | null = null;
  /** A link used while its reference was still being looked up. */
  private intent: { ref: CodeRef; ctx: RefCtx; openIt: boolean } | null = null;

  constructor(private readonly host: RefUiHost, mount: HTMLElement) {
    this.card = el('div', 'ow-card');
    this.card.id = 'ow-ref-card';
    this.card.setAttribute('role', 'tooltip');
    this.card.hidden = true;
    this.card.addEventListener('pointerenter', () => window.clearTimeout(this.hideTimer));
    this.card.addEventListener('pointerleave', () => this.hideSoon());
    mount.append(this.card);
    const doc = mount.ownerDocument;
    // Re-renders replace links under a resting pointer, so leaving is
    // checked on movement, not only on mouseleave.
    doc.addEventListener('pointermove', e => {
      const t = e.target as Element | null;
      if (t?.closest?.('.ow-card')) { window.clearTimeout(this.hideTimer); return; }
      if (!this.cardFor || this.cardFor.fk.startsWith('focus:')) return;
      const link = t?.closest?.('.ow-xref') as HTMLElement | null;
      if (link?.dataset.fk === this.cardFor.fk) { window.clearTimeout(this.hideTimer); return; }
      this.hideSoon();
    }, { passive: true });
    doc.addEventListener('scroll', e => { if (!(e.target as Element | null)?.closest?.('.ow-card')) this.hideCard(); }, { capture: true, passive: true });
    doc.documentElement.addEventListener('mouseleave', () => {
      if (this.cardFor && !this.cardFor.fk.startsWith('focus:')) this.hideCard();
    });
  }

  /** Ask for every reference drawn since the last flush, in ONE request. */
  flush(): void {
    const keys = [...this.wanted];
    this.wanted.clear();
    if (keys.length) void this.host.cache()?.request(keys);
    const st = this.host.state();
    this.opened = this.opened.filter(k => st?.peeks.has(k));
    if (this.reveal) {
      const box = this.card.ownerDocument.querySelector<HTMLElement>(`.ow-peek[data-key="${CSS.escape(this.reveal)}"]`);
      this.reveal = null;
      box?.scrollIntoView({ block: 'nearest' });
    }
    this.refreshCard();
    const it = this.intent;
    const r = it ? this.host.cache()?.ref(it.ref.key) : undefined;
    if (it && r && r !== 'pending') {
      this.intent = null;
      const link = this.card.ownerDocument.querySelector<HTMLElement>(`.ow-xref[data-fk="${CSS.escape(`xref:${peekKey(it.ctx, it.ref)}`)}"]`);
      if (link) queueMicrotask(() => this.activate(it.ref, it.ctx, it.openIt, link));
    }
  }

  /** Escape: close the card, else the focused or last opened peek. True when
   *  something closed (the window must not close on this key press). */
  escape(): boolean {
    window.clearTimeout(this.showTimer);
    if (!this.card.hidden) { this.hideCard(); return true; }
    const st = this.host.state();
    if (!st?.peeks.size) return false;
    const focused = (this.card.ownerDocument.activeElement as Element | null)?.closest?.('.ow-peek') as HTMLElement | null;
    // The innermost: the last opened peek inside the focused one (or the
    // focused one itself), else the last opened peek.
    const scope = focused?.dataset.key && st.peeks.has(focused.dataset.key) ? focused.dataset.key : '';
    const order = [...this.opened, ...[...st.peeks].filter(k => !this.opened.includes(k))].filter(k => st.peeks.has(k));
    const key = [...order].reverse().find(k => !scope || k === scope || k.startsWith(`${scope}/`)) ?? order.pop();
    if (!key) return false;
    this.closePeek(key);
    return true;
  }

  /** True while a card or a peek is open. */
  get busy(): boolean {
    return !this.card.hidden || !!this.host.state()?.peeks.size;
  }

  /** Code with links and inline peeks (read mode). */
  code(text: string, ctx: RefCtx, opts: { label: string; plain?: boolean; keys?: ReadonlySet<string>; orig?: string; maxLines?: number; more?: (hidden: number) => HTMLElement }) {
    const refs = opts.plain ? [] : findCodeRefs(text);
    return renderCode(text, {
      ...opts,
      refs,
      link: ref => this.link(ref, ctx),
      after: line => this.after(line, refs, ctx),
    });
  }

  /** Every reference in `text` (Calls counts, resolve before render). */
  want(keys: readonly string[]): void {
    for (const k of keys) this.wanted.add(k);
  }

  // ── links ──────────────────────────────────────────────────────

  link(ref: CodeRef, ctx: RefCtx): HTMLElement {
    this.wanted.add(ref.key);
    const cache = this.host.cache();
    const r = cache?.ref(ref.key);
    const key = peekKey(ctx, ref);
    const open = !!this.host.state()?.peeks.has(key);
    const found = r && r !== 'pending' && r.found ? r.target : null;
    const nf = !!r && r !== 'pending' && !r.found;
    const a = el('span', `ow-xref${nf ? ' nf' : ''}${!r || r === 'pending' ? ' pend' : ''}${open ? ' open' : ''}`);
    a.tabIndex = 0;
    a.setAttribute('role', found?.codeProp ? 'button' : 'link');
    const fk = `xref:${key}`;
    a.dataset.fk = fk;
    const text = refLabel(ref);
    a.setAttribute('aria-label', found
      ? `${text}: ${targetName(found)}, ${typeLabel(found.type)}${found.codeProp && ctx.depth < MAX_DEPTH ? `. ${shortcutLabel('codeLink.show')} shows the code below, ${shortcutLabel('codeLink.open')} opens it` : `. ${shortcutLabel('codeLink.open')} opens it`}`
      : nf ? `${text}: ${notFoundText(ref)}` : `${text}: looking up`);
    if (found?.codeProp) a.setAttribute('aria-expanded', String(open));
    a.setAttribute('aria-describedby', 'ow-ref-card');
    a.addEventListener('mouseenter', () => this.showSoon(a, ref, ctx, fk));
    a.addEventListener('focus', () => {
      // Keyboard focus only: a pointer press focuses the link too, and a card
      // appearing under a press would swallow the click.
      if (Date.now() < this.quietUntil || a.classList.contains('open') || !a.matches(':focus-visible')) return;
      this.showCard(a, ref, ctx, `focus:${fk}`);
    });
    a.addEventListener('blur', () => { if (this.cardFor?.fk === `focus:${fk}`) this.hideCard(); });
    a.addEventListener('click', e => {
      e.stopPropagation();
      this.activate(ref, ctx, e.ctrlKey || e.metaKey, a);
    });
    a.addEventListener('keydown', e => {
      const id = whichShortcut(e, ['codeLink.open', 'codeLink.show']);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      this.activate(ref, ctx, id === 'codeLink.open', a);
    });
    return a;
  }

  private showSoon(link: HTMLElement, ref: CodeRef, ctx: RefCtx, fk: string): void {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    if (this.cardFor?.fk === fk) return;
    this.showTimer = window.setTimeout(() => {
      if (Date.now() < this.quietUntil || !link.isConnected || !link.matches(':hover') || link.classList.contains('open')) return;
      this.showCard(link, ref, ctx, fk);
    }, CARD_DELAY_MS);
  }

  private hideSoon(): void {
    window.clearTimeout(this.showTimer);
    if (!this.cardFor || this.hideTimer) return;
    this.hideTimer = window.setTimeout(() => { this.hideTimer = 0; this.hideCard(); }, CARD_GRACE_MS);
  }

  private activate(ref: CodeRef, ctx: RefCtx, openIt: boolean, link: HTMLElement): void {
    const r = this.host.cache()?.ref(ref.key);
    // Still looking up: carry the click out once the answer is there.
    if (!r || r === 'pending') { this.intent = { ref, ctx, openIt }; this.showCard(link, ref, ctx, `focus:${link.dataset.fk}`); return; }
    this.intent = null;
    if (!r.found) { this.showCard(link, ref, ctx, `focus:${link.dataset.fk}`); return; }
    this.hideCard();
    this.quietUntil = Date.now() + AFTER_USE_MS;
    if (openIt) { this.host.open(r.target, ref, ctx); return; }
    if (!r.target.codeProp) { this.quietUntil = 0; this.showCard(link, ref, ctx, `focus:${link.dataset.fk}`); return; }
    if (ctx.depth >= MAX_DEPTH) { this.host.open(r.target, ref, ctx); return; }
    const st = this.host.state();
    if (!st) return;
    const key = peekKey(ctx, ref);
    if (st.peeks.has(key)) { this.closePeek(key); return; }
    st.peeks.add(key);
    this.opened.push(key);
    this.reveal = key;
    this.host.rerender();
  }

  /** Close a peek and every peek opened inside it; focus returns to its link. */
  private closePeek(key: string): void {
    const st = this.host.state();
    if (!st) return;
    for (const set of [st.peeks, st.full, st.folded]) {
      for (const k of [...set]) if (k === key || k.startsWith(`${key}/`)) set.delete(k);
    }
    this.opened = this.opened.filter(k => k !== key && !k.startsWith(`${key}/`));
    this.quietUntil = Date.now() + AFTER_USE_MS;
    this.hideCard();
    this.host.rerender();
    this.focusFk(`xref:${key}`);
  }

  private after(line: number, refs: readonly CodeRef[], ctx: RefCtx): Node[] {
    const st = this.host.state();
    if (!st?.peeks.size) return [];
    const out: Node[] = [];
    for (const ref of refs) {
      if (ref.line !== line) continue;
      const key = peekKey(ctx, ref);
      if (!st.peeks.has(key)) continue;
      const r = this.host.cache()?.ref(ref.key);
      if (r && r !== 'pending' && r.found) out.push(this.peek(ref, r.target, ctx, key));
    }
    return out;
  }

  // ── inline peek ────────────────────────────────────────────────

  private peek(ref: CodeRef, target: RefTarget, ctx: RefCtx, key: string): HTMLElement {
    const cache = this.host.cache()!;
    const st = this.host.state()!;
    const code = cache.code(target.rid);
    if (!code) void cache.requestCode(target.rid, target.codeProp);
    const folded = st.folded.has(key);
    const full = st.full.has(key);
    const name = targetName(target);
    const total = code?.text != null ? countLines(code.text) : 0;
    const shown = full ? total : Math.min(total, PEEK_LINES);
    const fold = btn('ui-ibtn ow-peek-fold', folded ? `Expand ${name}` : `Collapse ${name}`, () => {
      if (folded) st.folded.delete(key); else st.folded.add(key);
      this.host.rerender();
      this.focusFk(`fold:${key}`);
    }, icon('i-chev', `ic-sm${folded ? ' closed' : ''}`));
    fold.dataset.fk = `fold:${key}`;
    fold.setAttribute('aria-expanded', String(!folded));
    const openBtn = btn('ui-ibtn', withShortcut(`Open ${name}`, 'codeLink.open'), () => this.host.open(target, ref, ctx), icon('i-popout'));
    const closeBtn = btn('ui-ibtn', withShortcut(`Close the code of ${name}`, 'object.close'), () => this.closePeek(key), icon('i-x'));
    const refsBtn = this.host.findRefs ? btn('ui-ibtn', `Used in code: ${name}`, () => this.host.findRefs?.(target), icon('i-refs')) : null;
    const head = el('div', 'ow-peek-h', fold, typeTile(target.type), el('span', 'nm', name), target.businessId ? el('span', 'ui-id', target.businessId) : '',
      el('span', 'cnt', code?.text != null ? linesText(shown, total) : ''),
      el('span', 'acts', refsBtn, openBtn, closeBtn));
    head.querySelector('.nm')!.setAttribute('title', `${name} · ${typeLabel(target.type)}`);
    const box = el('div', `ow-peek${ctx.depth > 0 ? ' nested' : ''}`, head);
    box.dataset.key = key;
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', `Code of ${name}, ${typeLabel(target.type)}, called on line ${ref.line}`);
    if (folded) return box;
    if (!code || code.loading) box.append(el('div', 'ow-quiet ow-peek-note', 'Loading code…'));
    else if (code.error) box.append(Object.assign(el('div', 'ow-quiet ow-peek-note', 'The code could not be read.'), { title: code.error }));
    else if (code.text == null || !code.prop) box.append(el('div', 'ow-quiet ow-peek-note', 'No code.'));
    else {
      const child: RefCtx = { rid: target.rid, prop: code.prop, path: key, chain: [...ctx.chain, { rid: target.rid, line: ref.line, prop: ctx.prop }], depth: ctx.depth + 1 };
      const view = this.code(code.text.replace(/\r?\n$/, ''), child, {
        label: `${name} ${propWord(code.prop)}`,
        ...(full ? {} : { maxLines: PEEK_LINES }),
        more: hidden => {
          const all = btn('ow-more-btn', `Show all ${formatCount(total)} lines of ${name}`, () => { st.full.add(key); this.host.rerender(); }, document.createTextNode('Show all'));
          return el('div', 'ow-more', `${formatCount(hidden)} more lines`, all);
        },
      });
      box.append(view.el);
    }
    return box;
  }

  // ── card ───────────────────────────────────────────────────────

  private showCard(link: HTMLElement, ref: CodeRef, ctx: RefCtx, fk: string): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = 0;
    this.cardFor = { fk, ref, ctx };
    this.fillCard(ref);
    this.place(link);
  }

  hideCard(): void {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    this.hideTimer = 0;
    this.cardFor = null;
    this.card.hidden = true;
  }

  /** After a render: re-anchor to the new link element, or hide. */
  private refreshCard(): void {
    const c = this.cardFor;
    if (!c) return;
    const fk = c.fk.replace(/^focus:/, '');
    const link = this.card.ownerDocument.querySelector<HTMLElement>(`.ow-xref[data-fk="${CSS.escape(fk)}"]`);
    if (!link || link.classList.contains('open')) { this.hideCard(); return; }
    this.fillCard(c.ref);
    this.place(link);
  }

  private fillCard(ref: CodeRef): void {
    const c = this.cardFor;
    fillRefCard(this.card, ref, this.host.cache(), 'window', c ? t => {
      this.hideCard();
      this.quietUntil = Date.now() + AFTER_USE_MS;
      this.host.open(t, c.ref, c.ctx);
    } : undefined);
  }

  private place(link: HTMLElement): void {
    const card = this.card;
    const win = card.ownerDocument.defaultView!;
    const r = link.getBoundingClientRect();
    card.style.position = 'fixed';
    card.style.zIndex = '40';
    card.style.left = '0px';
    card.style.top = '0px';
    const w = card.offsetWidth, h = card.offsetHeight;
    const left = Math.max(8, Math.min(r.left + 8, win.innerWidth - w - 8));
    const below = r.bottom + 2;
    const top = below + h > win.innerHeight - 8 && r.top - h - 2 > 8 ? r.top - h - 2 : below;
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  private focusFk(fk: string): void {
    this.quietUntil = Date.now() + AFTER_USE_MS;
    queueMicrotask(() => this.card.ownerDocument.querySelector<HTMLElement>(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true }));
  }

  // ── Calls ──────────────────────────────────────────────────────

  /** One row per referenced object of `obj`'s code: objects with code first
   *  (expandable to their code in place), then the other objects as a
   *  compact "Data" group, then the references that did not resolve. */
  calls(obj: FullObject, props: readonly string[], textOf: (prop: string) => string): HTMLElement | null {
    const st = this.host.state();
    const cache = this.host.cache();
    if (!st || !cache) return null;
    const uses = new Map<string, { ref: CodeRef; prop: string; where: Map<string, number[]> }>();
    for (const prop of props) {
      if (EXPRESSIONS[prop]?.plain) continue;
      for (const ref of findCodeRefs(textOf(prop))) {
        const u = uses.get(ref.key) ?? { ref, prop, where: new Map<string, number[]>() };
        const lines = u.where.get(prop) ?? [];
        if (!lines.includes(ref.line)) lines.push(ref.line);
        u.where.set(prop, lines);
        uses.set(ref.key, u);
      }
    }
    if (!uses.size) return null;
    this.want([...uses.keys()]);
    const open = st.calls.has('open');
    type Use = { ref: CodeRef; prop: string; where: Map<string, number[]> };
    const code: Use[] = [], data: Use[] = [], missing: Use[] = [], pending: Use[] = [], unread: Use[] = [];
    for (const u of uses.values()) {
      const r = cache.ref(u.ref.key);
      if (!r || r === 'pending') pending.push(u);
      else if (!r.found) (r.error !== undefined ? unread : missing).push(u);
      else if (r.target.codeProp) code.push(u);
      else data.push(u);
    }
    const found = code.length + data.length;
    const hint = callsStatus({ total: uses.size, found, notFound: missing.length, failed: unread.length, pending: pending.length });
    const toggle = btn('ow-sec-tg', open ? 'Collapse Calls' : 'Expand Calls', () => {
      if (open) st.calls.delete('open'); else st.calls.add('open');
      this.host.rerender();
      this.focusFk('calls-toggle');
    }, icon('i-chev', `ow-band-chev${open ? '' : ' closed'}`), el('span', 't', 'Calls'));
    toggle.dataset.fk = 'calls-toggle';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.removeAttribute('title');
    const head = el('div', 'ow-sec-h ui-band ow-calls-h', toggle, el('span', 'n', String(uses.size)), el('span', 'ow-grow'), el('span', 'hint', hint),
      unread.length && !pending.length
        ? btn('ui-btn ghost', 'Retry reading the references that could not be read', () => { void cache.retry(unread.map(u => u.ref.key)); this.host.rerender(); }, document.createTextNode('Retry'))
        : '');
    const sec = el('section', 'ow-sec ow-calls', head);
    if (!open) return sec;
    const listEl = el('div', 'ow-calls-list');
    listEl.setAttribute('role', 'list');
    for (const u of code) listEl.append(...this.callRow(obj, u.ref, u.prop, u.where));
    for (const u of pending) listEl.append(...this.callRow(obj, u.ref, u.prop, u.where));
    if (data.length) {
      const key = `data:${obj.rid}`;
      const dataOpen = st.calls.has(`${key}:open`) || (data.length <= DATA_OPEN_MAX && !st.calls.has(`${key}:closed`));
      const tg = btn('ow-calls-grp', dataOpen ? 'Collapse Data' : 'Expand Data', () => {
        st.calls.delete(`${key}:open`);
        st.calls.delete(`${key}:closed`);
        st.calls.add(`${key}:${dataOpen ? 'closed' : 'open'}`);
        this.host.rerender();
        this.focusFk(`grp:${key}`);
      }, icon('i-chev', `ic-sm ow-band-chev${dataOpen ? '' : ' closed'}`), el('span', '', 'Data'), el('span', 'n', String(data.length)),
        el('span', 'hint', 'referenced objects without code'));
      tg.dataset.fk = `grp:${key}`;
      tg.setAttribute('aria-expanded', String(dataOpen));
      tg.removeAttribute('title');
      listEl.append(tg);
      if (dataOpen) for (const u of data) listEl.append(...this.callRow(obj, u.ref, u.prop, u.where));
    }
    for (const u of [...unread, ...missing]) listEl.append(...this.callRow(obj, u.ref, u.prop, u.where));
    sec.append(listEl);
    return sec;
  }

  private callRow(obj: FullObject, ref: CodeRef, prop: string, where: Map<string, number[]>): HTMLElement[] {
    const st = this.host.state()!;
    const cache = this.host.cache()!;
    const r = cache.ref(ref.key);
    const by = [...where].map(([p, lines]) => `${propWord(p)} · line ${lines.join(', ')}`).join('; ');
    const rowKey = `row:${obj.rid}:${ref.key}`;
    const ctx: RefCtx = { rid: obj.rid, prop, path: `calls:${obj.rid}:${ref.key}`, chain: [], depth: 0 };
    if (!r || r === 'pending' || !r.found) {
      const nf = !!r && r !== 'pending';
      const row = el('div', 'ow-call', el('span', 'nmc', el('span', 'chev none'), el('span', 'nf-name', refLabel(ref))),
        el('span', `ty${nf ? ' err' : ''}`, nf ? (r.error !== undefined ? 'could not be read' : 'not found') : 'looking up…'), el('span', 'by', by), el('span', 'go'));
      row.setAttribute('role', 'listitem');
      if (nf) row.title = r.error ?? notFoundText(ref);
      return [row];
    }
    const t = r.target;
    const exp = !!t.codeProp && st.calls.has(rowKey);
    const label = `${targetName(t)}, ${typeLabel(t.type)}, used in ${by}`;
    const name = el('span', 'nmc', el('span', `chev${t.codeProp ? (exp ? '' : ' closed') : ' none'}`, icon('i-chev', 'ic-sm')),
      typeTile(t.type), el('span', 'nm', targetName(t)), t.businessId ? el('span', 'ui-id', t.businessId) : '');
    let main: HTMLElement;
    if (t.codeProp) {
      main = btn('ow-call-tg', `${label}. Shows its code`, () => {
        if (exp) st.calls.delete(rowKey); else st.calls.add(rowKey);
        this.host.rerender();
        this.focusFk(`call:${rowKey}`);
      }, name);
      main.setAttribute('aria-expanded', String(exp));
    } else {
      // A data object: the row opens it in the window.
      main = btn('ow-call-tg', `${label}. Opens it`, () => this.host.open(t, ref, ctx), name);
    }
    main.removeAttribute('title');
    main.dataset.fk = `call:${rowKey}`;
    const go = btn('ui-ibtn', `Open ${targetName(t)}`, () => this.host.open(t, ref, ctx), icon('i-popout'));
    const refs = this.host.findRefs ? btn('ui-ibtn', `Used in code: ${targetName(t)}`, () => this.host.findRefs?.(t), icon('i-refs')) : null;
    const row = el('div', `ow-call${exp ? ' sel' : ''}${t.codeProp ? '' : ' data'}`, main, el('span', 'by', by), el('span', 'go', refs, go));
    row.title = `${targetName(t)} · ${typeLabel(t.type)}`;
    row.setAttribute('role', 'listitem');
    if (!exp) return [row];
    const code = cache.code(t.rid);
    if (!code) void cache.requestCode(t.rid, t.codeProp);
    let body: HTMLElement;
    if (!code || code.loading) body = el('div', 'ow-quiet ow-peek-note', 'Loading code…');
    else if (code.error || code.text == null || !code.prop) body = el('div', 'ow-quiet ow-peek-note', code.error ? 'The code could not be read.' : 'No code.');
    else {
      const child: RefCtx = { rid: t.rid, prop: code.prop, path: ctx.path, chain: [{ rid: t.rid, line: ref.line, prop }], depth: 1 };
      const full = st.full.has(rowKey);
      const total = countLines(code.text);
      body = this.code(code.text.replace(/\r?\n$/, ''), child, {
        label: `${targetName(t)} ${propWord(code.prop)}`,
        ...(full ? {} : { maxLines: PEEK_LINES }),
        more: hidden => el('div', 'ow-more', `${formatCount(hidden)} more lines`,
          btn('ow-more-btn', `Show all ${formatCount(total)} lines of ${targetName(t)}`, () => { st.full.add(rowKey); this.host.rerender(); }, document.createTextNode('Show all'))),
      }).el;
    }
    return [row, el('div', 'ow-call-exp', body)];
  }
}

/** The card's second line: the type in words and its class, then the model
 *  when the lookup brought it ("Enterprise object type · CeRisk · model
 *  DEFAULTS"). The class is left out when it only repeats the words
 *  ("List property set item" and ListPropertySetItem): compared without
 *  case, spaces or punctuation. */
export function refMetaText(t: Pick<RefTarget, 'type' | 'model'>): string {
  const words = typeLabel(t.type);
  const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const cls = t.type && bare(t.type) !== bare(words) ? t.type : '';
  return [words, cls, t.model ? `model ${t.model}` : ''].filter(Boolean).join(' · ');
}

/** Fill the peek card for `ref` (shared with the Extended Code window).
 *  Line 1: tile, name, ID (left out when it is the name) and an open
 *  button; line 2: type, class and model; the code only when the object has
 *  code. `window`: click shows the code here. `editor`: Ctrl/Cmd+Click shows
 *  the code (a plain click places the caret). `open`: the open button (the
 *  object window); without it the card has no button. The card is rebuilt
 *  only when what it shows changes (the editor refills it on a timer, and a
 *  rebuilt button would lose a click under way). */
export function fillRefCard(card: HTMLElement, ref: CodeRef, cache: CodeRefCache | null, where: 'window' | 'editor', open?: (t: RefTarget) => void): void {
  const r = cache?.ref(ref.key);
  const t0 = r && r !== 'pending' && r.found ? r.target : null;
  const c0 = t0?.codeProp ? cache?.code(t0.rid) : undefined;
  const sig = JSON.stringify([where, ref.key, !r || r === 'pending' ? 'pending' : r.found ? r.target : ['nf', r.error ?? ''],
    c0 ? [!!c0.loading, c0.error ?? '', c0.text == null ? null : c0.text.length] : null, !!open]);
  if (card.dataset.sig === sig && !card.hidden) return;
  card.dataset.sig = sig;
  card.hidden = false;
  card.className = 'ow-card';
  card.removeAttribute('title');
  if (!r || r === 'pending') {
    card.replaceChildren(el('div', 'ow-card-plain', el('code', '', refLabel(ref)), el('span', '', 'Looking up…')));
    return;
  }
  if (!r.found) {
    card.classList.add('nf');
    card.replaceChildren(el('div', 'ow-card-plain', notFoundText(ref)));
    if (r.error) card.title = r.error;
    return;
  }
  const t = r.target;
  const name = targetName(t);
  const meta = refMetaText(t);
  const showId = !!t.businessId && t.businessId !== name;
  const openBtn = open
    ? btn('ui-ibtn ow-card-open', `Open ${name} in the object window`, () => open(t), icon('i-popout'))
    : null;
  // The editor keeps its focus and caret when the button is pressed.
  openBtn?.addEventListener('mousedown', e => e.preventDefault());
  const head = el('div', 'ow-card-h', typeTile(t.type), el('span', 'nm', name), showId ? el('span', 'ui-id', t.businessId) : '',
    el('span', 'grow'), openBtn ?? '');
  const sub = el('div', 'ow-card-m', meta);
  card.classList.add('compact');
  if (!t.codeProp) {
    card.replaceChildren(head, sub);
    return;
  }
  const code = cache!.code(t.rid);
  if (!code) void cache!.requestCode(t.rid, t.codeProp);
  if (code && !code.loading && !code.error && code.text == null) {
    // The resolve said code, the read found none: say nothing about code.
    card.replaceChildren(head, sub);
    return;
  }
  let body: Node;
  let lines = '';
  if (!code || code.loading) body = el('div', 'ow-quiet ow-card-note', 'Loading code…');
  else if (code.error || code.text == null) body = el('div', 'ow-quiet ow-card-note', 'The code could not be read.');
  else {
    body = renderCode(code.text.replace(/\r?\n$/, ''), { label: name, maxLines: CARD_LINES }).el;
    (body as HTMLElement).removeAttribute('tabindex');
    const n = countLines(code.text);
    lines = `${formatCount(n)} ${n === 1 ? 'line' : 'lines'}`;
  }
  const showHint = where === 'window'
    ? el('span', '', kbd('Click'), ': show code here')
    : el('span', '', kbd(formatCombo('Mod+Click')), ': show code here');
  card.classList.remove('compact');
  card.replaceChildren(head, sub, body, el('div', 'ow-card-f', el('span', '', lines), el('span', 'grow'), showHint));
}
