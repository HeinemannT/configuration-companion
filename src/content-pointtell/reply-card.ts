/**
 * Point and tell: Claude's reply where the user drew. A click on a sent mark's badge opens a small card beside it:
 * the sketch's state and Claude's sentence, the mark's own words with a way to change them (the change then goes out
 * as a correction), and, when Claude asked a question, a field to answer in place (typing, or voice when it is on).
 * A done sketch offers "Clear done". The card is built once per opening, so words being typed survive a redraw.
 */
import { ICON_X } from '../lib/icons';
import { ago } from '../lib/point-tell/sent-model';
import { attentionLine, groupView, isSent, sentGroups, viewWord, type GroupView } from '../lib/point-tell/sent-marks';
import { quietMinutes } from '../lib/point-tell/sent-model';
import { START_CHAT } from './send';
import type { PtMark } from '../lib/point-tell/types';
import { VOICE_TOGGLE_KEY } from '../lib/point-tell/voice';
import { noteInput } from './mascot';
import { badgeEl, markRect } from './pins';
import { syncSentButton } from './dock';
import { linkView, markSeen, sent } from './sent';
import { pt } from './state';
import { Z, placed } from './view';
import { endVoice, listening, micButton, toggleVoice, voiceSupported, asking, closeAsk } from './voice';

export interface ReplyActions {
  /** Change the mark's words (they go out again as a correction). */
  change: (n: number) => void;
  clearDone: () => void;
  /** Send an answer to sketch `asks` for the marks of sketch `group`. Resolves true when it went out. */
  answer: (group: number, asks: number, words: string) => Promise<boolean>;
  /** Send again: a sketch (or an answer) nobody works on, or one the listener no longer lists. */
  again: (view: GroupView) => void;
  /** Take the marks of a sketch the listener no longer lists off the page. */
  clear: (sketch: number) => void;
  startChat: () => void;
  close: () => void;
}

const WIDTH = 288;
const DOCK_ROOM = 84;

export const ANSWER_PLACEHOLDER = 'Your answer';
export const SEND_ANSWER = 'Send answer';
export const CLEAR_DONE = 'Clear done';
export const CHANGE = 'Change';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** The marks and the view the open reply is about; null when it no longer applies (the mark was changed, deleted, cleared). */
export function openReply(): { marks: PtMark[]; view: GroupView; mark?: PtMark } | null {
  const r = pt.reply;
  if (!r) return null;
  if ('n' in r) {
    const m = pt.marks.find(x => x.n === r.n);
    if (!m?.sent || !isSent(m)) return null;
    const marks = pt.marks.filter(x => x.sent?.sketch === m.sent!.sketch && isSent(x));
    return { marks, view: groupView(m.sent, sent.rows, linkView()), mark: m };
  }
  const g = sentGroups(pt.marks, sent.rows, linkView()).find(x => x.view.sketch === r.sketch);
  return g ? { marks: g.marks, view: g.view } : null;
}

/** The words a state shows when Claude has not said anything yet (and nothing needs the user). */
const QUIET_LINE: Partial<Record<GroupView['status'], string>> = {
  queued: 'The working chat takes it next.',
};

export const SEND_AGAIN = 'Send again';
export const CLEAR = 'Clear';

/**
 * Where the card goes (page coordinates): beside the badge, on the side where it covers nothing of what the mark is
 * about (its ink, or the object of a note), inside the window and above the dock. With no badge: above the dock.
 */
function place(card: HTMLElement, mark: PtMark | undefined): { left: number; top: number } {
  const W = card.offsetWidth || WIDTH, H = card.offsetHeight || 120;
  const vx0 = window.scrollX + 8, vx1 = window.scrollX + document.documentElement.clientWidth - 8;
  const vy0 = window.scrollY + 8, vy1 = window.scrollY + window.innerHeight - DOCK_ROOM;
  const clamp = (l: number, t: number): { left: number; top: number } => ({ left: Math.max(vx0, Math.min(vx1 - W, l)), top: Math.max(vy0, Math.min(vy1 - H, t)) });
  const badge = mark ? badgeEl(mark.n) : null;
  if (!badge || !mark) return clamp(window.scrollX + (document.documentElement.clientWidth - W) / 2, vy1 - H);
  const bl = parseFloat(badge.style.left), bt = parseFloat(badge.style.top);
  const r = markRect(mark);
  const fits = (c: { left: number; top: number }): boolean => c.left >= vx0 && c.left + W <= vx1 && c.top >= vy0 && c.top + H <= vy1;
  const clear = (c: { left: number; top: number }): boolean => !r || c.left >= r.left + r.width || c.left + W <= r.left || c.top >= r.top + r.height || c.top + H <= r.top;
  const options = [
    { left: bl + 36, top: bt - 2 },
    { left: bl + 4 - W, top: bt - 2 },
    ...(r ? [
      { left: Math.max(r.left, Math.min(bl, r.left + r.width - W)), top: r.top - H - 10 },
      { left: Math.max(r.left, Math.min(bl, r.left + r.width - W)), top: r.top + r.height + 10 },
      { left: r.left + r.width + 10, top: bt - 2 },
      { left: r.left - W - 10, top: bt - 2 },
    ] : []),
  ];
  return options.find(c => fits(c) && clear(c)) ?? options.find(fits) ?? clamp(options[0].left, options[0].top);
}

