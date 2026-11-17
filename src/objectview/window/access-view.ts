/**
 * Access mode view: the R W A D cells of the structure tree and the access
 * pane that replaces the detail pane.
 *
 * Renders from `AccessMode` (access-state.ts) and reports intent through
 * `AccessPaneHandlers`. No chrome.* here. The "Test as" bar is built once and
 * kept, so typing in the combobox never loses focus to a re-render; only the
 * body below it is rebuilt.
 *
 * Each fact is said once: the cell carries the verdict, one line under the
 * cells says what decided the selected action, the trace lists statements.
 */

import type { AccessSubject, AccessTraceNode } from '../../lib/types';
import {
  ACCESS_ACTIONS, actionInfo, actionWords, notGrantingSummary, statementOutcome, statementRef, topStatements,
  type AccessAction, type StatementRef, type Verdict,
} from '../../lib/access-mode';
import { policyDestination, type AccessDestination } from '../../lib/access-workspace/entry';
import { traceLabel } from '../../lib/access-workspace/trace-label';
import type { AccessMode } from './access-state';
import { comboKey, indexSubjects, matchSubjects, type ComboState, type SubjectIndex, type SubjectKind } from './subject-search';
import { attrs, btn, el, icon, type Kid } from '../../lib/dom';
import { DENY_IGNORED, DENY_MATCHED, NOT_GRANTED } from '../../lib/access-wording';


const b = (text: string) => el('b', '', text);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stmtNo = (r: StatementRef) => (r.index >= 0 ? String(r.index + 1) : '?');
const plain = (kids: Kid[]) => kids.map(k => (k instanceof Node ? k.textContent ?? '' : k || '')).join('');

// ── tree cells ───────────────────────────────────────────────────

const CELL_WORD: Record<string, string> = { allowed: 'allowed', denied: 'not granted', unknown: 'could not evaluate', loading: 'evaluating', idle: 'no subject' };
/** Verdict words of the strip. Short enough for the narrowest cell. */
const VERDICT_WORD: Record<string, string> = { allowed: 'Allowed', denied: NOT_GRANTED, unknown: 'No result' };

/** The four cells of a tree row in access mode. Allowed is a check, not
 *  granted a short bar, "could not evaluate" a warning triangle: shape, not colour. */
export function accessCells(mode: AccessMode, rid: string): HTMLElement[] {
  return ACCESS_ACTIONS.map(a => {
    const c = mode.cell(rid, a.key);
    const s = el('span', `m ow-sl ${c.state}`);
    if (c.state === 'allowed') s.append(icon('i-check'));
    else if (c.state === 'unknown') s.append(icon('i-warn'));
    s.title = `${a.label}: ${CELL_WORD[c.state]}${c.state === 'unknown' ? ` (${c.reason})` : ''}`;
    return s;
  });
}

/** Screen-reader label of a tree row in access mode. */
export function accessRowLabel(mode: AccessMode, rid: string, name: string): string {
  if (!mode.subject) return name;
  const cells = ACCESS_ACTIONS.map(a => ({ a, c: mode.cell(rid, a.key) }));
  if (cells.some(x => x.c.state === 'loading')) return `${name}, evaluating`;
  if (cells.every(x => x.c.state === 'unknown')) return `${name}, could not evaluate`;
  return `${name}: ${cells.map(x => `${x.a.label} ${CELL_WORD[x.c.state]}`).join(', ')}`;
}

// ── the pane ─────────────────────────────────────────────────────

export interface AccessNodeInfo {
  rid: string;
  name: string;
  businessId: string;
  type: string;
  typeLabel: string;
  iconId: string;
  /** The window's own root: the header already names it. */
  isRoot?: boolean;
}

export interface AccessPaneHandlers {
  openRule(destination: AccessDestination): void;
  /** The Access workspace test for this node (proposed values). */
  openTest(node: AccessNodeInfo): void;
  /** Resolves false when the clipboard write failed. */
  copy(text: string): Promise<boolean> | void;
}

interface TraceUi { open: Set<string>; closed: Set<string>; all?: boolean }

const KIND_FILTERS: Array<[SubjectKind, string]> = [['user', 'Users'], ['role', 'Roles'], ['all', 'All']];

export class AccessPane {
  readonly el: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly inputIcon: HTMLElement;
  private readonly keyEl: HTMLElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly cb: HTMLElement;
  private readonly popup: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly footEl: HTMLElement;
  private readonly kindSeg: HTMLElement;
  private readonly body: HTMLElement;
  private index: SubjectIndex | null = null;
  private indexFor: readonly AccessSubject[] | null = null;
  private kind: SubjectKind = 'all';
  private query = '';
  private editing = false;
  private combo: ComboState = { open: false, active: 0 };
  private flat: AccessSubject[] = [];
  private node: AccessNodeInfo | null = null;
  private readonly ui = new Map<string, TraceUi>();
  private copiedAt = 0;
  private copyFailed = false;
  /** Subject token of the statement the explanation line names. */
  private decidingVia: string | undefined;

