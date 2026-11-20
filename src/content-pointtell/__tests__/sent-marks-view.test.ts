// @vitest-environment happy-dom
/**
 * Sent marks on the page: their badges are quieter and carry their sketch's state; new marks are numbered as the next
 * sketch will number them; Send is off with nothing new and Copy then offers everything; the reply opens at the mark
 * and takes an answer when Claude asked a question.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRequest = vi.fn(async (_m: unknown): Promise<unknown> => undefined);
vi.mock('../../lib/messaging', () => ({ sendRequest: (m: unknown) => sendRequest(m), sendFireForget: vi.fn() }));
vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

import { pt, resetState } from '../state';
import { sent } from '../sent';
import { renderPins } from '../pins';
import { renderDock, type DockActions } from '../dock';
import { renderReply, ANSWER_PLACEHOLDER, CLEAR, CLEAR_DONE, SEND_AGAIN, SEND_ANSWER } from '../reply-card';
import { fixtureModel, fixtureScene } from '../../lib/point-tell/__tests__/fixture';
import { markSent } from '../../lib/point-tell/sent-marks';
import type { SketchRow } from '../../lib/claude-link';
import type { PtMark } from '../../lib/point-tell/types';

const T0 = Date.now();
const row = (number: number, state: SketchRow['state'], reply?: string): SketchRow => ({
  number, at: new Date(T0).toISOString(), page: 'Operational Risk', pageKey: 'k', state, rev: 5, ...(reply ? { reply: { text: reply, at: new Date(T0).toISOString() } } : {}),
});
const noop = (): void => undefined;
const dockActions: DockActions = { close: noop, openList: noop, openSent: noop, clear: noop, copy: noop, send: noop, undo: noop, redo: noop, screenshot: noop, setTool: noop };

beforeEach(() => {
  document.body.innerHTML = '';
  sessionStorage.clear();
  resetState();
  const layer = document.createElement('div');
  document.body.appendChild(layer);
  pt.layer = layer;
  pt.active = true;
  pt.phase = 'ready';
  pt.model = fixtureModel();
  pt.scene = fixtureScene(pt.model);
  const first: PtMark[] = [{ n: 1, text: 'Bigger title', targets: ['txt_info'], at: 1 }, { n: 2, text: 'Blue', targets: ['btn_export'], at: 2 }];
  pt.marks = [...markSent(first, first, { sketch: 3, at: T0 }), { n: 3, text: 'Add a filter', targets: ['tbl_open_risks'], at: 3 }];
  pt.next = 4;
  sent.rows = [row(3, 'done', 'Made the title 18 px.')];
  sent.seen = {};
  sent.listed = false;
  sent.reachable = true;
  sent.facts = { agent: 'recent' };
  sendRequest.mockReset();
});

const badge = (n: number) => pt.pinLayer!.querySelector<HTMLElement>(`.pt-badge[data-n="${n}"]`)!;

describe('badges after a send', () => {
  it('sent marks keep their number in their sketch, show its state, and the new mark is 1', () => {
    renderPins(noop);
    expect(badge(1).classList.contains('pt-sent')).toBe(true);
    expect(badge(1).querySelector('text')!.textContent).toBe('1');
    expect(badge(2).querySelector('text')!.textContent).toBe('2');
    expect(badge(1).querySelector('.pt-pip-done')).toBeTruthy();
    expect(badge(1).getAttribute('aria-label')).toBe('Sketch 3, mark 1: Done');
    expect(badge(1).querySelector('.pt-tip-reply')!.textContent).toBe('Made the title 18 px.');
    expect(badge(3).classList.contains('pt-sent')).toBe(false);
    expect(badge(3).querySelector('text')!.textContent).toBe('1');
  });

  it('a reply not looked at yet marks the state; a click on a sent badge opens the reply, on a new one the comment', () => {
    const onOpen = vi.fn(), onReply = vi.fn();
    renderPins(onOpen, onReply);
    expect(badge(1).querySelector('.pt-pip-news')).toBeTruthy();
    badge(1).click(); badge(3).click();
    expect(onReply).toHaveBeenCalledWith(1);
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  it('a changed sent mark is new again and says what it corrects', () => {
    pt.marks = pt.marks.map(m => (m.n === 2 ? { ...m, text: 'Dark blue' } : m));
    renderPins(noop);
    expect(badge(2).classList.contains('pt-sent')).toBe(false);
    expect(badge(2).querySelector('text')!.textContent).toBe('1');
    expect(badge(3).querySelector('text')!.textContent).toBe('2');
    expect(badge(2).querySelector('.pt-tip-badge')!.textContent).toBe('Correction to sketch 3, mark 2: Dark blue');
  });
});

describe('the dock after a send', () => {
  const q = (role: string) => pt.dock!.querySelector<HTMLButtonElement>(`[data-role="${role}"]`)!;

  it('Send carries what is new and Copy counts it', () => {
    renderDock(dockActions);
    expect(q('send').disabled).toBe(false);
    expect(q('copy').textContent).toBe('Copy for AI');
    expect(q('count').textContent).toBe('1');
  });

  it('with nothing new, Send is off and Copy offers everything', () => {
    pt.marks = pt.marks.filter(m => m.n !== 3);
    renderDock(dockActions);
    expect(q('send').disabled).toBe(true);
    expect(q('copy').textContent).toBe('Copy all for AI');
    expect(q('copy').disabled).toBe(false);
    expect(q('count').textContent).toBe('2');
  });

  it('the sent button shows a reply waiting unread, and not once it was looked at', () => {
    renderDock(dockActions);
    expect(q('sent').classList.contains('pt-news')).toBe(true);
    expect(q('sent').hidden).toBe(false);
    sent.seen = { 3: 5 };
    renderDock(dockActions);
    expect(q('sent').classList.contains('pt-news')).toBe(false);
  });
});

describe('the reply at the mark', () => {
  const actions = () => ({ change: vi.fn(), clearDone: vi.fn(), answer: vi.fn(async () => true), again: vi.fn(), clear: vi.fn(), startChat: vi.fn(), close: vi.fn() });

  it('a done sketch: the reply, the mark\'s words, Change and Clear done', () => {
    renderPins(noop);
    const a = actions();
    pt.reply = { n: 1 };
    renderReply(a);
    const card = pt.replyEl!;
    expect(card.querySelector('.pt-reply-state')!.textContent).toBe('Done');
    expect(card.querySelector('.pt-reply-num')!.textContent).toBe('Sketch 3 · now');
    expect(card.querySelector('.pt-reply-text')!.textContent).toBe('Made the title 18 px.');
    expect(card.querySelector('.pt-reply-words')!.textContent).toBe('Bigger title');
    expect(card.style.position).toBe('absolute');
    const buttons = [...card.querySelectorAll<HTMLButtonElement>('.pt-reply-act')];
    expect(buttons.map(b => b.textContent)).toEqual([CLEAR_DONE, 'Change']);
    buttons[0].click();
    expect(a.clearDone).toHaveBeenCalled();
    expect(card.querySelector('textarea')).toBeNull();
  });

  it('a question: answer in place, Enter sends it for the sketch that asked', () => {
    sent.rows = [row(3, 'question', 'Which tab, Overview or Details?')];
    renderPins(noop);
    const a = actions();
    pt.reply = { n: 2 };
    renderReply(a);
    const area = pt.replyEl!.querySelector('textarea')!;
    expect(area.placeholder).toBe(ANSWER_PLACEHOLDER);
    expect(pt.replyEl!.querySelector('.pt-reply-send')!.textContent).toBe(SEND_ANSWER);
    area.value = 'Overview';
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(a.answer).toHaveBeenCalledWith(3, 3, 'Overview');
  });

  it('goes away when the mark is changed and is new again', () => {
    renderPins(noop);
    pt.reply = { n: 1 };
    renderReply(actions());
    expect(pt.replyEl).toBeTruthy();
    pt.marks = pt.marks.map(m => (m.n === 1 ? { ...m, text: 'Even bigger' } : m));
    renderReply(actions());
    expect(pt.replyEl).toBeNull();
    expect(pt.reply).toBeNull();
  });
});

describe('no dead ends at the mark', () => {
  const actions = () => ({ change: vi.fn(), clearDone: vi.fn(), answer: vi.fn(async () => true), again: vi.fn(), clear: vi.fn(), startChat: vi.fn(), close: vi.fn() });
  const card = () => pt.replyEl!;
  const texts = () => [...card().querySelectorAll('.pt-reply-text')].map(e => e.textContent);
  const buttons = () => [...card().querySelectorAll<HTMLButtonElement>('.pt-reply-go button')];

  it('no chat taking sketches: says so, Start working chat, and a ! on the badge', () => {
    sent.listed = true;
    sent.facts = { agent: 'none', copies: [], wait: 45 };
    sent.rows = [row(3, 'queued')];
    renderPins(noop);
    expect(badge(1).querySelector('.pt-pip-need')).toBeTruthy();
    const a = actions();
    pt.reply = { n: 1 };
    renderReply(a);
    expect(card().querySelector('.pt-reply-state')!.textContent).toBe('Waiting for Claude');
    expect(texts()).toEqual(['No chat is taking sketches.']);
    expect(buttons().map(b => b.textContent)).toEqual(['Start working chat']);
    buttons()[0].click();
    expect(a.startChat).toHaveBeenCalled();
  });

  it('taken and nobody working on it: Stopped, and Send again', () => {
    sent.listed = true;
    sent.facts = { agent: 'none', copies: [], wait: 45 };
    sent.rows = [{ ...row(3, 'taken'), takenAt: new Date(Date.now() - 25 * 60_000).toISOString() }];
    const a = actions();
    renderPins(noop);
    pt.reply = { n: 1 };
    renderReply(a);
    expect(card().querySelector('.pt-reply-state')!.textContent).toBe('Stopped');
    expect(texts()[0]).toBe('Nobody is working on it. No word from Claude for 25 min.');
    expect(buttons().map(b => b.textContent)).toEqual([SEND_AGAIN]);
    buttons()[0].click();
    expect(a.again).toHaveBeenCalledWith(expect.objectContaining({ sketch: 3, attention: 'stalled' }));
  });

  it('no longer listed: Clear or Send again; not said before the listener ever answered', () => {
    // Sent a minute ago: past the grace in which a sketch may be missing only because the rows are older than it.
    pt.marks = pt.marks.map(m => (m.sent ? { ...m, sent: { ...m.sent, at: T0 - 60_000 } } : m));
    sent.rows = [];
    renderPins(noop);
    pt.reply = { n: 1 };
    renderReply(actions());
    expect(card().querySelector('.pt-reply-state')!.textContent).toBe('Sent');
    expect(buttons()).toEqual([]);
    sent.listed = true;
    const a = actions();
    renderReply(a);
    expect(card().querySelector('.pt-reply-state')!.textContent).toBe('Not listed');
    expect(texts()).toEqual(['Claude Desktop no longer lists this sketch.']);
    expect(buttons().map(b => b.textContent)).toEqual([CLEAR, SEND_AGAIN]);
    buttons()[0].click();
    expect(a.clear).toHaveBeenCalledWith(3);
  });
});