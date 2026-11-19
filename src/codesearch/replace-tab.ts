/**
 * The Replace tab of the code search window: find text, type what to put in
 * its place, untick what should stay, and save once.
 *
 * The matches come from the window's copy of the server's code (the same
 * copy the search reads), planned by lib/code-replace. Nothing is sent to the
 * server until the user confirms; then each script is read again, parsed on
 * the server and saved like a save in the editor (lib/code-replace
 * `applyReplace`), and the result says what happened to each object. The last
 * replace of a server is kept (lib/code-replace-port `replaceRecords`) so
 * Undo works after the window was closed.
 *
 * Scripts an instance inherits from its template are written once, to the
 * template: the copy keeps only an instance's own code (code-index-store).
 */

import { el, btn, icon, attrs, type Kid } from '../lib/dom';
import { emptyState } from '../lib/empty-state';
import type { EscapeLayer } from '../lib/escape-layers';
import { propLabel } from '../lib/object-window-table';
import { inWhere } from '../lib/code-search';
import type { IndexedObject } from '../lib/code-index-store';
import {
  applyReplace, buildReplaceRecord, changeButtonText, changesOf, changesText, confirmQuestion, objectSummary, planReplace, recordAfterUndo,
  startsTicked, undoReplace, UNDONE_CHANGED,
  type ReplaceMatch, type ReplacePlan, type ReplaceRecord, type ReplaceScript, type ScriptPlan, type ScriptResult,
} from '../lib/code-replace';
import { messageReplacePort, replaceRecords } from '../lib/code-replace-port';
import { fmt, plural, type Filters } from './search-model';

export interface ReplaceHost {
  /** The objects of the copy (null until loaded). */
  objects(): readonly IndexedObject[] | null;
  load(): Promise<void>;
  /** The copy can be searched. */
  copyReady(): boolean;
  environment(): string | undefined;
  /** The page under the window belongs to another server: nothing is written. */
  blocked(): boolean;
  query(): string;
  options(): { caseSensitive: boolean; wholeWord: boolean; regex: boolean };
  filters(): Filters;
  scopeRids(): ReadonlySet<string> | undefined;
  tile(type: string): HTMLElement;
  typeLabel(type: string): string;
  /** Draw the window again. */
  render(): void;
  openEditor(rid: string, prop: string, line?: number): void;
  keepCopy(): void;
  announce(text: string): void;
  /** Register a layer Escape closes (the window's escape layers). */
  escape(layer: EscapeLayer): void;
}

export interface ReplaceTab {
  /** The replace field, for the query area. */
  field: HTMLElement;
  /** Fill the fields from outside (the activation of the window). */
  set(replace: string | undefined): void;
  /** The find text, the options, the filters or the copy changed. */
  invalidate(): void;
  renderSummary(sum: HTMLElement): void;
  renderResults(res: HTMLElement): void;
  /** Facts for the status bar, before the copy's own. */
  facts(): Kid[];
  /** The result of a replace or an undo is on screen, not a list to edit. */
  showsResult(): boolean;
  /** Leave the result and show the list again. */
  leaveResult(): void;
  /** The server this window works on is known: read its record. */
  environmentKnown(): void;
  focusField(): void;
}

interface Group {
  rid: string;
  obj: IndexedObject;
  scripts: ScriptPlan[];
  matches: number;
  /** Instances that inherit one of these scripts. */
  instances: number;
}

type Phase = 'edit' | 'running' | 'result';

const stamp = (d: Date) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const objName = (o: { name?: string; businessId?: string; rid: string }) => o.name || o.businessId || o.rid;
const FIRST_OPEN = 40;