  constructor(private readonly mode: AccessMode, private readonly handlers: AccessPaneHandlers) {
    this.input = attrs(el('input', 'ow-cb-input') as HTMLInputElement, {
      id: 'ow-cb-input', type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: 'false',
      'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'ow-cb-list', placeholder: 'Search users and roles',
    });
    this.inputIcon = el('span', 'ow-cb-ic');
    this.keyEl = el('span', 'ow-cb-key ui-id');
    this.clearBtn = btn('ui-ibtn ow-cb-clear', 'Clear subject', () => { this.mode.clearSubject(); this.editing = false; this.query = ''; this.syncInput(); this.input.focus(); }, icon('i-x', 'ic-sm'));
    this.listEl = attrs(el('div', 'ow-cb-scroll'), { id: 'ow-cb-list', role: 'listbox', 'aria-label': 'Users and roles' });
    this.footEl = attrs(el('div', 'ow-cb-foot'), { 'aria-live': 'polite' });
    // The kind filter only matters while searching: it lives in the popup,
    // so the field has the whole row.
    this.kindSeg = attrs(el('div', 'ow-seg ow-ac-kind'), { role: 'radiogroup', 'aria-label': 'Subject type' });
    for (const [k, label] of KIND_FILTERS) {
      const r = btn('', undefined, () => this.setKind(k), label);
      attrs(r, { role: 'radio', 'data-kind': k });
      // A click keeps focus in the input.
      r.addEventListener('mousedown', e => e.preventDefault());
      this.kindSeg.append(r);
    }
    this.kindSeg.addEventListener('keydown', e => this.onKindKey(e));
    this.popup = el('div', 'ow-cb-pop', el('div', 'ow-cb-filt', this.kindSeg), this.listEl, this.footEl);
    this.popup.hidden = true;
    const field = el('div', 'ow-cb-in ui-search', this.inputIcon, this.input, this.keyEl, this.clearBtn);
    this.cb = el('div', 'ow-cb', field, this.popup);
    this.cb.addEventListener('focusout', e => {
      const to = e.relatedTarget as Node | null;
      if (this.combo.open && e.target !== this.input && !(to && this.cb.contains(to))) this.closeList(true);
    });
    const label = attrs(el('label', 'ow-ac-as', 'Test as'), { for: 'ow-cb-input' });
    const bar = el('div', 'ow-ac-bar', label, this.cb);
    this.body = el('div', 'ow-ac-body');
    this.el = attrs(el('div', 'ow-ac'), { 'aria-label': 'Access test' });
    this.el.append(bar, this.body);

    this.input.addEventListener('input', () => {
      this.editing = true;
      this.query = this.input.value;
      this.combo = { open: true, active: 0 };
      this.syncInput();
      this.renderList();
    });
    this.input.addEventListener('click', () => { if (!this.combo.open) this.openList(true); });
    this.input.addEventListener('focus', () => this.mode.prepare());
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.input.addEventListener('blur', e => {
      // A click inside the popup keeps focus (mousedown is prevented there);
      // Tab into the kind filter keeps the list open.
      const to = e.relatedTarget as Node | null;
      if (this.combo.open && !(to && this.popup.contains(to))) this.closeList(true);
    });
    this.listEl.addEventListener('mousedown', e => e.preventDefault());
    this.listEl.addEventListener('click', e => {
      const o = (e.target as Element).closest<HTMLElement>('[role="option"]');
      if (o) this.pick(this.flat[Number(o.dataset.i)]);
    });
    this.listEl.addEventListener('mousemove', e => {
      const o = (e.target as Element).closest<HTMLElement>('[role="option"]');
      const i = o ? Number(o.dataset.i) : -1;
      if (i >= 0 && i !== this.combo.active) { this.combo = { ...this.combo, active: i }; this.markActive(false); }
    });
  }

  /** Focus the subject input (entering the mode without a subject). */
  focusInput(): void {
    this.input.focus({ preventScroll: true });
  }

  get listOpen(): boolean {
    return this.combo.open;
  }

  /** Re-render for `node` (the selected tree node). */
  render(node: AccessNodeInfo): void {
    this.node = node;
    this.syncInput();
    if (this.combo.open) this.renderList();
    this.renderBody();
  }

  // ── combobox ───────────────────────────────────────────────────

  private syncInput(): void {
    const s = this.mode.subject;
    if (!this.editing) this.input.value = s ? s.name : '';
    this.keyEl.textContent = s && !this.editing ? s.businessId ?? '' : '';
    this.inputIcon.replaceChildren(icon(s && !this.editing ? (s.kind === 'role' ? 'i-role' : 'i-user') : 'i-search'));
    this.clearBtn.hidden = !s;
    // A chosen subject shows its whole name; the business ID gives way first.
    this.input.parentElement?.classList.toggle('chosen', !!s && !this.editing);
    for (const r of this.kindSeg.querySelectorAll<HTMLElement>('[role="radio"]')) {
      const on = r.dataset.kind === this.kind;
      r.setAttribute('aria-checked', String(on));
      r.tabIndex = on ? 0 : -1;
    }
  }

