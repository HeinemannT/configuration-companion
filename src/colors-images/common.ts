/**
 * Shared by the two tabs: what a tab gets from the page, the dated "Read"
 * line with its Refresh control, and the one confirm bar that lists what a
 * save will add or change.
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

export interface ConfirmRow {
  /** The lead: the two swatches or thumbnails of the change. */
  lead: Node;
  name: string;
  detail: string;
  /** The whole line, for a row that is cut short. */
  title?: string;
  /** Said under the row's name in the error colour. */
  problem?: string;
}

export interface ConfirmProps {
  title: string;
  rows: ConfirmRow[];
  /** Said beside the buttons (what the change reaches). */
  note?: string;
  /** Said above the rows (left out, too large …). */
  skipped?: string;
  error?: string;
  saving: boolean;
  canSave: boolean;
  cancelLabel?: string;
  onSave(): void;
  onCancel(): void;
}

/** Draw the confirm bar into `host`, or empty it when there are no rows. */
export function drawConfirmBar(host: HTMLElement, p: ConfirmProps | null): void {
  host.replaceChildren();
  host.hidden = !p;
  if (!p) return;
  const list = el('div', 'ci-prows', ...p.rows.map(r => attrs(el('div', 'ci-prow', el('span', 'ci-pair', r.lead), el('span', 'ci-pname', r.name), el('span', `ci-pdetail${r.problem ? ' bad' : ''}`, r.problem ?? r.detail)), { title: r.title ?? `${r.name}  ${r.detail}` })));
  const left = el('div', 'ci-confirm-l', el('div', 'ci-confirm-h', p.title), list);
  if (p.skipped) left.insertBefore(el('div', 'ci-confirm-skip', p.skipped), list);
  const save = btn('ui-btn primary', undefined, p.onSave, p.saving ? 'Saving…' : 'Save') as HTMLButtonElement;
  save.disabled = p.saving || !p.canSave;
  const cancel = btn('ui-btn', undefined, p.onCancel, p.cancelLabel ?? 'Cancel') as HTMLButtonElement;
  cancel.disabled = p.saving;
  const acts = el('div', 'ci-confirm-r',
    p.error ? el('div', 'ci-confirm-err', icon('i-warn', 'ic-sm'), el('span', '', p.error)) : null,
    el('div', 'ci-confirm-acts', p.note ? el('span', 'ci-note', p.note) : null, cancel, save));
  host.append(left, acts);
}

/** The line a tab shows over its content while it loads or after a failure. */
export function statusBlock(text: string, retry?: () => void): HTMLElement {
  return el('div', 'ci-state', el('span', '', text), retry ? btn('ui-btn', undefined, retry, 'Retry') : null);
}