const keyOf = (v: GroupView): string => `${v.sketch}|${v.status}|${v.row?.rev ?? 0}|${v.answer ?? ''}|${v.attention ?? ''}`;

/** A small row of buttons under the card's text. */
function actionRow(items: Array<{ label: string; title: string; primary?: boolean; run: () => void }>): HTMLElement {
  const row = el('div', 'pt-reply-go');
  for (const it of items) {
    const b = el('button', it.primary ? 'pt-btn pt-primary pt-reply-send' : 'pt-reply-act', it.label);
    b.type = 'button';
    b.title = it.title;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.stopPropagation(); b.disabled = true; it.run(); });
    row.appendChild(b);
  }
  return row;
}

/** Draw the open reply, or take it away. */
export function renderReply(actions: ReplyActions): void {
  const open = openReply();
  if (!open || !pt.layer) {
    if (pt.reply && !open) pt.reply = null;
    if (pt.replyEl && listening() && pt.replyEl.contains(document.activeElement)) endVoice(false);
    pt.replyEl?.remove(); pt.replyEl = null;
    return;
  }
  const { view, mark } = open;
  const key = keyOf(view);
  const typed = pt.replyEl?.querySelector('textarea')?.value ?? '';
  if (pt.replyEl?.isConnected && pt.replyEl.dataset.key === key && pt.replyEl.dataset.for === forOf()) return;
  if (pt.replyEl?.isConnected && listening()) return; // never pull the field out from under the voice
  pt.replyEl?.remove();

  const card = placed(document.createElement('div'), 'absolute', Z.field);
  card.className = `pt-field pt-reply pt-st-${view.status}${view.attention ? ' pt-need' : ''}`;
  card.style.width = `${WIDTH}px`;
  card.style.left = '0'; card.style.top = '0';
  card.style.visibility = 'hidden';
  card.style.pointerEvents = 'auto';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `Sketch ${view.sketch}: ${viewWord(view)}`);
  card.dataset.key = key;
  card.dataset.for = forOf();
  // A press in the card must not reach the page or start a stroke.
  card.addEventListener('pointerdown', (e) => e.stopPropagation());

  const head = el('div', 'pt-reply-head');
  const dot = el('span', 'pt-dot');
  dot.setAttribute('aria-hidden', 'true');
  const when = view.row?.reply?.at ?? view.row?.at;
  head.append(dot, el('span', 'pt-reply-state', viewWord(view)), el('span', 'pt-reply-num', `Sketch ${view.sketch}${when ? ` · ${ago(when)}` : ''}`));
  // What applies to every done sketch of the page sits up here; what applies to this mark sits at the foot.
  if (view.status === 'done') {
    const clear = el('button', 'pt-reply-act pt-reply-clear', CLEAR_DONE);
    clear.type = 'button';
    clear.title = 'Take the marks of every done sketch off this page';
    clear.addEventListener('mousedown', (e) => e.preventDefault());
    clear.addEventListener('click', (e) => { e.stopPropagation(); actions.clearDone(); });
    head.appendChild(clear);
  }
  const x = el('button', 'pt-read-x');
  x.type = 'button'; x.innerHTML = ICON_X; x.title = 'Close'; x.setAttribute('aria-label', 'Close');
  x.addEventListener('mousedown', (e) => e.preventDefault());
  x.addEventListener('click', (e) => { e.stopPropagation(); actions.close(); });
  head.appendChild(x);
  card.appendChild(head);

  const need = attentionLine(view, view.attention === 'stalled' && view.row && view.status !== 'answered' && sent.facts.copies ? quietMinutes(view.row, sent.facts) : undefined);
  const said = view.status === 'answered' ? view.reply : view.reply ?? (need ? undefined : QUIET_LINE[view.status]);
  if (said) card.appendChild(el('div', `pt-reply-text${view.reply ? '' : ' pt-quiet'}`, said));
  if (view.answer) {
    const you = el('div', 'pt-reply-you');
    you.append(el('span', 'pt-reply-you-k', 'You'), el('span', 'pt-reply-you-t', view.answer));
    card.appendChild(you);
  }
  // Nobody works on it, no chat takes sketches, or it is no longer listed: say so and offer the way on.
  if (need) {
    card.appendChild(el('div', 'pt-reply-text pt-reply-need', need.text));
    card.appendChild(actionRow([
      ...(need.chat ? [{ label: START_CHAT, title: 'Open a new chat in Claude Desktop that takes your sketches one after another', primary: true, run: () => actions.startChat() }] : []),
      ...(need.clear ? [{ label: CLEAR, title: 'Take these marks off the page', run: () => actions.clear(view.sketch) }] : []),
      ...(need.again ? [{ label: SEND_AGAIN, title: 'Send these marks to Claude again', primary: true, run: () => actions.again(view) }] : []),
    ]));
  }

  if (view.status === 'question' && view.asks !== undefined) {
    const asks = view.asks;
    const wrap = el('div', 'pt-area-wrap');
    const area = el('textarea', 'pt-area');
    area.rows = 2;
    area.value = typed;
    area.placeholder = ANSWER_PLACEHOLDER;
    area.setAttribute('aria-label', ANSWER_PLACEHOLDER);
    area.title = voiceSupported() ? `Enter sends. Shift+Enter makes a new line. ${VOICE_TOGGLE_KEY} starts and stops talking.` : 'Enter sends. Shift+Enter makes a new line.';
    for (const type of ['keydown', 'keyup', 'keypress'] as const) area.addEventListener(type, (e) => e.stopPropagation());
    const go = el('button', 'pt-btn pt-primary pt-reply-send', SEND_ANSWER);
    go.type = 'button';
    const submit = (): void => {
      const words = area.value.trim();
      if (!words || go.disabled) { area.focus(); return; }
      if (listening()) endVoice(true);
      go.disabled = true; area.disabled = true;
      void actions.answer(open.view.sketch, asks, area.value).then((ok) => { if (!ok && card.isConnected) { area.disabled = false; go.disabled = false; area.focus(); } });
    };
    const fit = (): void => {
      const over = card.offsetTop + card.offsetHeight - (window.scrollY + window.innerHeight - DOCK_ROOM);
      if (over > 0) card.style.top = `${Math.max(window.scrollY + 8, Math.round(card.offsetTop - over))}px`;
    };
    area.addEventListener('keydown', (e) => {
      if (e.key === VOICE_TOGGLE_KEY && voiceSupported()) { e.preventDefault(); if (!e.repeat) toggleVoice(card, area, fit); return; }
      if (e.key === 'Escape' && asking(card)) { e.preventDefault(); closeAsk(card); return; }
      if (listening()) {
        if (e.key === 'Escape') { e.preventDefault(); endVoice(false); return; }
        if (e.key === 'Enter' && !e.shiftKey) endVoice(true);
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); actions.close(); }
    });
    area.addEventListener('input', noteInput);
    area.addEventListener('blur', () => { if (listening()) endVoice(true); });
    wrap.appendChild(area);
    if (voiceSupported()) {
      const mic = micButton(card, area, fit);
      mic.classList.add('pt-end');
      wrap.appendChild(mic);
    }
    wrap.style.setProperty('--pt-pr', `${voiceSupported() ? 34 : 10}px`);
    card.appendChild(wrap);
    const row = el('div', 'pt-reply-go');
    go.addEventListener('mousedown', (e) => e.preventDefault());
    go.addEventListener('click', (e) => { e.stopPropagation(); submit(); });
    row.appendChild(go);
    card.appendChild(row);
  }

  const foot = el('div', 'pt-reply-foot');
  if (mark?.sent) {
    const what = el('span', 'pt-reply-mark');
    what.append(el('span', 'pt-num pt-num-sent', String(mark.sent.k)), el('span', 'pt-reply-words', mark.text || mark.reading || 'No words'));
    what.title = mark.text || mark.reading || '';
    foot.appendChild(what);
    const change = el('button', 'pt-reply-act', CHANGE);
    change.type = 'button';
    change.title = 'Change what this mark says. It goes to Claude with the next send, as a correction.';
    change.addEventListener('mousedown', (e) => e.preventDefault());
    change.addEventListener('click', (e) => { e.stopPropagation(); actions.change(mark.n); });
    foot.appendChild(change);
  }
  if (foot.childElementCount) card.appendChild(foot);

  pt.layer.appendChild(card);
  pt.replyEl = card;
  const at = place(card, mark);
  card.style.left = `${Math.round(at.left)}px`;
  card.style.top = `${Math.round(at.top)}px`;
  card.style.visibility = '';
  if (view.row?.reply) { markSeen([view.row]); syncSentButton(); }
  const area = card.querySelector('textarea');
  if (area) { area.focus({ preventScroll: true }); area.setSelectionRange(area.value.length, area.value.length); }
}

const forOf = (): string => { const r = pt.reply; return !r ? '' : 'n' in r ? `n${r.n}` : `s${r.sketch}`; };
