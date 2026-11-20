/**
 * Point and tell: the dock, a small floating panel at the bottom centre of the window. The product's
 * mark at the left (its eyes follow the pen tip), then the two pens as objects (the active one lifts),
 * undo, redo, clear, Screenshot, Copy for AI with the count of marks, and close.
 * Built once per phase and updated in place, so the pen's lift can animate.
 */
import { richMarkSvg } from '../lib/companion-mark';
import { DOCK_ICONS, brushPenSvg, eraserSvg } from './dock-pens';
import { canRedo, canUndo } from './ink-marks';
import { noteInput } from './mascot';
import { news } from './sent';
import { sentLabel } from '../lib/point-tell/sent-model';
import { sent } from './sent';
import { pt, type PtToolId } from './state';
import { briefMarks, freshMarks } from '../lib/point-tell/sent-marks';
import { Z, placed } from './view';

export interface DockActions {
  close: () => void;
  openList: () => void;
  openSent: () => void;
  clear: () => void;
  copy: () => void;
  send: () => void;
  undo: () => void;
  redo: () => void;
  screenshot: () => void;
  setTool: (tool: PtToolId) => void;
}

const count = (n: number): string => (n === 0 ? 'No marks' : `${n} mark${n === 1 ? '' : 's'}`);

function button(cls: string, title: string, role: string, on: () => void, html?: string, text?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.className = cls; b.title = title; b.dataset.role = role;
  b.setAttribute('aria-label', title.split('.')[0]);
  if (html) b.innerHTML = html;
  if (text) { const t = document.createElement('span'); t.textContent = text; b.appendChild(t); }
  // The page under the dock keeps its focus; a press must not start a stroke or a note under it.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { e.stopPropagation(); noteInput(); on(); });
  return b;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function buildReady(actions: DockActions): HTMLElement {
  const dock = el('div', 'pt-dock');
  const mascot = el('div', 'crev-mark pt-mascot');
  mascot.dataset.role = 'mascot';
  mascot.innerHTML = richMarkSvg();
  mascot.setAttribute('aria-hidden', 'true');
  dock.appendChild(mascot);

  const scope = el('span', 'pt-scope');
  scope.dataset.role = 'scope';
  dock.appendChild(scope);

  const well = el('div', 'pt-well');
  well.setAttribute('role', 'group');
  well.setAttribute('aria-label', 'Tools');
  const slot = (tool: PtToolId, title: string, svg: string): HTMLButtonElement => {
    const b = button('pt-slot', title, `tool-${tool}`, () => actions.setTool(tool), svg);
    b.setAttribute('aria-pressed', 'false');
    return b;
  };
  well.append(slot('pen', 'Brush pen', brushPenSvg()), slot('eraser', 'Eraser: drag across a stroke to take it away', eraserSvg()));
  dock.appendChild(well);

  dock.append(
    button('pt-ib', 'Undo the last mark or stroke', 'undo', actions.undo, DOCK_ICONS.undo),
    button('pt-ib', 'Redo', 'redo', actions.redo, DOCK_ICONS.redo),
    button('pt-ib', 'Clear all marks', 'clear', actions.clear, DOCK_ICONS.clear),
    el('span', 'pt-sep'),
    button('pt-tx', SHOT_TITLE, 'shot', actions.screenshot, DOCK_ICONS.shot, 'Screenshot'),
    el('span', 'pt-sep'),
  );

  dock.append(button('pt-tx', SEND_TITLE, 'send', actions.send, undefined, 'Send to Claude'));
  const sentBtn = button('pt-tx pt-sent-btn', 'What you sent to Claude, and what came back', 'sent', actions.openSent, undefined, '0 sent');
  sentBtn.hidden = true;
  dock.append(sentBtn);
  const copy = el('div', 'pt-copy');
  const copyBtn = button('pt-copy-main', 'Copy the marks as a brief to paste into a coding agent', 'copy', actions.copy, undefined, 'Copy for AI');
  const countBtn = button('pt-copy-count', 'Show the marks', 'count', actions.openList);
  copy.append(copyBtn, countBtn);
  dock.append(copy, button('pt-ib pt-x', 'Leave Point and tell', 'close', actions.close, DOCK_ICONS.close));
  return dock;
}

function buildPlain(actions: DockActions): HTMLElement {
  const dock = el('div', 'pt-dock pt-dock-plain');
  const mascot = el('div', 'crev-mark pt-mascot');
  mascot.dataset.role = 'mascot';
  mascot.innerHTML = richMarkSvg();
  mascot.setAttribute('aria-hidden', 'true');
  dock.append(mascot, el('span', 'pt-dock-title'), button('pt-ib pt-x', 'Leave Point and tell', 'close', actions.close, DOCK_ICONS.close));
  return dock;
}

const q = <T extends HTMLElement>(root: HTMLElement, role: string): T | null => root.querySelector<T>(`[data-role="${role}"]`);

const SEND_TITLE = 'Send the marks as a brief to Claude Desktop on this computer, with a picture when the browser allows it';
const SHOT_TITLE = 'Copy a picture of what is on screen, with the marks and their numbers. Only the visible part of the page is captured.';

/** The Screenshot button alone shows that Chrome's prompt is open; every other control stays as it is. */
export function syncShotButton(): void {
  const b = pt.dock?.querySelector<HTMLButtonElement>('[data-role="shot"]');
  if (!b) return;
  b.classList.toggle('on', pt.shotWaiting);
  if (pt.shotWaiting) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  b.title = pt.shotWaiting ? "Waiting for the browser's prompt. Answer it to take the picture." : SHOT_TITLE;
}

/** Draw or update the dock for the state in `pt`. */
export function renderDock(actions: DockActions): void {
  const layer = pt.layer;
  if (!layer) return;
  const ready = pt.phase === 'ready';
  const want = ready ? 'ready' : 'plain';
  if (pt.dock && (pt.dock.dataset.phase !== want || !pt.dock.isConnected)) { pt.dock.remove(); pt.dock = null; }
  if (!pt.dock) {
    const dock = placed(ready ? buildReady(actions) : buildPlain(actions), 'fixed', Z.bar);
    dock.dataset.phase = want;
    dock.style.bottom = '16px';
    dock.style.left = '50%';
    dock.style.transform = 'translateX(-50%)';
    dock.style.pointerEvents = 'auto';
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-label', 'Point and tell');
    layer.appendChild(dock);
    pt.dock = dock;
  }
  const dock = pt.dock;
  if (!ready) {
    const title = dock.querySelector('.pt-dock-title');
    if (title) title.textContent = pt.phase === 'loading' ? 'Point and tell · Loading page…' : pt.failure ?? 'Point and tell';
    return;
  }

  const n = pt.marks.length;
  const scope = q(dock, 'scope');
  if (scope) {
    const through = !!pt.ctx?.viewedObject;
    const templated = !!pt.ctx?.templateRid || through;
    scope.hidden = !templated;
    scope.textContent = through || pt.scope === 'template' ? 'Template' : 'This instance';
    scope.title = through
      ? 'The marks are about the template this object is shown through.'
      : pt.scope === 'template'
        ? 'The marks are about the shared template this page uses. Blueprint can switch to This instance.'
        : 'The marks are about this page only.';
  }
  for (const tool of ['pen', 'eraser'] as const) {
    const b = q<HTMLButtonElement>(dock, `tool-${tool}`);
    if (!b) continue;
    const on = pt.tool === tool;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const set = (role: string, fn: (b: HTMLButtonElement) => void): void => { const b = q<HTMLButtonElement>(dock, role); if (b) fn(b); };
  set('undo', b => { b.disabled = !canUndo(); });
  set('redo', b => { b.disabled = !canRedo(); });
  set('clear', b => {
    b.disabled = n === 0;
    b.classList.toggle('pt-warn', pt.clearArm);
    b.classList.toggle('pt-tx', pt.clearArm);
    b.classList.toggle('pt-ib', !pt.clearArm);
    if (pt.clearArm) b.textContent = `Click again to clear ${n}`;
    else { b.innerHTML = DOCK_ICONS.clear; }
  });
  syncShotButton();
  // A send and a copy carry what is new since the last send; with nothing new, Copy offers everything.
  const all = briefMarks(pt.marks).length, fresh = freshMarks(pt.marks).length;
  const copyAll = fresh === 0 && all > 0;
  set('copy', b => {
    b.disabled = all === 0;
    const label = copyAll && pt.marks.some(m => m.sent) ? 'Copy all for AI' : 'Copy for AI';
    const t = b.querySelector('span');
    if (t && t.textContent !== label) t.textContent = label;
    b.title = copyAll ? 'Nothing new since the last send. Copy every mark as a brief to paste into a coding agent' : 'Copy the new marks as a brief to paste into a coding agent';
  });
  set('send', b => {
    b.disabled = fresh === 0;
    b.title = fresh === 0 && all > 0 ? 'Nothing new since the last send. Draw or change a mark to send it.' : SEND_TITLE;
  });
  syncSentButton();
  const shown = fresh > 0 && fresh < all ? fresh : n;
  set('count', b => {
    b.textContent = String(shown);
    b.classList.toggle('on', pt.listOpen);
    b.title = fresh > 0 && fresh < all ? `${fresh} new of ${count(n).toLowerCase()}. Show them.` : `${count(n)}. Show them.`;
  });
}

/** The "n sent" button: how many, and a dot while a reply waits unread. */
export function syncSentButton(): void {
  const b = pt.dock?.querySelector<HTMLButtonElement>('[data-role="sent"]');
  if (!b) return;
  const label = sentLabel(sent.rows);
  b.hidden = label === null;
  b.classList.toggle('on', pt.sentOpen);
  const fresh = news();
  b.classList.toggle('pt-news', fresh);
  const t = b.querySelector('span');
  if (t && label !== null && t.textContent !== label) t.textContent = label;
  b.title = fresh ? 'Claude has answered. Show what you sent.' : 'What you sent to Claude, and what came back';
}

/** A reply came back for a sketch whose marks are not on this page: the sent button nods once. */
export function pingSentButton(): void {
  const b = pt.dock?.querySelector<HTMLButtonElement>('[data-role="sent"]');
  if (!b || b.hidden) return;
  b.classList.remove('pt-ping');
  void b.offsetWidth;
  b.classList.add('pt-ping');
  window.setTimeout(() => b.classList.remove('pt-ping'), 1400);
}
