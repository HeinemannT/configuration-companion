/**
 * "Settings could not be read": the worker found its stored settings
 * unreadable (or the read failed) and writes nothing until a Retry reads
 * them. The panel says so at the top, with Retry.
 */
import type { InspectorMessage } from '../lib/types';

const ID = 'settings-status-banner';

export function showSettingsStatus(
  msg: Extract<InspectorMessage, { type: 'SETTINGS_STATUS' }>,
  send: (m: InspectorMessage) => void,
): void {
  let el = document.getElementById(ID);
  if (msg.status !== 'failed') { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = ID;
    el.setAttribute('role', 'alert');
    el.style.cssText = 'margin:8px;padding:8px 10px;border-radius:6px;font-size:12px;line-height:1.4;'
      + 'background:var(--ui-danger-bg, #5c1f1b);color:var(--ui-danger-fg, #ffdad6)';
    document.body.prepend(el);
  }
  el.textContent = '';
  const text = document.createElement('div');
  text.textContent = 'Companion could not read its stored settings, so it changes nothing until they can be read.'
    + (msg.error ? ` (${msg.error})` : '');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'ui-btn';
  retry.style.marginTop = '6px';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => { retry.disabled = true; send({ type: 'RETRY_SETTINGS_LOAD' }); });
  el.append(text, retry);
}
