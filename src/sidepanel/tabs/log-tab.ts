/**
 * Log tab: the activity the worker records, newest first, grouped by day.
 * One row per
 * entry (clock time, result, sentence, duration); a row opens to its
 * technical detail. Filters: Activity / Problems / All, and the server scope.
 */

import { SCRIPT_PAUSE_ACTION, type InspectorMessage, type ActivityEntry } from '../../lib/types';
import { confirmModal } from '../../lib/modal';
import { ACTIVITY_MAX, ACTIVITY_DISPLAY_TIMEOUT } from '../../lib/constants';
import { el, statusFlash } from '../../lib/dom';
import { copyText } from '../../lib/copy-feedback';
import { S } from '../state';
import type { Tab, SendFn } from './tab-types';
import { compactActivityStatus, type WorkStatus } from '../work-status';
import { icon, mountShellSprites } from '../icons';
import { toggleMenu } from '../menu';
import { trimActivity } from '../../lib/activity-policy';
import { emptyState } from '../../lib/empty-state';
import {
  LOG_DISPLAY_CAP, LEVEL_WORD, clockTime, collapseRuns, detailLines, entriesJson, entriesText, entryText,
  errorCount, exportFileName, filterEntries, formatDuration, groupByDay, inScope, markEndedPauses, metaLine, problemCount, readableEntry,
  type EventFilter, type ScopeFilter,
} from './log-model';

const RESULT_ICON: Record<ActivityEntry['level'], string> = {
  success: 's-check', error: 's-xc', warn: 's-warn', info: 's-dot',
};

/** How long a requested entry may take to arrive (a panel that is just opening). */
const REVEAL_WAIT_MS = 10_000;
/** How long the revealed entry stays highlighted. */
const HIGHLIGHT_MS = 4000;

const copied = (n: number) => `Copied ${n} ${n === 1 ? 'entry' : 'entries'}`;

export class LogTab implements Tab {
  private entries: ActivityEntry[] = [];
  private latestMsg: string | null = null;
  private latestTitle: string | null = null;
  private latestWorking = false;
  private latestTimer: ReturnType<typeof setTimeout> | null = null;
  private send: SendFn;
  private onStatusChange: (() => void) | null = null;
  /** This server by default: with several environments the log stays readable. */
  private scope: ScopeFilter = 'this';
  /** User actions are the useful default; diagnostics stay under All. */
  private eventFilter: EventFilter = 'activity';
  /** Entries whose detail is open, keyed by entry id. */
  private expanded = new Set<number>();
  private container: HTMLElement | null = null;
  /** The entry "Show in Log" asked for; applied once it is in the list. */
  private revealId: number | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | null = null;
  /** The entry shown highlighted, for a few seconds. */
  private highlightId: number | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;

  /** Latest activity message (read by status bar in sidepanel) */
  get latestActivityMsg() { return this.latestMsg; }
  get latestActivityTitle() { return this.latestTitle; }
  get isWorking() { return this.latestWorking; }

  constructor(send: SendFn) {
    this.send = send;
  }

  /** Register callback for when activity status changes (message arrives or 3s timeout clears it) */
  onActivityChange(cb: () => void) { this.onStatusChange = cb; }

  showWorkStatus(status: WorkStatus): void {
    this.latestMsg = status.text;
    this.latestTitle = status.title ?? status.text;
    this.latestWorking = status.working;
    if (this.latestTimer) clearTimeout(this.latestTimer);
    // A running request gets a longer safety window so a missing completion
    // cannot leave stale UI forever. Settled feedback stays only briefly.
    this.latestTimer = setTimeout(() => {
      this.latestMsg = null;
      this.latestTitle = null;
      this.latestWorking = false;
      this.onStatusChange?.();
    }, status.working ? 12_000 : ACTIVITY_DISPLAY_TIMEOUT);
    this.onStatusChange?.();
  }

