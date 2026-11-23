/**
 * Point and tell: the list of marks, opened from the count in the dock. One row each (number, what it is
 * about, the words); a row takes you to the mark's tab, a double click opens its field. It also holds the
 * way to write a note for the page itself.
 */
import { findNode } from '../lib/layout/model';
import { getTypeAbbr, getTypeColor } from '../lib/type-registry';
import { shownNumbers } from '../lib/point-tell/numbering';
import { doneMarks, freshMarks, groupView, isSent, viewWord } from '../lib/point-tell/sent-marks';
import { linkView, sent } from './sent';
import type { PtMark } from '../lib/point-tell/types';
import { pt } from './state';
import { Z, placed } from './view';

export interface ListActions {
  pageNote: () => void;
  openMark: (n: number) => void;
  goTo: (n: number) => void;
  copyAll: () => void;
  clearDone: () => void;
}

/** One mark as a line of words for the list: what it is about. */
export function markLabel(m: PtMark): { type?: string; name: string; tab?: string } {
  const model = pt.model;
  const first = m.targets[0] ? (model ? findNode(model, m.targets[0])?.node : undefined) : undefined;
  if (!m.targets.length) return { name: 'Page' };
  if (!first) return { name: 'Not on this page any more' };
  const more = m.targets.length > 1 ? ` +${m.targets.length - 1}` : '';
  return { type: first.className, name: first.name + more };
}

export function renderList(actions: ListActions): void {
  pt.panelEl?.remove();
  pt.panelEl = null;
  const layer = pt.layer;
  if (!layer || !pt.listOpen) return;
  const panel = placed(document.createElement('div'), 'fixed', Z.field);
  panel.className = 'pt-list';
  panel.style.bottom = '84px';
  panel.style.left = '50%';
  panel.style.transform = 'translateX(-50%)';
  panel.style.pointerEvents = 'auto';
  const page = document.createElement('button');
  page.type = 'button'; page.className = 'pt-row pt-row-page';
  page.textContent = 'Write a note for the page';
  page.addEventListener('click', (e) => { e.stopPropagation(); actions.pageNote(); });
  panel.appendChild(page);
  // Once something was sent: copy everything (Copy for AI takes what is new), and take done marks away.
  if (pt.marks.some(m => m.sent)) {
    const tools = document.createElement('div');
    tools.className = 'pt-list-tools';
    const all = document.createElement('button');
    all.type = 'button'; all.className = 'pt-btn';
    all.textContent = 'Copy all marks';
    all.title = 'Copy every mark on this page as one brief, sent or not';
    all.addEventListener('click', (e) => { e.stopPropagation(); actions.copyAll(); });
    tools.appendChild(all);
    const done = doneMarks(pt.marks, sent.rows).length;
    if (done) {
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'pt-btn';
      clear.textContent = `Clear done (${done})`;
      clear.title = 'Take the marks of every done sketch off this page';
      clear.addEventListener('click', (e) => { e.stopPropagation(); actions.clearDone(); });
      tools.appendChild(clear);
    }
    panel.appendChild(tools);
  }
  const numbers = shownNumbers(freshMarks(pt.marks));
  for (const m of pt.marks) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'pt-row';
    const num = document.createElement('span');
    const was = m.sent && isSent(m) ? m.sent : null;
    const wordless = !m.text.trim();
    num.className = (was ? 'pt-num pt-num-sent' : 'pt-num') + (wordless ? ' pt-num-wordless' : '');
    num.textContent = was ? String(was.k) : numbers.has(m.n) ? String(numbers.get(m.n)) : '';
    const what = markLabel(m);
    const who = document.createElement('span');
    who.className = 'pt-row-who';
    if (what.type) {
      const typ = document.createElement('span');
      typ.className = 'pt-typ';
      typ.textContent = getTypeAbbr(what.type);
      typ.style.setProperty('--type-color', getTypeColor(what.type));
      who.appendChild(typ);
    }
    const nm = document.createElement('span');
    nm.className = 'pt-row-name';
    nm.textContent = what.name;
    who.appendChild(nm);
    const words = document.createElement('span');
    words.className = 'pt-row-words';
    words.textContent = m.text || 'No words';
    if (wordless) words.classList.add('pt-row-empty');
    row.append(num, who, words);
    if (was) {
      const v = groupView(was, sent.rows, linkView());
      const st = document.createElement('span');
      st.className = `pt-row-state pt-st-${v.status}${v.attention ? ' pt-need' : ''}`;
      st.textContent = `${viewWord(v)} · ${was.sketch}`;
      st.title = `Sketch ${was.sketch}, mark ${was.k}`;
      row.appendChild(st);
    }
    row.addEventListener('click', (e) => { e.stopPropagation(); actions.goTo(m.n); });
    row.addEventListener('dblclick', (e) => { e.stopPropagation(); actions.openMark(m.n); });
    panel.appendChild(row);
  }
  layer.appendChild(panel);
  pt.panelEl = panel;
}
