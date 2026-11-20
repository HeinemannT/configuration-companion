/**
 * Point and tell: the list of what was sent, opened from "n sent" in the dock. One row per sketch, newest first:
 * its state, the page (left out for this page) and the time, and Claude's words under it when there are any.
 * The header leads to the Claude Desktop page and holds the one way to start a working chat (or says a chat is
 * already waiting). Quiet: no icons beyond a small state dot.
 */
import { STATE_WORDS, isNews, type Seen, type SketchRow } from '../lib/claude-link';
import { ago, attentionOf, chatNeeded, chatTaking, newestFirst } from '../lib/point-tell/sent-model';
import { answered, answers, openClaudeSetup, pageKeyNow, sent, startWorkingChat } from './sent';
import { STATUS_WORDS } from '../lib/point-tell/sent-marks';
import { pt } from './state';
import { Z, placed } from './view';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** What a row does when pressed: on this page it shows the reply at the marks, from another page it goes there. */
export const sentRowHooks: { open: (r: SketchRow, here: boolean) => void } = { open: () => undefined };

function row(r: SketchRow, here: boolean, fresh: boolean): HTMLElement {
  const li = el('button', `pt-sent-row pt-st-${r.state}${fresh ? ' pt-new' : ''}`);
  li.type = 'button';
  li.title = here ? 'Show it on the page' : `Go to ${r.page || 'its page'}`;
  const head = el('div', 'pt-sent-head');
  const dot = el('span', 'pt-dot');
  dot.setAttribute('aria-hidden', 'true');
  // A question answered from here waits on its answer; an answer says which sketch it answers.
  const waits = r.state === 'question' && answered(r);
  if (waits) li.classList.replace(`pt-st-${r.state}`, 'pt-st-answered');
  const of = answers(r);
  // Nobody works on a taken sketch: the row says so, its marks offer Send again.
  const stalled = sent.reachable && attentionOf(r, sent.rows, sent.facts) === 'stalled';
  if (stalled) li.classList.add('pt-need');
  head.append(dot, el('span', 'pt-sent-state', waits ? STATUS_WORDS.answered : stalled ? 'Stopped' : r.word ?? STATE_WORDS[r.state] ?? r.state), el('span', 'pt-sent-num', String(r.number)));
  const where = here ? 'This page' : r.page || 'Another page';
  head.append(el('span', 'pt-sent-page', of !== undefined ? `Answer to ${of} · ${where}` : where), el('span', 'pt-sent-time', ago(r.reply?.at ?? r.at)));
  li.appendChild(head);
  if (r.reply?.text) li.appendChild(el('div', 'pt-sent-reply', r.reply.text));
  li.addEventListener('click', (e) => { e.stopPropagation(); sentRowHooks.open(r, here); });
  return li;
}

/** What was unread when the list opened: those rows keep a quiet mark while it stays open. */
let before: Seen = {};
let wasOpen = false;
/** Call before the list is opened and its rows are marked read. */
export function noteOpening(): void { before = { ...sent.seen }; wasOpen = true; }

export function renderSent(): void {
  if (pt.sentOpen && !wasOpen) before = { ...sent.seen };
  wasOpen = pt.sentOpen;
  pt.sentEl?.remove();
  pt.sentEl = null;
  const layer = pt.layer;
  if (!layer || !pt.sentOpen) return;
  const panel = placed(document.createElement('div'), 'fixed', Z.field);
  panel.className = 'pt-list pt-sent';
  panel.style.bottom = '84px';
  panel.style.left = '50%';
  panel.style.transform = 'translateX(-50%)';
  panel.style.pointerEvents = 'auto';

  const bar = el('div', 'pt-sent-bar');
  bar.appendChild(el('span', 'pt-sent-title', 'Sent to Claude'));
  const setup = el('button', 'pt-sent-setup', 'Set up');
  setup.type = 'button';
  setup.title = 'Get the extension for Claude Desktop and see whether it is connected';
  setup.addEventListener('click', (e) => { e.stopPropagation(); openClaudeSetup(); });
  bar.appendChild(setup);
  // A chat takes sketches: nothing to start.
  if (sent.reachable && sent.listed && chatTaking(sent.facts)) {
    const waiting = el('span', 'pt-sent-waiting', 'Claude is taking sketches');
    waiting.title = 'A working chat takes the next sketch';
    bar.appendChild(waiting);
  } else {
    const start = el('button', `pt-sent-start${sent.reachable && chatNeeded(sent.facts, sent.rows) ? ' pt-primary' : ''}`, 'Start working chat');
    start.type = 'button';
    start.title = 'Open a new chat in Claude Desktop that takes your sketches one after another';
    start.addEventListener('click', (e) => { e.stopPropagation(); startWorkingChat(); });
    bar.appendChild(start);
  }
  panel.appendChild(bar);

  const key = pageKeyNow();
  for (const r of newestFirst(sent.rows)) panel.appendChild(row(r, !!key && r.pageKey === key, isNews(r, before)));
  if (!sent.reachable) panel.appendChild(el('div', 'pt-sent-note', 'Claude Desktop is not running.'));
  else if (sent.rows.length && chatNeeded(sent.facts, sent.rows)) panel.appendChild(el('div', 'pt-sent-note', 'No chat is taking sketches. Start a working chat in Claude Desktop.'));
  layer.appendChild(panel);
  pt.sentEl = panel;
}
