/**
 * Point and tell: the dock, a small floating panel at the bottom centre of the window. The product's
 * mark at the left (its eyes follow the pen tip), then the two pens as objects (the active one lifts),
 * undo, redo, clear, Screenshot, Copy for AI with the count of marks, Paste answer, and close.
 * Built once per phase and updated in place, so the pen's lift can animate.
 */
import { richMarkSvg } from '../lib/companion-mark';
import { DOCK_ICONS, brushPenSvg, eraserSvg } from './dock-pens';
import { canRedo, canUndo } from './ink-marks';
import { noteInput } from './mascot';
import { pt, type PtToolId } from './state';
import { Z, placed } from './view';

export interface DockActions {
  close: () => void;
  openList: () => void;
  clear: () => void;
  copy: () => void;
  paste: () => void;
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

  const copy = el('div', 'pt-copy');
  const copyBtn = button('pt-copy-main', 'Copy the marks for an AI chat', 'copy', actions.copy, undefined, 'Copy for AI');
  const countBtn = button('pt-copy-count', 'Show the marks', 'count', actions.openList);
  copy.append(copyBtn, countBtn);
  dock.append(copy, button('pt-tx', 'Paste what the AI answered', 'paste', actions.paste, undefined, 'Paste answer'), button('pt-ib pt-x', 'Leave Point and tell', 'close', actions.close, DOCK_ICONS.close));
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
    const templated = !!pt.ctx?.templateRid;
    scope.hidden = !templated;
    scope.textContent = pt.scope === 'template' ? 'Template' : 'This instance';
    scope.title = pt.scope === 'template'
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
  set('copy', b => { b.disabled = !pt.marks.some(m => !m.staged); });
  set('count', b => { b.textContent = String(n); b.classList.toggle('on', pt.listOpen); b.title = `${count(n)}. Show them.`; });
  set('paste', b => { b.classList.toggle('on', !!pt.sheet); });
}
