import { icon } from './icons';

export interface NoticeContext {
  tone?: 'error' | 'info';
  title?: string;
  targets?: Array<{ label: string; open: () => void }>;
}

/** Diagnostics are text. Context is captured by the operation, not inferred from logs. */
export function renderNotice(host: HTMLElement, text: string, context: NoticeContext = {}): void {
  host.replaceChildren(); host.hidden = !text;
  host.dataset.tone = context.tone ?? 'info';
  host.setAttribute('role', context.tone === 'error' ? 'alert' : 'status');
  if (!text) return;
  const glyph = document.createElement('span'); glyph.className = 'notice-icon';
  glyph.innerHTML = icon(context.tone === 'error' ? 'warning' : 'help');
  const content = document.createElement('div'); content.className = 'notice-content';
  const title = document.createElement('strong'); title.textContent = context.title ?? (context.tone === 'error' ? 'Operation failed' : 'Connection');
  const message = document.createElement('p'); message.textContent = text.split('\n')[0].slice(0, 300);
  content.append(title, message);
  if (context.targets?.length) {
    const targets = document.createElement('div'); targets.className = 'notice-targets';
    const label = document.createElement('span'); label.textContent = 'Working on:'; targets.append(label);
    for (const target of context.targets) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = target.label;
      button.addEventListener('click', target.open); targets.append(button);
    }
    content.append(targets);
  }
  if (text.includes('\n') || text.length > 300) {
    const details = document.createElement('details'), summary = document.createElement('summary'), body = document.createElement('pre');
    summary.textContent = 'Technical details'; body.textContent = text;
    details.append(summary, body); content.append(details);
  }
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'icon-button';
  dismiss.title = 'Dismiss message'; dismiss.setAttribute('aria-label', 'Dismiss message'); dismiss.innerHTML = icon('close');
  dismiss.addEventListener('click', () => { host.hidden = true; });
  host.append(glyph, content, dismiss);
}
