/**
 * Point and tell: the paste panel and, below its field, what the answer came to: per note, the changes in
 * plain words, what is not possible and why, the AI's questions, and a count. Plain text only: everything
 * that came from the answer is put on the page with textContent.
 */
import { isUserAction } from '../lib/trusted-event';
import { loadCopy } from '../lib/point-tell/store';
import type { PtNoteReport, PtOpResult } from '../lib/point-tell/stage';
import { COPY_FIRST, closeSheet, receivePaste } from './answer';
import { directView } from './direct-view';
import { marksKey } from './marks';
import { pt } from './state';
import { Z, placed } from './view';

export interface SheetActions {
  /** Version 1.1 and staging: the buttons the result may offer. */
  stage?: () => void;
  /** Stage what the marks say on their own (no answer pasted). */
  stageDirect?: () => void;
  openRoute?: (r: NonNullable<PtOpResult['route']>) => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function line(cls: string, mark: string, text: string, sub?: string): HTMLElement {
  const row = el('div', `pt-res ${cls}`);
  row.append(el('span', 'pt-res-mark', mark), el('span', 'pt-res-text', text));
  if (sub) row.appendChild(el('span', 'pt-res-sub', sub));
  return row;
}

function renderNote(r: PtNoteReport, actions: SheetActions): HTMLElement {
  const box = el('div', 'pt-note');
  const head = el('div', 'pt-note-h');
  head.appendChild(r.n ? el('span', 'pt-num', String(r.n)) : el('span', 'pt-note-none', 'No note'));
  if (r.text) head.appendChild(el('span', 'pt-note-text', `“${r.text}”`));
  box.appendChild(head);
  for (const res of r.results) {
    if (res.verdict === 'ok') {
      box.appendChild(line('pt-res-ok', '✓', res.text, res.warning));
    } else if (res.verdict === 'open') {
      const row = line('pt-res-open', '→', res.text, res.route?.kind === 'code' ? 'Shown in the editor as a change to accept or reject' : 'Opens in the object window as a change to review and save');
      if (res.route && actions.openRoute) {
        const route = res.route;
        const b = el('button', 'pt-btn pt-res-act', route.kind === 'code' ? 'Review in editor' : 'Review in object window');
        b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); if (isUserAction(e)) actions.openRoute!(route); });
        row.appendChild(b);
      }
      box.appendChild(row);
    } else {
      const row = line('pt-res-no', '–', res.text, res.reason);
      box.appendChild(row);
    }
  }
  for (const q of r.questions) box.appendChild(line('pt-res-q', '?', q));
  for (const c of r.cannot) box.appendChild(line('pt-res-no', '–', 'Cannot', c));
  if (r.unaddressed) box.appendChild(line('pt-res-none', '', 'No operation for this note'));
  return box;
}

/** The marks that need no answer: what staging them would do, and the button. */
function renderDirect(d: NonNullable<ReturnType<typeof directView>>, actions: SheetActions): HTMLElement {
  const box = el('div', 'pt-direct');
  box.appendChild(el('div', 'pt-direct-h', 'Ready without an answer'));
  const list = el('div', 'pt-sheet-list');
  for (const r of d.result.reports) if (r.results.length) list.appendChild(renderNote(r, actions));
  box.appendChild(list);
  const foot = el('div', 'pt-sheet-f');
  const n = d.result.ready;
  foot.appendChild(el('span', 'pt-sheet-count', `${n} change${n === 1 ? '' : 's'} ready`));
  if (actions.stageDirect) {
    const b = el('button', 'pt-btn pt-primary', `Stage ${n} change${n === 1 ? '' : 's'} in Blueprint`);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); if (isUserAction(e)) actions.stageDirect!(); });
    foot.appendChild(b);
  }
  box.appendChild(foot);
  return box;
}

export function renderSheet(actions: SheetActions = {}): void {
  const layer = pt.layer;
  if (!layer) return;
  // The paste field is built once per opening, so a pasted text survives every redraw; only the result below it is rebuilt.
  let sheet = pt.sheetEl;
  if (!pt.sheet) { sheet?.remove(); pt.sheetEl = null; return; }
  const fresh = !sheet?.isConnected;
  if (!sheet || fresh) {
    sheet = placed(el('div', 'pt-sheet'), 'fixed', Z.field);
    sheet.style.bottom = '84px';
    sheet.style.left = '50%';
    sheet.style.transform = 'translateX(-50%)';
    sheet.style.pointerEvents = 'auto';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Paste answer');
    const head = el('div', 'pt-sheet-h');
    head.appendChild(el('span', 'pt-sheet-title', 'Paste answer'));
    const close = el('button', 'pt-btn pt-sheet-x', 'Close');
    close.type = 'button';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeSheet(); });
    head.appendChild(close);
    const area = el('textarea', 'pt-area pt-paste');
    area.rows = 3;
    area.placeholder = "Paste the AI's answer here";
    area.setAttribute('aria-label', "The AI's answer");
    for (const type of ['keydown', 'keyup', 'keypress'] as const) area.addEventListener(type, (e) => e.stopPropagation());
    area.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeSheet(); } });
    area.addEventListener('paste', (e) => {
      if (!isUserAction(e)) { e.preventDefault(); return; }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text.trim()) return;
      e.preventDefault();
      area.value = text; // the field keeps the whole text, as pasted
      void receivePaste(text);
    });
    const out = el('div', 'pt-sheet-out');
    sheet.append(head, area, out);
    layer.appendChild(sheet);
    pt.sheetEl = sheet;
    queueMicrotask(() => area.focus({ preventScroll: true }));
  }
  const area = sheet.querySelector<HTMLTextAreaElement>('.pt-paste')!;
  if (pt.answer && area.value !== pt.answer.text) area.value = pt.answer.text;
  const out = sheet.querySelector<HTMLElement>('.pt-sheet-out')!;
  out.textContent = '';
  const a = pt.answer;
  const direct = a?.result ? null : directView();
  if (direct) out.appendChild(renderDirect(direct, actions));
  if (!loadCopy(marksKey())) { if (!direct) out.appendChild(el('div', 'pt-sheet-msg', COPY_FIRST)); area.disabled = true; return; }
  area.disabled = false;
  if (!a) return;
  if (a.busy) { out.appendChild(el('div', 'pt-sheet-msg', 'Reading the page…')); return; }
  if (a.error) { out.appendChild(el('div', 'pt-sheet-msg pt-sheet-err', a.error)); return; }
  if (!a.result) return;
  if (a.banner) out.appendChild(el('div', 'pt-sheet-banner', a.banner));
  const list = el('div', 'pt-sheet-list');
  for (const r of a.result.reports) list.appendChild(renderNote(r, actions));
  out.appendChild(list);
  const foot = el('div', 'pt-sheet-f');
  const { ready, review, notPossible } = a.result;
  foot.appendChild(el('span', 'pt-sheet-count', `${ready} change${ready === 1 ? '' : 's'} ready${review ? ` · ${review} to review in a window` : ''}${notPossible ? ` · ${notPossible} not possible` : ''}`));
  if (actions.stage) {
    const stage = el('button', 'pt-btn pt-primary', ready ? `Stage ${ready} change${ready === 1 ? '' : 's'} in Blueprint` : 'Stage in Blueprint');
    stage.type = 'button';
    stage.disabled = ready === 0;
    stage.addEventListener('click', (e) => { e.stopPropagation(); if (isUserAction(e)) actions.stage!(); });
    foot.appendChild(stage);
  }
  out.appendChild(foot);
}
