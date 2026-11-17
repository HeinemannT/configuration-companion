/**
 * The quiet "could not be read" form: what failed, why (behind "Details",
 * reachable by keyboard, never only a tooltip) and Retry. A failed read must
 * never look like data ("(not read)", "Unknown object", an empty cell), so
 * every surface that shows the result of a read uses these instead.
 *
 * Plain DOM (extension windows and the page share it); classes in ui.css and
 * content-overlay.css.
 */
import type { FailureCopy } from './connection-copy';

export const NOT_READ_TEXT = 'could not be read';

function details(detail: string | null | undefined): HTMLElement | null {
  if (!detail) return null;
  const d = document.createElement('details');
  d.className = 'ui-failed-d';
  const s = document.createElement('summary');
  s.textContent = 'Details';
  const body = document.createElement('span');
  body.className = 'ui-failed-detail';
  body.textContent = detail;
  d.append(s, body);
  return d;
}

function retryButton(onRetry: () => void, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ui-failed-retry';
  b.textContent = label;
  b.addEventListener('click', e => { e.stopPropagation(); onRetry(); });
  return b;
}

/** A one-line note: "The scan failed." Details, Retry. */
export function failedNote(text: string, detail?: string | null, onRetry?: () => void, retryLabel = 'Retry'): HTMLElement {
  const n = document.createElement('div');
  n.className = 'ui-failed';
  n.setAttribute('role', 'status');
  const t = document.createElement('span');
  t.className = 'ui-failed-t';
  t.textContent = text;
  n.append(t);
  const d = details(detail);
  if (onRetry) n.append(retryButton(onRetry, retryLabel));
  if (d) n.append(d);
  return n;
}

/** A failed request in the shared words (connection-copy `describeFailure`):
 *  title, one sentence with what to do, Retry where it applies, the raw detail
 *  behind "Details". */
export function failureBlock(copy: FailureCopy, onRetry?: () => void): HTMLElement {
  const n = document.createElement('div');
  n.className = 'ui-failed ui-failed--block';
  n.setAttribute('role', 'alert');
  const title = document.createElement('strong');
  title.className = 'ui-failed-title';
  title.textContent = copy.title;
  const sentence = document.createElement('span');
  sentence.className = 'ui-failed-t';
  sentence.textContent = copy.sentence;
  n.append(title, sentence);
  if (copy.retry && onRetry) n.append(retryButton(onRetry, 'Retry'));
  const d = details(copy.detail);
  if (d) { if (copy.showDetail) d.setAttribute('open', ''); n.append(d); }
  return n;
}

/** An inline chip/field value that failed to read: "could not be read", the
 *  reason on hover AND for assistive tech, and Retry when given. */
export function unreadValue(reason?: string | null, onRetry?: () => void): HTMLElement {
  const s = document.createElement('span');
  s.className = 'ui-unread';
  const t = document.createElement('span');
  t.className = 'ui-unread-t';
  t.textContent = NOT_READ_TEXT;
  s.append(t);
  if (reason) {
    s.title = reason;
    const sr = document.createElement('span');
    sr.className = 'ui-sr';
    sr.textContent = `: ${reason}`;
    s.append(sr);
  }
  if (onRetry) {
    const b = retryButton(onRetry, 'Retry');
    b.classList.add('ui-unread-retry');
    s.append(b);
  }
  return s;
}