  /** Open the entry, bring it into view and highlight it. If the entry has
   *  not arrived yet (the panel just opened), this waits for it. */
  reveal(id: number): void {
    this.revealId = id;
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => { this.revealId = null; }, REVEAL_WAIT_MS);
  }

  private applyReveal(): void {
    const id = this.revealId;
    const container = this.container;
    if (id == null || !container) return;
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    this.revealId = null;
    if (this.revealTimer) clearTimeout(this.revealTimer);
    // A filter that hides the entry would make the link land nowhere.
    if (!filterEntries([entry], this.filterOptions()).length) {
      this.eventFilter = 'all';
      this.scope = 'all';
    }
    this.expanded.add(id);
    this.highlightId = id;
    this.render(container);
    const row = container.querySelector<HTMLElement>(`.lg-row[data-key="${id}"]`);
    row?.scrollIntoView?.({ block: 'center' });
    row?.focus({ preventScroll: true });
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlightId = null;
      this.container?.querySelector('.lg-item.revealed')?.classList.remove('revealed');
    }, HIGHLIGHT_MS);
  }

  activate() {
    this.send({ type: 'GET_ACTIVITY' });
  }

  deactivate() {
    // no cleanup needed
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'ACTIVITY_LOG':
        this.entries = markEndedPauses(msg.entries.map(readableEntry));
        return true;
      case 'ACTIVITY_ENTRY': {
        // A merged repeat arrives again with its id: it replaces the earlier copy.
        const entry = readableEntry(msg.entry);
        const at = this.entries.findIndex(e => e.id === entry.id);
        if (at >= 0) this.entries.splice(at, 1);
        this.entries.push(entry);
        trimActivity(this.entries, ACTIVITY_MAX);
        // A resume line ends the script pause of its server.
        this.entries = markEndedPauses(this.entries);
        // A warning or error opens at once so BMP's execution log is visible
        // without another click; routine successes stay closed.
        if (msg.entry.detail && (msg.entry.level === 'warn' || msg.entry.level === 'error')) {
          this.expanded.add(msg.entry.id);
        }
        this.showWorkStatus(compactActivityStatus(entry));
        return true;
      }
      default:
        return false;
    }
  }

  private filterOptions() {
    return {
      event: this.eventFilter,
      scope: this.scope,
      activeProfileId: S.settings.activeProfileId,
      profileCount: S.settings.profiles.length,
    };
  }

  /** The entries the current filter and scope select (all of them, not only the shown rows). */
  matchingEntries(): ActivityEntry[] {
    return filterEntries(this.entries, this.filterOptions());
  }

  /** The server's name, only when several servers make it worth saying. */
  private profileLabel = (id: string): string | undefined =>
    S.settings.profiles.length > 1 ? S.settings.profiles.find(p => p.id === id)?.label : undefined;

  render(container: HTMLElement) {
    this.container = container;
    mountShellSprites(container.ownerDocument);
    // Re-renders replace the DOM; keep keyboard focus on the same control.
    const active = container.ownerDocument.activeElement as HTMLElement | null;
    const keep = active && container.contains(active) ? active.closest<HTMLElement>('[data-fk]')?.dataset.fk ?? null : null;
    const opts = this.filterOptions();
    const matching = filterEntries(this.entries, opts);
    const shown = matching.slice(-LOG_DISPLAY_CAP);
    const groups = groupByDay(collapseRuns(shown), Date.now());
    const problems = problemCount(this.entries, opts);
    const errors = errorCount(this.entries, opts);

    const root = el('div', 'lg ui');
    root.append(this.renderTools(problems, errors, matching.length));

    if (!groups.length) {
      root.append(this.renderEmpty());
    } else {
      // The duration column exists only when a row in view has a duration.
      const list = el('div', `lg-list${shown.some(e => e.durationMs != null) ? '' : ' nodur'}`);
      for (const g of groups) {
        const band = el('div', 'ui-band lg-day', el('span', 't', g.label), el('span', 'n', String(g.rows.reduce((n, r) => n + r.count, 0))));
        list.append(band);
        for (const { entry, count } of g.rows) list.append(this.renderEntry(entry, count));
      }
      root.append(list);
      if (matching.length > shown.length) {
        root.append(el('div', 'lg-more', `Latest ${shown.length} of ${matching.length} entries`));
      }
    }

    container.replaceChildren(root);
    this.wire(root);
    if (keep) this.focusKey(keep);
    this.applyReveal();
  }

  private focusKey(key: string): void {
    const target = this.container?.querySelector<HTMLElement>(`[data-fk="${key.replace(/"/g, '')}"]`)
      ?? this.container?.querySelector<HTMLElement>('[data-fk="filter:' + this.eventFilter + '"]');
    target?.focus();
  }

  private renderTools(problems: number, errors: number, matching: number): HTMLElement {
    const seg = el('div', 'lg-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Show');
    const segBtn = (value: EventFilter, label: string, count?: number) => {
      const b = el('button', '', label) as HTMLButtonElement;
      b.type = 'button';
      b.dataset.eventFilter = value;
      b.dataset.fk = `filter:${value}`;
      b.setAttribute('aria-pressed', String(this.eventFilter === value));
      if (count) {
        // Danger colour only when something actually failed.
        const c = el('span', `lg-cnt${errors ? ' err' : ''}`, String(count));
        b.append(c);
        b.setAttribute('aria-label', `${label}, ${count}`);
      }
      return b;
    };
    seg.append(segBtn('activity', 'Activity'), segBtn('problems', 'Problems', problems), segBtn('all', 'All'));

    const tools = el('div', 'lg-tools', seg, el('span', 'lg-sp'));
    if (S.settings.profiles.length > 1) {
      const label = this.scope === 'this' ? 'This server' : 'All servers';
      const scope = el('button', 'ui-tbtn lg-scope', icon('s-globe', 'ic-sm lg-scope-ic'), el('span', 'lg-scope-t', label), icon('i-chev', 'ic-sm')) as HTMLButtonElement;
      scope.type = 'button';
      scope.dataset.act = 'scope';
      scope.dataset.fk = 'scope';
      scope.setAttribute('aria-label', `Entries from: ${label}`);
      scope.title = 'Show entries from this server or from all servers';
      scope.setAttribute('aria-haspopup', 'menu');
      scope.setAttribute('aria-expanded', 'false');
      tools.append(scope);
    }
    const exp = el('button', 'ui-ibtn lg-export', icon('i-copy')) as HTMLButtonElement;
    exp.type = 'button';
    exp.dataset.act = 'export';
    exp.dataset.fk = 'export';
    if (!matching) {
      exp.disabled = true;
      exp.title = 'Nothing to copy or save';
    }
    if (matching) exp.title = 'Copy or save the entries this filter shows';
    exp.setAttribute('aria-label', 'Copy or save entries');
    exp.setAttribute('aria-haspopup', 'menu');
    exp.setAttribute('aria-expanded', 'false');
    tools.append(exp);
    return tools;
  }

  private renderEmpty(): HTMLElement {
    const inView = inScope(this.entries, this.filterOptions()).length;
    const [title, hint] = this.eventFilter === 'problems'
      ? ['No problems', 'Failures and warnings appear here.']
      : this.eventFilter === 'all'
        ? ['Nothing logged yet', 'Saves, runs, errors and connection events appear here.']
        : ['Nothing in Activity yet', 'Saves, EC runs, Blueprint applies and Studio changes appear here.'];
    const text: Array<string | HTMLElement> = [hint];
    if (this.eventFilter !== 'all' && inView) {
      text.push(` ${inView} background ${inView === 1 ? 'event' : 'events'} hidden. `);
      const link = el('button', 'lg-lnk', 'Show all events') as HTMLButtonElement;
      link.type = 'button';
      link.dataset.eventFilter = 'all';
      text.push(link);
    }
    return emptyState({ title, text, art: 'sm', className: 'lg-empty' });
  }

  private renderEntry(entry: ActivityEntry, count: number): HTMLElement {
    const open = this.expanded.has(entry.id);
    const ended = entry.endedAt != null;
    const item = el('div', `lg-item ${entry.level}${ended ? ' ended' : ''}${open ? ' open' : ''}${entry.id === this.highlightId ? ' revealed' : ''}`);
    const row = el('div', 'lg-row');
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(open));
    row.dataset.key = String(entry.id);
    row.dataset.fk = `row:${entry.id}`;
    row.title = entry.message;

    const result = el('span', `lg-r ${entry.level}`, icon(RESULT_ICON[entry.level], 'ic-sm'));
    result.title = LEVEL_WORD[entry.level];
    const sr = el('span', 'sr-only', `${LEVEL_WORD[entry.level]}: `);
    const msg = el('span', 'lg-m', sr, el('span', 'lg-mt', entry.message));
    if (count > 1) msg.append(' ', el('span', 'lg-rep', el('span', '', `×${count}`), el('span', 'sr-only', ` (${count} times)`)));
    // No earlier Log entry has a resolved form: an ended one says when, muted.
    if (ended) msg.append(' ', el('span', 'lg-end', `ended ${clockTime(entry.endedAt!)}`));
    row.append(
      el('span', 'lg-t', clockTime(entry.time)),
      result,
      msg,
      el('span', 'lg-d', formatDuration(entry.durationMs)),
    );
    item.append(row);

    if (open) {
      const detail = el('div', 'lg-detail');
      const meta = metaLine(entry, this.profileLabel);
      if (meta) detail.append(el('div', 'lg-meta', meta));
      if (entry.detail) detail.append(el('pre', 'lg-pre', detailLines(entry.detail).join('\n')));
      const copy = el('button', 'ui-tbtn lg-copy', icon('i-copy', 'ic-sm'), 'Copy detail') as HTMLButtonElement;
      copy.type = 'button';
      copy.dataset.act = 'copy-entry';
      copy.dataset.key = String(entry.id);
      copy.dataset.fk = `copy:${entry.id}`;
      detail.append(copy);
      // The script pause: the count is an estimate; after a restart Companion
      // did not see, the user can start it again for this server.
      if (entry.action === SCRIPT_PAUSE_ACTION && entry.profileId && !ended) {
        const reset = el('button', 'ui-tbtn lg-reset-scripts', 'Server was restarted') as HTMLButtonElement;
        reset.type = 'button';
        reset.dataset.act = 'reset-scripts';
        reset.dataset.key = String(entry.id);
        reset.dataset.fk = `reset:${entry.id}`;
        detail.append(reset);
      }
      item.append(detail);
    }
    return item;
  }

  private wire(root: HTMLElement): void {
    const rerender = () => { if (this.container) this.render(this.container); };
    const toggle = (key: string | undefined, focus: boolean) => {
      const id = Number(key);
      if (!Number.isFinite(id)) return;
      if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
      rerender();
      if (focus) this.container?.querySelector<HTMLElement>(`.lg-row[data-key="${id}"]`)?.focus();
    };

    root.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const filter = t.closest<HTMLElement>('[data-event-filter]');
      if (filter) {
        const next = filter.dataset.eventFilter as EventFilter;
        if (next !== this.eventFilter) { this.eventFilter = next; rerender(); }
        this.focusKey(`filter:${next}`);
        return;
      }
      const act = t.closest<HTMLElement>('[data-act]');
      if (act?.dataset.act === 'scope') { this.openScopeMenu(act); return; }
      if (act?.dataset.act === 'export') { this.openExportMenu(act); return; }
      if (act?.dataset.act === 'reset-scripts') {
        const entry = this.entries.find(e => e.id === Number(act.dataset.key));
        if (entry?.profileId) void this.resetScripts(entry.profileId);
        return;
      }
      if (act?.dataset.act === 'copy-entry') {
        const entry = this.entries.find(e => e.id === Number(act.dataset.key));
        if (entry) void this.copy(entryText(entry, this.profileLabel), 'Copied');
        return;
      }
      if (t.closest('.lg-detail')) return; // text selection inside the detail
      const row = t.closest<HTMLElement>('.lg-row');
      if (row) toggle(row.dataset.key, false);
    });
    root.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = (ev.target as HTMLElement).closest<HTMLElement>('.lg-row');
      if (!row || ev.target !== row) return;
      ev.preventDefault();
      toggle(row.dataset.key, true);
    });
  }

  /** "Server was restarted": after one confirm, that server's script count
   *  starts again (RESET_SCRIPT_COUNT, that profile's server only). */
  private async resetScripts(profileId: string): Promise<void> {
    const profile = S.settings.profiles.find(p => p.id === profileId);
    const server = profile?.label || profile?.bmpUrl || 'this server';
    const ok = await confirmModal({
      title: 'Server was restarted',
      body: `Reset the count for ${server}? Use this only if the server was restarted.`,
      confirmLabel: 'Reset count',
    });
    if (ok) this.send({ type: 'RESET_SCRIPT_COUNT', profileId });
  }

  private openScopeMenu(anchor: HTMLElement): void {
    const pick = (scope: ScopeFilter) => () => {
      if (scope === this.scope) return;
      this.scope = scope;
      if (this.container) this.render(this.container);
      this.focusKey('scope');
    };
    toggleMenu({
      anchor, label: 'Servers', align: 'end',
      items: [
        { label: 'This server', checked: this.scope === 'this', onSelect: pick('this') },
        { label: 'All servers', checked: this.scope === 'all', onSelect: pick('all') },
      ],
    });
  }

  private openExportMenu(anchor: HTMLElement): void {
    const entries = this.matchingEntries();
    toggleMenu({
      anchor, label: 'Copy or save', align: 'end',
      items: [
        { label: 'Copy as text', iconId: 'i-copy', onSelect: () => { this.focusKey('export'); void this.copy(entriesText(entries, this.profileLabel), copied(entries.length)); } },
        { label: 'Copy as JSON', iconId: 'i-copy', onSelect: () => { this.focusKey('export'); void this.copy(entriesJson(entries), copied(entries.length)); } },
        { label: 'Save as .json', iconId: 's-download', onSelect: () => { this.focusKey('export'); this.save(entries); } },
      ],
    });
  }

  private async copy(text: string, done: string): Promise<void> {
    statusFlash(await copyText(text) ? done : 'Copy failed');
  }

  private save(entries: ActivityEntry[]): void {
    const name = exportFileName(Date.now());
    const url = URL.createObjectURL(new Blob([entriesJson(entries)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    statusFlash(`Saved ${name}`);
  }
}