export function createReplaceTab(host: ReplaceHost): ReplaceTab {
  let replaceText = '';
  /** The replace field was used (an empty one then means "delete the text"). */
  let touched = false;
  let plan: ReplacePlan | null = null;
  let groups: Group[] = [];
  let planKey = '';
  let planObjects: readonly IndexedObject[] | null = null;
  const override = new Map<string, boolean>();
  const collapsed = new Set<string>();
  let phase: Phase = 'edit';
  let outcome: { kind: 'replace' | 'undo'; results: ScriptResult[]; total: number; at: Date } | null = null;
  let record: ReplaceRecord | null = null;
  let recordEnv = '';
  let dialog: HTMLElement | null = null;
  let timer = 0;

  // ── the replace field ───────────────────────────────────────────

  const input = attrs(el('input', 'cs-q') as HTMLInputElement, {
    type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Replace with', placeholder: 'Replace with',
  });
  input.addEventListener('input', () => {
    replaceText = input.value;
    touched = true;
    if (phase === 'result') leaveResult(); else invalidate();
  });
  const field = el('div', 'cs-fld ui-search rp-fld', icon('i-swap'), input);

  function set(replace: string | undefined): void {
    if (replace === undefined) return;
    replaceText = replace;
    touched = true;
    input.value = replace;
  }

  const queryNow = () => ({ find: host.query(), replace: replaceText, ...host.options() });

  // ── the plan ────────────────────────────────────────────────────

  function invalidate(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void compute(); }, 100);
  }

  async function compute(): Promise<void> {
    if (phase !== 'edit') return;
    const q = queryNow();
    if (!host.copyReady() || !q.find.trim()) { plan = null; groups = []; planKey = ''; host.render(); return; }
    // The copy as it is now (a no-op when it was read already).
    await host.load();
    const objs = host.objects();
    if (!objs || phase !== 'edit') return;
    const f = host.filters();
    const scope = host.scopeRids();
    const key = JSON.stringify([q.find, q.caseSensitive, q.wholeWord, q.regex, f, scope?.size ?? -1]);
    if (key !== planKey || objs !== planObjects) { override.clear(); collapsed.clear(); }
    const types = f.types.length ? new Set(f.types) : null;
    const props = f.props.length ? new Set(f.props) : null;
    const scripts: ReplaceScript[] = [];
    const meta = new Map<string, IndexedObject>();
    const inherit = new Map<string, number>();
    // Own code only: an instance's inherited code is its template's script.
    for (const o of objs) {
      for (const p of o.inherits ?? []) if (o.tmpl) inherit.set(`${o.tmpl}|${p}`, (inherit.get(`${o.tmpl}|${p}`) ?? 0) + 1);
      if (scope && !scope.has(o.rid)) continue;
      if (types && !types.has(o.type)) continue;
      if (f.where.length && !inWhere(o, f.where)) continue;
      for (const p of Object.keys(o.code)) {
        if (props && !props.has(p)) continue;
        scripts.push({ rid: o.rid, prop: p, text: o.code[p] });
        meta.set(o.rid, o);
      }
    }
    const next = planReplace(scripts, q);
    const byRid = new Map<string, Group>();
    for (const s of next.scripts) {
      const g = byRid.get(s.rid) ?? { rid: s.rid, obj: meta.get(s.rid)!, scripts: [], matches: 0, instances: 0 };
      g.scripts.push(s);
      g.matches += s.matches.length;
      g.instances += inherit.get(`${s.rid}|${s.prop}`) ?? 0;
      byRid.set(s.rid, g);
    }
    groups = [...byRid.values()].sort((a, b) => b.matches - a.matches || objName(a.obj).localeCompare(objName(b.obj)) || a.rid.localeCompare(b.rid));
    if (key !== planKey || objs !== planObjects) groups.slice(FIRST_OPEN).forEach(g => collapsed.add(g.rid));
    plan = next;
    planKey = key;
    planObjects = objs;
    host.render();
  }

  const isOn = (m: ReplaceMatch): boolean => override.get(m.id) ?? startsTicked(m, plan?.reference ?? false);
  const tickedCount = (): number => groups.reduce((n, g) => n + g.scripts.reduce((k, s) => k + s.matches.filter(isOn).length, 0), 0);
  const tickedObjects = (): number => groups.filter(g => g.scripts.some(s => s.matches.some(isOn))).length;

  function setMatches(list: readonly ReplaceMatch[], on: boolean): void {
    for (const m of list) {
      if (startsTicked(m, plan?.reference ?? false) === on) override.delete(m.id); else override.set(m.id, on);
    }
    host.render();
  }

  const groupMatches = (g: Group): ReplaceMatch[] => g.scripts.flatMap(s => s.matches);

  // ── the change ──────────────────────────────────────────────────

  const canChange = (): boolean => phase === 'edit' && !!plan && !plan.problem && tickedCount() > 0 && touched && !host.blocked();

  function askChange(): void {
    if (!canChange()) return;
    const q = queryNow();
    openDialog({
      title: confirmQuestion(tickedCount(), tickedObjects()),
      old: q.find, next: q.replace, confirm: 'Save',
      onConfirm: () => { void change(); },
    });
  }

  async function change(): Promise<void> {
    if (!plan) return;
    const q = queryNow();
    const byRid = new Map(groups.map(g => [g.rid, g.obj]));
    // In the order of the list.
    const order = new Map(groups.map((g, i) => [g.rid, i]));
    const changes = changesOf(plan, isOn, rid => {
      const o = byRid.get(rid)!;
      return { type: o.type, name: o.name, businessId: o.businessId };
    }).sort((a, b) => (order.get(a.rid) ?? 0) - (order.get(b.rid) ?? 0));
    if (!changes.length) return;
    phase = 'running';
    outcome = { kind: 'replace', results: [], total: changes.length, at: new Date() };
    host.render();
    const port = messageReplacePort(host.environment());
    const results = await applyReplace(changes, port, {
      onResult: r => { outcome?.results.push(r); host.render(); },
    });
    phase = 'result';
    outcome = { kind: 'replace', results, total: changes.length, at: new Date() };
    const env = host.environment();
    const rec = env ? buildReplaceRecord(env, q, results) : null;
    if (rec) { record = rec; recordEnv = rec.environment; await replaceRecords.save(rec); }
    const s = objectSummary(results);
    host.announce(`${s.saved} saved${s.notSaved ? `, ${s.notSaved} not saved` : ''}.`);
    host.render();
  }

  // ── the undo ────────────────────────────────────────────────────

  function askUndo(): void {
    if (!record || phase === 'running' || host.blocked()) return;
    const rec = record;
    openDialog({
      title: `Undo the replace of ${stamp(new Date(rec.at))}?`,
      old: rec.replace, next: rec.find, confirm: 'Undo',
      note: `Puts back ${plural(rec.scripts.length, 'script')} as ${rec.scripts.length === 1 ? 'it was' : 'they were'}. A script that changed on the server since is left as it is.`,
      onConfirm: () => { void undo(rec); },
    });
  }

  async function undo(rec: ReplaceRecord): Promise<void> {
    phase = 'running';
    outcome = { kind: 'undo', results: [], total: rec.scripts.length, at: new Date() };
    host.render();
    const results = await undoReplace(rec, messageReplacePort(host.environment()), {
      onResult: r => { outcome?.results.push(r); host.render(); },
    });
    phase = 'result';
    outcome = { kind: 'undo', results, total: rec.scripts.length, at: new Date() };
    const rest = recordAfterUndo(rec, results);
    record = rest;
    if (rest) await replaceRecords.save(rest); else await replaceRecords.clear(rec.environment);
    const s = objectSummary(results);
    host.announce(`${s.saved} restored${s.notSaved ? `, ${s.notSaved} left as they are` : ''}.`);
    host.render();
  }

  function leaveResult(): void {
    if (phase !== 'result') return;
    phase = 'edit';
    outcome = null;
    planKey = '';
    void compute();
  }

  function environmentKnown(): void {
    const env = host.environment();
    if (!env || env === recordEnv) return;
    recordEnv = env;
    void replaceRecords.load(env).then(r => { record = r; host.render(); });
  }

  // ── the confirmation ────────────────────────────────────────────

  host.escape({ kind: 'dialog', name: 'replace-confirm', isOpen: () => !!dialog, close: () => { closeDialog(); }, phase: 'capture' });

  function openDialog(o: { title: string; old: string; next: string; confirm: string; note?: string; onConfirm: () => void }): void {
    closeDialog();
    const cancel = btn('ui-btn', undefined, () => closeDialog(), 'Cancel');
    const ok = btn('ui-btn primary', undefined, () => { closeDialog(); o.onConfirm(); }, o.confirm);
    const lines = el('div', 'rp-chg',
      el('div', '', el('del', '', o.old)),
      el('div', '', o.next ? el('ins', '', o.next) : el('span', 'rp-none', '(nothing)')));
    const dlg = attrs(el('div', 'rp-dlg', el('h2', '', o.title), lines, o.note ? el('p', 'rp-note', o.note) : '', el('div', 'rp-acts', cancel, ok)), {
      role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title,
    });
    dialog = el('div', 'rp-scrim', dlg);
    dialog.addEventListener('mousedown', e => { if (e.target === dialog) closeDialog(); });
    // Inside the window's root, which carries the shared styles.
    (document.querySelector('.cs') ?? document.body).append(dialog);
    ok.focus();
  }

  function closeDialog(): void {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    input.focus();
  }

  // ── drawing: summary ────────────────────────────────────────────

  function renderSummary(sum: HTMLElement): void {
    sum.hidden = false;
    sum.classList.add('rp-sum');
    const kids: Kid[] = [];
    if (phase === 'running' && outcome) {
      kids.push(el('span', '', el('b', '', `${outcome.kind === 'undo' ? 'Putting back' : 'Saving'} ${fmt(Math.min(outcome.results.length + 1, outcome.total))} of ${fmt(outcome.total)}…`)));
    } else if (phase === 'result' && outcome) {
      const s = objectSummary(outcome.results);
      const word = outcome.kind === 'undo' ? ['restored', 'left as it is'] : ['saved', 'not saved'];
      kids.push(el('span', '', el('b', '', `${fmt(s.saved)} ${word[0]}`)));
      if (s.notSaved) kids.push(el('span', 'rp-bad', el('b', '', `${fmt(s.notSaved)} ${word[1]}`)));
      kids.push(el('span', 'grow'));
      // Undo is for what this replace saved (the record is its own).
      if (outcome.kind === 'replace' && record && outcome.results.some(r => r.status === 'saved')) kids.push(btn('ui-btn', undefined, askUndo, 'Undo'));
    } else if (plan && plan.matches) {
      kids.push(el('span', '', el('b', '', `${fmt(plan.matches)} ${plan.matches === 1 ? 'match' : 'matches'}`), ` in ${plural(groups.length, 'object')}`));
      kids.push(el('span', 'grow'));
      const b = btn('ui-btn primary', undefined, askChange, changeButtonText(tickedCount()));
      b.disabled = !canChange();
      b.title = !touched ? 'Type what to put in its place' : host.blocked() ? 'The page belongs to another server' : tickedCount() === 0 ? 'Nothing is ticked' : '';
      kids.push(b);
    } else {
      sum.hidden = true;
      sum.replaceChildren();
      return;
    }
    sum.replaceChildren(...kids.filter((k): k is Node | string => !!k));
  }

  // ── drawing: results ────────────────────────────────────────────

  function cbox(state: 'on' | 'off' | 'mix', label: string, onClick: () => void): HTMLButtonElement {
    const b = btn(`rp-cb${state === 'off' ? '' : ' on'}`, undefined, e => { e.stopPropagation(); onClick(); },
      state === 'on' ? icon('i-check', 'ic-sm') : state === 'mix' ? icon('i-dash', 'ic-sm') : '');
    attrs(b, { role: 'checkbox', 'aria-checked': state === 'mix' ? 'mixed' : String(state === 'on'), 'aria-label': label });
    b.removeAttribute('title');
    return b;
  }

  /** The line of a match with the old text struck through and the new beside it. */
  function lineCell(m: ReplaceMatch, on: boolean): HTMLElement {
    const lead = m.lineText.length - m.lineText.trimStart().length;
    const cut = Math.min(lead, m.from);
    const before = m.lineText.slice(cut, m.from);
    const after = m.lineText.slice(m.to).replace(/\s+$/, '');
    const b = before.length > 64 ? `…${before.slice(-60)}` : before;
    const a = after.length > 96 ? `${after.slice(0, 92)}…` : after;
    return el('span', 'cc', b, el('del', '', m.old), on && m.replacement ? el('ins', '', m.replacement) : '', a);
  }

  function matchRow(m: ReplaceMatch, g: Group): HTMLElement {
    const on = isOn(m);
    const tag = plan?.reference && m.kind !== 'code' ? m.kind : '';
    const row = el('div', `rp-ml${on ? '' : ' off'}`,
      cbox(on ? 'on' : 'off', `Line ${m.line}${tag ? `, in a ${tag}` : ''}`, () => setMatches([m], !on)),
      el('span', 'ln', String(m.line)), lineCell(m, on), el('span', 'tag', tag));
    row.addEventListener('click', () => setMatches([m], !on));
    row.dataset.rid = g.rid;
    return row;
  }

  function groupNodes(g: Group): Node[] {
    const all = groupMatches(g);
    const n = all.filter(isOn).length;
    const closed = collapsed.has(g.rid);
    const head = attrs(el('div', 'rp-gh',
      cbox(n === 0 ? 'off' : n === all.length ? 'on' : 'mix', `${objName(g.obj)}: ${n} of ${all.length}`, () => setMatches(all, n !== all.length)),
      icon('i-chev', `chev${closed ? ' closed' : ''}`), host.tile(g.obj.type),
      el('span', 'nm', objName(g.obj), g.obj.businessId ? el('span', 'ui-id', g.obj.businessId) : '',
        g.instances ? attrs(el('span', 'rp-inh', `used by ${plural(g.instances, 'instance')}`), { title: 'Their code is this one: it is changed here, once' }) : ''),
      el('span', 'ct', n === all.length ? fmt(all.length) : `${fmt(n)} of ${fmt(all.length)}`)), {
      'aria-expanded': String(!closed), title: `${host.typeLabel(g.obj.type)} · ${g.obj.where}`,
    });
    head.addEventListener('click', () => { if (collapsed.has(g.rid)) collapsed.delete(g.rid); else collapsed.add(g.rid); host.render(); });
    const out: Node[] = [head];
    if (closed) return out;
    for (const s of g.scripts) {
      if (g.scripts.length > 1) out.push(el('div', 'rp-ph', propLabel(s.prop)));
      for (const m of s.matches) out.push(matchRow(m, g));
    }
    return out;
  }

  function resultRows(): Node[] {
    if (!outcome) return [];
    const multi = new Map<string, number>();
    for (const r of outcome.results) multi.set(r.rid, (multi.get(r.rid) ?? 0) + 1);
    const undo = outcome.kind === 'undo';
    const rows = [...outcome.results].sort((a, b) => Number(a.status === 'saved') - Number(b.status === 'saved'));
    const out: Node[] = [];
    for (const r of rows) {
      const ok = r.status === 'saved';
      const status = ok ? (undo ? 'Restored' : changesText(r.changes)) : (undo ? 'Left as it is' : 'Not saved');
      out.push(el('div', `rp-rs${ok ? '' : ' bad'}`,
        icon(ok ? 'i-ok' : 'i-no', ok ? 'ok' : 'no'), host.tile(r.type),
        el('span', 'nm', r.name || r.businessId || r.rid, r.businessId ? el('span', 'ui-id', r.businessId) : '',
          (multi.get(r.rid) ?? 0) > 1 ? el('span', 'ui-id', propLabel(r.prop)) : ''),
        el('span', 'st', status)));
      const message = ok ? '' : undo && r.status === 'changed' ? UNDONE_CHANGED : r.message ?? '';
      if (message) {
        const line = /\bline (\d+)/.exec(message)?.[1];
        out.push(el('div', 'rp-err', el('div', 'msg', message),
          btn('cs-link', `Open ${propLabel(r.prop)} in the editor`, () => host.openEditor(r.rid, r.prop, line ? Number(line) : undefined), 'Open')));
      } else if (ok && r.message) {
        out.push(el('div', 'rp-sub', r.message));
      }
    }
    if (phase === 'running' && outcome.results.length < outcome.total) out.push(el('div', 'cs-quiet', 'Reading each script again before it is saved…'));
    return out;
  }

  function renderResults(res: HTMLElement): void {
    res.classList.remove('stale');
    const top = res.scrollTop;
    const kids: Node[] = [];
    if (phase !== 'edit') {
      kids.push(...resultRows());
    } else if (!host.copyReady()) {
      kids.push(emptyState({
        title: 'Replace works on a copy of this server\'s code', titleTag: 'h3', className: 'cs-empty',
        text: 'It changes what the copy lists and checks each script on the server again before saving it.',
        actions: btn('ui-btn primary', undefined, () => host.keepCopy(), 'Keep a copy on this computer'),
      }));
    } else if (!host.query().trim()) {
      kids.push(emptyState({
        title: 'Replace in Extended Code', titleTag: 'h3', className: 'cs-empty', art: record ? false : 'md',
        text: 'Find text, type what to put in its place, untick what should stay, and save once. Every script is read again and checked on the server before it is saved.',
      }));
    } else if (plan?.problem) {
      // A pattern that is not valid is said at the find field.
    } else if (plan && !plan.matches) {
      kids.push(emptyState({ title: 'No matches', titleTag: 'h3', className: 'cs-empty', art: false, text: 'Nothing to change with these options.' }));
    } else if (plan) {
      for (const g of groups) kids.push(...groupNodes(g));
    }
    res.replaceChildren(...kids);
    res.scrollTop = top;
  }

  // ── status bar ──────────────────────────────────────────────────

  function facts(): Kid[] {
    if (phase === 'result' && outcome) return [el('span', 'cov', `${outcome.kind === 'undo' ? 'Restored' : 'Saved'} ${stamp(outcome.at)}`)];
    if (phase === 'edit' && record) {
      return [el('span', 'cov', `Last replace ${stamp(new Date(record.at))}`), btn('cs-link', 'Put the texts of the last replace back', askUndo, 'Undo')];
    }
    return [];
  }

  return {
    field, set, invalidate, renderSummary, renderResults, facts,
    showsResult: () => phase === 'result',
    leaveResult,
    environmentKnown,
    focusField: () => input.focus(),
  };
}
