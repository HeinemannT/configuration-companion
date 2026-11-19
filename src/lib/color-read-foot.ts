/**
 * The foot of every color picker: when the color sets were read, and Refresh.
 * Stored copies refresh only on demand, so the pickers of the page (the
 * property color picker and the Blueprint swatch popover) carry this line.
 * One implementation: plain DOM so it works in an extension page and in the
 * injected overlay. The layout is set inline (the overlay's stylesheet is
 * cosmetic only); the host's stylesheet colors it (`.cr-foot`, `.cr-refresh`).
 */
import { readDate } from './read-date';

export interface ColorReadFootOpts {
  /** Epoch ms of the read, or null when it is not known. */
  at: number | null;
  /** A read is running: Refresh waits. */
  busy: boolean;
  onRefresh: () => void;
}

/** "Read 19 Nov 08:40 · Refresh" */
export function colorReadFoot(opts: ColorReadFootOpts): HTMLElement {
  const foot = document.createElement('div');
  foot.className = 'cr-foot';
  foot.style.cssText = 'display:flex;align-items:center;gap:6px;flex:none;padding:6px 12px 8px;font-size:11px;line-height:16px;';
  const read = document.createElement('span');
  read.className = 'cr-read';
  read.textContent = opts.at == null ? 'Not read' : `Read ${readDate(opts.at)}`;
  const dot = document.createElement('span');
  dot.textContent = '·';
  dot.setAttribute('aria-hidden', 'true');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'cr-refresh';
  refresh.textContent = 'Refresh';
  refresh.style.cssText = 'padding:0;border:0;background:none;font:inherit;color:inherit;text-decoration:underline;cursor:pointer;';
  refresh.disabled = opts.busy;
  if (opts.busy) refresh.style.cursor = 'default';
  // The overlay's pickers close on a press outside them; a press here must not.
  refresh.addEventListener('mousedown', e => e.stopPropagation());
  refresh.addEventListener('click', e => { e.stopPropagation(); if (!opts.busy) opts.onRefresh(); });
  foot.append(read, dot, refresh);
  return foot;
}