  private setKind(kind: SubjectKind): void {
    this.kind = kind;
    this.combo = { ...this.combo, active: 0 };
    this.syncInput();
    if (this.combo.open) this.renderList();
    else { this.input.focus(); this.openList(false); }
  }

  private onKindKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const i = KIND_FILTERS.findIndex(([k]) => k === this.kind);
      const next = KIND_FILTERS[(i + (e.key === 'ArrowRight' ? 1 : KIND_FILTERS.length - 1)) % KIND_FILTERS.length][0];
      this.setKind(next);
      this.kindSeg.querySelector<HTMLElement>(`[data-kind="${next}"]`)?.focus();
    } else if (e.key === 'Escape' || (e.key === 'Tab' && e.shiftKey)) {
      // Back to the input; Escape also closes the list.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') this.closeList(true);
      this.input.focus();
    }
  }

  private openList(selectText: boolean): void {
    this.mode.prepare();
    this.combo = { open: true, active: 0 };
    this.renderList();
    const cur = this.mode.subject ? this.flat.findIndex(s => s.rid === this.mode.subject?.rid) : -1;
    if (cur >= 0) { this.combo = { open: true, active: cur }; this.markActive(true); }
    if (selectText) this.input.select();
  }

  private closeList(restore: boolean): void {
    this.combo = { ...this.combo, open: false };
    this.popup.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    if (restore) { this.editing = false; this.query = ''; this.syncInput(); }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.combo.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      this.openList(false);
      return;
    }
    if (e.key === 'Escape' && !this.combo.open && this.editing) {
      e.preventDefault();
      e.stopPropagation();
      this.closeList(true);
      return;
    }
    // Tab from the open list reaches the kind filter in the popup.
    if (e.key === 'Tab' && !e.shiftKey && this.combo.open) {
      e.preventDefault();
      this.kindSeg.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
      return;
    }
    const step = comboKey(this.combo, e.key, this.flat.length);
    if (step.handled) { e.preventDefault(); e.stopPropagation(); }
    if (step.pick != null) { this.pick(this.flat[step.pick]); return; }
    if (!step.state.open && this.combo.open) { this.closeList(!!step.restore); return; }
    if (step.state.active !== this.combo.active) {
      this.combo = step.state;
      this.markActive(true);
    }
  }

  private pick(s: AccessSubject | undefined): void {
    if (!s) return;
    this.editing = false;
    this.query = '';
    this.closeList(false);
    this.mode.pick(s);
    this.syncInput();
    this.input.focus({ preventScroll: true });
  }

  private ensureIndex(): SubjectIndex | null {
    const list = this.mode.subjects;
    if (!list) return null;
    if (this.indexFor !== list) { this.index = indexSubjects(list); this.indexFor = list; }
    return this.index;
  }

  /** Render the window of matches (not the whole list) and the count line. */
  private renderList(): void {
    this.popup.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    const index = this.ensureIndex();
    if (!index) {
      this.flat = [];
      const err = this.mode.subjectsError;
      this.listEl.replaceChildren(el('div', 'ow-cb-empty', err ? 'Users and roles could not be loaded.' : 'Loading users and roles…'));
      this.footEl.className = 'ow-cb-foot';
      this.footEl.textContent = err ?? '';
      this.footEl.hidden = !err;
      return;
    }
    const q = this.editing ? this.query.trim() : '';
    const m = matchSubjects(index, q, this.kind, this.mode.recents);
    this.flat = [...m.recent, ...m.rest];
    const rows: Node[] = [];
    let i = 0;
    const opt = (s: AccessSubject) => {
      const cur = this.mode.subject?.rid === s.rid;
      const o = attrs(el('div', `ow-cb-opt${cur ? ' cur' : ''}`, icon(s.kind === 'role' ? 'i-role' : 'i-user'),
        el('span', 'nm', s.name), s.businessId ? el('code', 'ky', s.businessId) : '',
        el('span', 'tail', s.kind === 'role' ? 'Role' : 'User', cur ? icon('i-check', 'ic-sm') : '')),
      { role: 'option', id: `ow-cb-o${i}`, 'data-i': String(i), 'aria-selected': 'false', title: `${s.name}${s.businessId ? ` · ${s.businessId}` : ''} · ${s.kind}` });
      i++;
      return o;
    };
    const head = (t: string) => attrs(el('div', 'ow-cb-h', t), { role: 'presentation' });
    if (q) {
      // Typed: every hit is a match; recent ones simply rank first.
      if (this.flat.length) rows.push(head('Matches'), ...this.flat.map(opt));
    } else {
      const restTitle = this.kind === 'role' ? 'Roles' : this.kind === 'user' ? 'Users' : 'Users and roles';
      if (m.recent.length) rows.push(head('Recent'), ...m.recent.map(opt));
      if (m.rest.length) rows.push(head(restTitle), ...m.rest.map(opt));
    }
    if (!this.flat.length) {
      const what = this.kind === 'all' ? 'user or role' : this.kind;
      rows.push(el('div', 'ow-cb-empty', q ? `No ${what} matches “${q}”.` : `No ${what}s on this connection.`));
    }
    this.listEl.replaceChildren(...rows);
    const cut = m.total > m.shown;
    this.footEl.hidden = false;
    // The count is announced; it is shown only when the list is cut.
    this.footEl.className = cut ? 'ow-cb-foot cut' : 'ow-cb-foot ow-sr';
    this.footEl.textContent = cut ? `Showing ${m.shown} of ${m.total}. Type to narrow.` : plural(m.total, 'match', 'matches');
    if (this.combo.active >= this.flat.length) this.combo = { ...this.combo, active: Math.max(0, this.flat.length - 1) };
    this.markActive(true);
  }

  private markActive(scroll: boolean): void {
    let active: HTMLElement | null = null;
    for (const o of this.listEl.querySelectorAll<HTMLElement>('[role="option"]')) {
      const on = Number(o.dataset.i) === this.combo.active;
      o.classList.toggle('act', on);
      o.setAttribute('aria-selected', String(on));
      if (on) active = o;
    }
    if (active) {
      this.input.setAttribute('aria-activedescendant', active.id);
      if (scroll) active.scrollIntoView?.({ block: 'nearest' });
    } else this.input.removeAttribute('aria-activedescendant');
  }

  // ── body ───────────────────────────────────────────────────────

  private renderBody(): void {
    const node = this.node;
    if (!node) return;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && this.body.contains(active) ? active.closest<HTMLElement>('[data-fk]')?.dataset.fk : undefined;
    const top = this.el.parentElement?.scrollTop ?? 0;
    const subject = this.mode.subject;
    const parts: Node[] = [];
    // Idle needs no node line; the root is already named by the header.
    if (subject && !node.isRoot) parts.push(this.nodeLine(node));
    if (!subject) parts.push(...this.noSubject());
    else parts.push(...this.result(node, subject));
    parts.push(this.caveat(node));
    this.body.replaceChildren(...parts);
    if (this.el.parentElement) this.el.parentElement.scrollTop = top;
    if (focusKey) this.body.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  private nodeLine(node: AccessNodeInfo): HTMLElement {
    return el('div', 'ow-ac-node', icon(node.iconId),
      attrs(el('span', 'nm', node.name || '(unnamed)'), { title: node.name }),
      node.businessId ? attrs(el('code', '', node.businessId), { title: node.businessId }) : '',
      el('span', 'kd', node.typeLabel || node.type));
  }

  private noSubject(): Node[] {
    const out: Node[] = [el('p', 'ow-ac-empty', 'Choose a user or role to see what it can read, write, add under and delete across this structure.')];
    const list = this.mode.subjects;
    if (!list) {
      out.push(el('p', 'ow-ac-empty ow-quiet', this.mode.subjectsError ? `Users and roles could not be loaded: ${this.mode.subjectsError}` : 'Loading users and roles…'));
      if (this.mode.subjectsError) out.push(el('div', 'ow-ac-pad', btn('ui-btn', undefined, () => this.mode.prepare(), 'Try again')));
      return out;
    }
    const byRid = new Map(list.map(s => [s.rid, s]));
    const recent = this.mode.recents.map(r => byRid.get(r)).filter((s): s is AccessSubject => !!s);
    if (recent.length) {
      out.push(el('div', 'ow-ac-band ui-band', el('span', '', 'Recent')),
        el('div', 'ow-ac-quick', ...recent.map((s, i) => {
          const q = btn('ow-cb-opt', undefined, () => this.pick(s), icon(s.kind === 'role' ? 'i-role' : 'i-user'),
            el('span', 'nm', s.name), s.businessId ? el('code', 'ky', s.businessId) : '', el('span', 'tail', s.kind === 'role' ? 'Role' : 'User'));
          q.dataset.fk = `recent-${i}`;
          return q;
        })));
    } else {
      const users = list.filter(s => s.kind === 'user').length;
      out.push(el('p', 'ow-ac-empty ow-quiet', `${plural(users, 'user')} and ${plural(list.length - users, 'role')} on ${this.mode.environmentName || 'this connection'}.`));
    }
    return out;
  }

  private result(node: AccessNodeInfo, subject: AccessSubject): Node[] {
    const action = this.mode.action;
    const cells = ACCESS_ACTIONS.map(a => ({ a, c: this.mode.cell(node.rid, a.key) }));
    const strip = attrs(el('div', 'ow-ac-verdicts'), { role: 'radiogroup', 'aria-label': `Verdicts for ${node.name || 'this node'}` });
    for (const { a, c } of cells) {
      const on = a.key === action;
      const word = VERDICT_WORD[c.state] ?? '';
      const ic = c.state === 'allowed' ? icon('i-allow') : c.state === 'denied' ? icon('i-deny') : c.state === 'unknown' ? icon('i-warn') : null;
      const cell = btn(`ow-ac-vc ${c.state}`, undefined, () => this.mode.setAction(a.key),
        el('span', 'vl', a.label), el('span', 'vv', ic, word ? el('span', 'vw', word) : ''));
      attrs(cell, { role: 'radio', 'aria-checked': String(on), 'data-fk': `vc-${a.key}`, 'data-act': a.key });
      if (c.state === 'unknown') cell.title = `${a.label}: no result. ${c.reason}`;
      cell.tabIndex = on ? 0 : -1;
      if (c.state === 'loading') cell.setAttribute('aria-label', `${a.label}: evaluating`);
      strip.append(cell);
    }
    strip.addEventListener('keydown', e => {
      const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      let next: AccessAction | undefined;
      const i = ACCESS_ACTIONS.findIndex(x => x.key === action);
      if (e.key in keys) next = ACCESS_ACTIONS[(i + keys[e.key] + 4) % 4].key;
      else if (e.key === 'Home') next = ACCESS_ACTIONS[0].key;
      else if (e.key === 'End') next = ACCESS_ACTIONS[3].key;
      if (!next) return;
      e.preventDefault();
      this.mode.setAction(next);
      this.body.querySelector<HTMLElement>(`[data-act="${next}"]`)?.focus();
    });
    const c = this.mode.cell(node.rid, action);
    const info = actionInfo(action);
    const env = this.mode.environmentName || 'the server';
    const out: Node[] = [strip];
    this.decidingVia = undefined;
    if (c.state === 'loading' || c.state === 'idle') {
      const p = this.mode.progress();
      out.push(el('div', 'ow-ac-why', p.total <= 10
        ? `Checking ${plural(p.total, 'node')} on ${env}…`
        : `Checking ${p.total} nodes on ${env} · ${p.done} done…`));
      return out;
    }
    if (c.state === 'unknown') {
      const others = this.mode.decidedCount(node.rid);
      const cause = /timed out/i.test(c.reason) ? `${env} stopped evaluating this node (timed out).`
        : /returned no decision/i.test(c.reason) ? `${env} did not return a decision for this node.`
          : `The access check failed: ${c.reason.replace(/\.$/, '')}.`;
      const scope = others ? ` ${others === 1 ? 'The other node was' : `The other ${others} nodes were`} evaluated.` : '';
      out.push(el('div', 'ow-ac-why err', cause + scope),
        el('div', 'ow-ac-pad', attrs(btn('ui-btn ow-btn-ic', undefined, () => this.mode.retry(node.rid), icon('i-retry', 'ic-sm'), 'Retry this node'), { 'data-fk': 'retry' })));
      return out;
    }
    if (c.state === 'allowed') this.decidingVia = c.by[0]?.via;
    out.push(this.explain(c, subject, info.label));
    const t = this.mode.trace(node.rid, action);
    const toolbar = el('span', 'ow-ac-tbar');
    out.push(this.band(`Trace · ${info.label}`, toolbar));
    if (!t || 'loading' in t) {
      out.push(el('div', 'ow-ac-pad ow-quiet', 'Loading the trace…'));
      return out;
    }
    if ('error' in t) {
      out.push(el('div', 'ow-ac-msg', icon('i-warn'), el('div', '', el('p', '', 'The trace could not be loaded.'), el('p', 'why', t.error),
        attrs(btn('ui-btn ow-btn-ic', undefined, () => this.mode.retry(node.rid), icon('i-retry', 'ic-sm'), 'Try again'), { 'data-fk': 'retry' }))));
      return out;
    }
    const key = `${subject.rid}|${node.rid}|${action}`;
    const ui = this.ui.get(key) ?? { open: new Set<string>(), closed: new Set<string>() };
    this.ui.set(key, ui);
    const copied = Date.now() - this.copiedAt < 1200;
    const copyLabel = this.copyFailed ? 'Copy failed' : 'Copied';
    toolbar.append(
      attrs(btn('ow-ac-mini', undefined, () => { ui.all = true; ui.open.clear(); ui.closed.clear(); this.renderBody(); }, icon('i-expall'), 'Expand all'), { 'data-fk': 'expall' }),
      attrs(btn('ow-ac-mini', undefined, () => { ui.all = false; ui.open.clear(); ui.closed.clear(); this.renderBody(); }, icon('i-colall'), 'Collapse all'), { 'data-fk': 'colall' }),
      // Both labels share one grid cell, so the button keeps its width.
      attrs(btn(`ow-ac-mini ow-ac-copy${copied ? ' copied' : ''}`, undefined, () => {
        // "Copied" only after the clipboard write succeeded (copy-feedback.ts).
        void Promise.resolve(this.handlers.copy(this.traceText(t.trace, c, subject, node, info.verb))).then(ok => {
          this.copyFailed = ok === false;
          this.copiedAt = Date.now();
          this.renderBody();
          window.setTimeout(() => this.renderBody(), 1250);
        });
      }, icon(copied && !this.copyFailed ? 'i-check' : 'i-copy'), el('span', 'sw', el('span', copied ? '' : 'on', 'Copy as text'), el('span', copied ? 'on' : '', copyLabel))), { 'data-fk': 'copy' }),
    );
    out.push(this.traceTree(t.trace, c, ui, key, subject));
    if (c.state === 'denied' && c.denyMatched.length) {
      out.push(el('div', 'ow-ac-tnote', `Statements are listed as evaluated. A Deny statement that matched: ${DENY_IGNORED}`));
    }
    return out;
  }

  private band(title: string, ...right: Kid[]): HTMLElement {
    return el('div', 'ow-ac-band ui-band', el('span', '', title), el('span', 'ow-grow'), ...right);
  }

  /** How a statement reached the subject, in words: "through role Basic",
   *  "to this role", "directly to this user". Names, not technical keys. */
  private viaWords(via: string | undefined, subject: AccessSubject): Kid[] {
    const m = via ? /^(role|user|group):(.+)$/.exec(via.trim()) : null;
    if (!m) return via ? ['through ', b(via)] : [];
    const [, kind, id] = m;
    if (kind === 'role') {
      if (subject.kind === 'role' && id === subject.businessId) return ['to this role'];
      const name = this.mode.subjects?.find(s => s.kind === 'role' && s.businessId === id)?.name;
      return ['through role ', b(name ?? id)];
    }
    if (kind === 'user') return subject.kind === 'user' && id === subject.businessId ? ['directly to this user'] : ['through user ', b(id)];
    return ['through group ', b(id)];
  }

  /** The one line under the cells: what decided the selected action. */
  private explain(v: Verdict, subject: AccessSubject, label: string): HTMLElement {
    if (v.state === 'allowed') {
      const r = v.by[0];
      if (!r) return el('div', 'ow-ac-why', 'Allowed, but the server reported no granting statement.');
      const via = this.viaWords(r.via, subject);
      const more = v.by.length > 1 ? ` · ${v.by.length - 1} more granting` : '';
      const tail: Kid[] = [` · statement ${stmtNo(r)}`, ...(via.length ? [' · ', ...via] : []), more];
      const line = el('div', 'ow-ac-why grant', el('span', 'lead', 'Granted by '), el('b', 'pn', r.policyName), el('span', 'tail', ...tail));
      line.title = `Granted by ${r.policyName}${plain(tail)}`;
      return line;
    }
    if (v.state === 'denied') {
      const d = v.denyMatched[0];
      return el('div', 'ow-ac-why', `${NOT_GRANTED}: no statement grants ${label}.`,
        d ? ' ' : '', d ? b(d.policyName) : '', d ? ` (statement ${stmtNo(d)}) is a Deny statement that matched. ${DENY_IGNORED}` : '');
    }
    return el('div', 'ow-ac-why');
  }

  /** Plain sentence for "Copy as text". */
  private sentence(v: Verdict, subject: AccessSubject, node: AccessNodeInfo, verb: string): string {
    const who = subject.kind === 'role' ? `${subject.name} (role)` : subject.name;
    const what = node.name || 'this node';
    if (v.state === 'allowed') {
      const r = v.by[0];
      if (!r) return `${who} can ${verb} ${what}.`;
      const via = plain(this.viaWords(r.via, subject));
      return `${who} can ${verb} ${what}: granted by ${r.policyName} (statement ${stmtNo(r)})${via ? ` ${via}` : ''}.`;
    }
    if (v.state === 'denied') return `${who} cannot ${verb} ${what}: not granted, no statement grants it.`;
    return '';
  }

  // ── trace tree ─────────────────────────────────────────────────

  private isOpen(ui: TraceUi, path: string, def: boolean): boolean {
    if (ui.open.has(path)) return true;
    if (ui.closed.has(path)) return false;
    return ui.all ?? def;
  }

  private toggleRow(ui: TraceUi, path: string, open: boolean): void {
    if (open) { ui.closed.add(path); ui.open.delete(path); } else { ui.open.add(path); ui.closed.delete(path); }
    this.renderBody();
  }

  private traceTree(trace: AccessTraceNode, v: Verdict, ui: TraceUi, key: string, subject: AccessSubject): HTMLElement {
    const list = topStatements(trace);
    const granting = list.filter(s => s.result === true && !s.timedOut);
    const others = list.filter(s => !(s.result === true && !s.timedOut));
    const near = others.filter(s => statementOutcome(s).why !== 'Subject does not match');
    const far = others.filter(s => statementOutcome(s).why === 'Subject does not match');
    const root = attrs(el('div', 'ow-ac-tr'), { role: 'list', 'aria-label': 'Statements' });
    granting.forEach((s, i) => root.append(...this.stmt(s, `g${i}`, 0, ui, true, subject)));
    if (others.length) {
      const open = this.isOpen(ui, 'ng', v.state !== 'allowed');
      root.append(this.groupRow('Not granting', others.length, notGrantingSummary(others), 'ng', 0, open, ui, key));
      if (open) {
        near.forEach((s, i) => root.append(...this.stmt(s, `n${i}`, 1, ui, false, subject)));
        if (far.length) {
          const fo = this.isOpen(ui, 'nf', false);
          root.append(this.groupRow('For other subjects', far.length, 'Subject does not match', 'nf', 1, fo, ui, key));
          if (fo) far.forEach((s, i) => root.append(...this.stmt(s, `f${i}`, 2, ui, false, subject)));
        }
      }
    }
    return root;
  }

  /** A disclosure row in the style of the window's layout group: label,
   *  count, one muted summary line, chevron at the right. */
  private groupRow(title: string, count: number, summary: string, path: string, depth: number, open: boolean, ui: TraceUi, key: string): HTMLElement {
    const t = btn('ow-ac-grp ui-band ui-disc', undefined, () => this.toggleRow(ui, path, open),
      el('span', 't', title), el('span', 'n', String(count)),
      attrs(el('span', 'sum', summary), { title: summary || undefined }),
      icon('i-chev', `ui-disc-chev${open ? '' : ' closed'}`));
    attrs(t, { 'aria-expanded': String(open), 'data-fk': `${key}:${path}` });
    const row = attrs(el('div', 'ow-ac-gw', t), { role: 'listitem' });
    row.style.setProperty('--d', String(depth));
    return row;
  }

  private stmt(s: AccessTraceNode, path: string, depth: number, ui: TraceUi, granting: boolean, subject: AccessSubject): HTMLElement[] {
    const ref = statementRef(s);
    const out = statementOutcome(s);
    const kids = s.children;
    const open = kids.length > 0 && this.isOpen(ui, path, granting);
    // A matched Deny is quiet: the server ignores it, it blocks nothing.
    const st = granting ? el('span', 'st ok', icon('i-allow')) : out.denyMatched ? el('span', 'st ign', icon('i-dash')) : el('span', 'st no', icon('i-deny'));
    const stateWord = granting ? 'Grants' : out.denyMatched ? DENY_MATCHED : 'Does not grant';
    const name = ref.policyName + (ref.effect === 'DENY' ? ' · Deny' : '');
    const title = el('span', 'ttl', b(`Statement ${stmtNo(ref)}`), ' ', el('span', 'pn', name));
    // A granting row names its subject only when the line above does not.
    const whyText = granting
      ? (ref.via && ref.via !== this.decidingVia ? plain(this.viaWords(ref.via, subject)) : '')
      : out.denyMatched ? DENY_MATCHED : out.why;
    const why = whyText ? el('span', 'why', whyText) : null;
    const toggle = kids.length
      ? attrs(btn('ow-ac-tg', undefined, () => this.toggleRow(ui, path, open), el('span', `chev${open ? '' : ' closed'}`, icon('i-chev')), st, title, why), { 'aria-expanded': String(open), 'data-fk': `st:${path}` })
      : el('span', 'ow-ac-tg', el('span', 'chev'), st, title, why);
    const dest = policyDestination(s.details);
    const link = dest
      ? attrs(btn('ow-ac-olink', undefined, () => this.handlers.openRule(dest), 'Open rule', icon('i-popout')), { title: `Open ${ref.policyName}, statement ${stmtNo(ref)} in Access`, 'data-fk': `open:${path}` })
      : null;
    const row = attrs(el('div', `ow-ac-row ui-row stmt${granting ? ' grant' : ''}`, toggle, link), { role: 'listitem', title: `${stateWord} · ${ref.policyName} · statement ${stmtNo(ref)}${out.denyMatched ? ` · ${DENY_IGNORED}` : whyText && !granting ? ` · ${whyText}` : ''}${ref.policyRid ? ` · policy RID ${ref.policyRid}` : ''}` });
    row.style.setProperty('--d', String(depth));
    const rows = [row];
    if (open) kids.forEach((c, i) => rows.push(...this.predicate(c, `${path}.${i}`, depth + 1, ui, 0)));
    return rows;
  }

  /** One predicate of a statement (Subject, Action, conditions), nested. */
  private predicate(n: AccessTraceNode, path: string, depth: number, ui: TraceUi, level: number): HTMLElement[] {
    const d = n.details;
    const ok = n.timedOut || n.result == null ? 'na' : n.result ? 'ok' : 'no';
    const st = el('span', `st ${ok}`, ok === 'ok' ? icon('i-check') : ok === 'no' ? icon('i-x') : icon('i-dash'));
    let k: string, v: string, why = '', words = false, raw = '';
    if (n.element === 'Subject') {
      k = 'Subject';
      v = (d.original ?? '').replace(/^\[|\]$/g, '').trim();
      const hit = (d.globalMatchEntity || d.localMatchEntity || '').trim();
      const listed = v.split(',').map(x => x.trim()).filter(Boolean);
      // Name the matching entry only when the statement lists more than it
      // and the explanation line does not already name it.
      why = hit && !(listed.length === 1 && listed[0] === hit) && hit !== this.decidingVia ? `matched ${hit}${d.globalMatchEntity ? '' : ' on this object'}` : '';
    }
    else if (n.element === 'Action') {
      k = 'Action';
      raw = (d.actions ?? '').replace(/^\[|\]$/g, '');
      v = actionWords(raw);
      words = true;
      why = n.result === false && d.requestedAction ? `requested ${actionWords(d.requestedAction)}` : '';
    }
    else if (n.element === 'TraceRequest' || n.element === 'Access request') { k = 'Nested check'; v = [d.action, d.resource_name || d.resourceId].filter(Boolean).join(' · '); }
    else if (n.element === 'HasAccessTo') { k = 'Needs access'; v = d.reference || d.original || d.left || ''; why = d.action ? `${actionWords(d.action).toLowerCase()} on the related object` : ''; }
    else {
      k = traceLabel(n);
      v = d.left || d.reference || d.original || d.property || '';
      const resolved = d.leftResolved_name || d.leftResolved;
      why = [resolved != null && resolved !== '' ? `is ${resolved}` : '', d.right != null ? `expected ${d.right}` : '', d.roles ? d.roles.replace(/RoleId\[value=([^\]]+)\]/g, '$1') : ''].filter(Boolean).join(' · ');
    }
    if (n.timedOut) why = 'timed out';
    const kids = level < 8 ? n.children : [];
    const nested = n.element === 'HasAccessTo' || n.element === 'TraceRequest';
    const open = kids.length > 0 && this.isOpen(ui, path, !nested && level < 2);
    const value = v ? attrs(el(words ? 'span' : 'code', words ? 'v txt' : 'v', v), { title: raw ? `${v} (${raw})` : v }) : '';
    const head = el('span', 'ow-ac-tg leaf', el('span', `chev${kids.length && !open ? ' closed' : ''}`, kids.length ? icon('i-chev') : ''), st, el('span', 'k', k), value);
    const toggle = kids.length ? attrs(btn('ow-ac-tg leaf', undefined, () => this.toggleRow(ui, path, open)), { 'aria-expanded': String(open), 'data-fk': `p:${path}` }) : head;
    if (kids.length) toggle.append(...head.childNodes);
    const row = attrs(el('div', 'ow-ac-row ui-row leaf', toggle, why ? attrs(el('span', 'why', why), { title: why }) : ''), { role: 'listitem' });
    row.style.setProperty('--d', String(depth));
    const rows = [row];
    if (open) kids.forEach((c, i) => rows.push(...this.predicate(c, `${path}.${i}`, depth + 1, ui, level + 1)));
    if (n.children.length && level >= 8) rows.push(el('div', 'ow-ac-row ui-row leaf ow-quiet', 'Deeper checks are in “Copy as text”.'));
    return rows;
  }

  private traceText(trace: AccessTraceNode, v: Verdict, subject: AccessSubject, node: AccessNodeInfo, verb: string): string {
    const lines = [this.sentence(v, subject, node, verb)];
    lines.push(`Subject: ${subject.kind} ${subject.name}${subject.businessId ? ` (${subject.businessId})` : ''} · RID ${subject.rid}`);
    lines.push(`Node: ${node.typeLabel || node.type} ${node.name}${node.businessId ? ` (${node.businessId})` : ''} · RID ${node.rid}`);
    const walk = (n: AccessTraceNode, depth: number) => {
      const mark = n.timedOut ? '…' : n.result === true ? '✓' : n.result === false ? '✗' : '–';
      const isStmt = n.element === 'Statement';
      // A statement line already names its policy: no policyRid_name again.
      const det = Object.entries(n.details).filter(([k]) => k !== 'numberOfAccessChecks' && !(isStmt && k === 'policyRid_name')).map(([k, x]) => `${k}=${x}`).join(', ');
      lines.push(`${'  '.repeat(depth)}${mark} ${isStmt ? `Statement ${stmtNo(statementRef(n))} · ${statementRef(n).policyName}` : traceLabel(n)}${det ? ` (${det})` : ''}`);
      for (const c of n.children) walk(c, depth + 1);
    };
    for (const c of trace.children) walk(c, 1);
    lines.push(`Evaluated against saved policies on ${this.mode.environmentName || 'the server'}. Write and Add child tested without proposed values.`);
    return lines.join('\n');
  }

  private caveat(node: AccessNodeInfo): HTMLElement {
    const at = this.mode.evaluatedAt;
    const time = at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const link = attrs(btn('ow-ac-link', undefined, () => this.handlers.openTest(node), 'Test with proposed values', icon('i-popout', 'ic-sm')), {
      'data-fk': 'open-test',
      title: 'Open this node in the Access workspace test. Here, Add child names this node as the parent, with no type.',
    });
    const rerun = this.mode.subject && at ? attrs(btn('ow-ac-link', undefined, () => this.mode.rerun(), 'Re-run'), { 'data-fk': 'rerun', title: 'Evaluate every visible node again' }) : null;
    return el('div', 'ow-ac-caveat',
      el('p', '', 'Saved policies on ', b(this.mode.environmentName || 'the connected server'), time ? `, ${time}` : '', rerun ? ' · ' : '', rerun),
      el('p', '', 'Write and Add child are tested without proposed values · ', link));
  }
}
