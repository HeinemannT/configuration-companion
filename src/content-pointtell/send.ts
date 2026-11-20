/**
 * Point and tell: Send to Claude. The same brief as Copy for AI goes to Claude Desktop on this computer
 * (through the worker, over a short-lived loopback WebSocket), with a picture of the window when Chrome allows it
 * without a prompt. Nothing is sent until the user presses Send, and nothing is kept open afterwards.
 *
 * Each press of Send gets a key. When the worker gives no answer (Chrome can stop it mid-send) the page asks once
 * more with the same key, so the desktop extension keeps the sketch once.
 */
import { fitSize, type LinkResult, type RequeueResult, type SketchFollows, type SketchRow } from '../lib/claude-link';
import { showToast } from '../lib/toast';
import { sendRequest } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import { buildAnswer, buildBrief } from '../lib/point-tell/brief';
import { PICTURE, followsOf } from '../lib/point-tell/desktop-policy';
import { clearSketch, markAnswered, markSent, marksOfSketch, rowOf } from '../lib/point-tell/sent-marks';
import { chatTaking } from '../lib/point-tell/sent-model';
import { shownNumbers } from '../lib/point-tell/numbering';
import type { PtMark } from '../lib/point-tell/types';
import { captureForSend } from './capture';
import { openClaudeSetup, pageKeyNow, refreshSent, rememberAnswer, sent, startWorkingChat, userMoved } from './sent';
import { drawnPicture } from './sketch-picture';
import { briefInput, freshNow } from './copy';
import { forgetGroup, resetHistory } from './ink-marks';
import { setMarks } from './marks';
import { react } from './mascot';
import { currentPageName } from './measure';
import { pt } from './state';

export const SENT = 'Sent to Claude Desktop.';
/** No chat takes sketches: they wait in line until one is started. */
export const SENT_NO_CHAT = 'Sent. No chat is taking sketches yet.';
/** Said once per tab, when the picture was drawn by Companion because the browser gave no screenshot. */
export const DRAWN_HINT = 'The picture is drawn from the page layout. For a real screenshot, start Point and tell from the right-click menu.';
export const NOT_LISTENING = 'Claude Desktop did not answer. Open it, or set up its extension. Copy for AI works without.';
/** The sketch went out and no answer came back, also after a second try. */
export const LOST = 'Claude Desktop did not confirm the sketch. Open the sent list before you send again.';
export const AGAIN_QUEUED = 'Back in line for Claude.';
export const START_CHAT = 'Start working chat';

type SendData = Extract<InspectorMessage, { type: 'POINT_TELL_SEND_DATA' }>;
type RequeueData = Extract<InspectorMessage, { type: 'POINT_TELL_REQUEUE_DATA' }>;
type SendMsg = Extract<InspectorMessage, { type: 'POINT_TELL_SEND' }>;
type Picture = { mime: 'image/png' | 'image/jpeg'; data: string; drawn?: true };

/** The picture that goes with a sketch: the screenshot, else the drawn one, marked as drawn so the agent takes names and IDs from the text. */
export const pushedPicture = (real: Picture | null, drawn: Picture | null): Picture | null => real ?? (drawn ? { ...drawn, drawn: true } : null);

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const encode = (canvas: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> => new Promise(r => canvas.toBlob(r, type, q));

/** The picture at most PICTURE.maxEdge on the long side; PNG, or JPEG when the PNG is large. Null when it cannot be read. */
export async function fitPicture(blob: Blob): Promise<Picture | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const { width, height } = fitSize(bmp.width, bmp.height, PICTURE.maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, width, height);
    bmp.close();
    const png = await encode(canvas, 'image/png');
    if (png && png.size <= PICTURE.maxPngBytes) return { mime: 'image/png', data: await base64(png) };
    const jpg = await encode(canvas, 'image/jpeg', 0.85);
    if (jpg) return { mime: 'image/jpeg', data: await base64(jpg) };
    return png ? { mime: 'image/png', data: await base64(png) } : null;
  } catch { return null; }
}

/**
 * The toast after a send. `taking`: a chat takes sketches (from the status asked right after the send); without it the
 * acknowledgement's own word decides.
 */
export const outcomeToast = (res: LinkResult | undefined, drawn = false, hint = false, taking?: boolean): { text: string; type: 'success' | 'error'; link?: boolean; chat?: boolean } => {
  if (res?.ok) {
    const none = taking === undefined ? res.agent === 'none' : !taking;
    return { text: `${none ? SENT_NO_CHAT : SENT}${drawn && hint ? ` ${DRAWN_HINT}` : ''}`, type: 'success', ...(none ? { chat: true } : {}) };
  }
  if (res && res.reason === 'lost') return { text: LOST, type: 'error' };
  if (res && res.reason === 'refused') return { text: `Claude Desktop did not keep the sketch: ${res.error ?? 'no reason given'}`, type: 'error' };
  return { text: NOT_LISTENING, type: 'error', link: true };
};

let sending = false;

const HINT_KEY = 'crev_pt_drawn_hint';
/** True the first time in this tab (and false where session storage is not available). */
function firstDrawn(): boolean {
  try {
    if (sessionStorage.getItem(HINT_KEY)) return false;
    sessionStorage.setItem(HINT_KEY, '1');
    return true;
  } catch { return false; }
}

/** A key for one press of Send: 22 random characters of [A-Za-z0-9_-]. */
export function sendKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Hand one sketch to the worker. No answer at all means the worker stopped (or was stopped) mid-send: ask once more with
 * the same key, marked as a retry, so nothing is kept twice.
 */
export async function pushSketch(msg: Omit<SendMsg, 'type' | 'key' | 'since' | 'retry'>, ask: (m: SendMsg) => Promise<SendData | undefined> = (m) => sendRequest<SendData>(m)): Promise<LinkResult | undefined> {
  const first: SendMsg = { type: 'POINT_TELL_SEND', ...msg, key: sendKey(), since: Date.now() };
  const res = await ask(first);
  if (res) return res.result;
  await new Promise(r => setTimeout(r, 600));
  return (await ask({ ...first, retry: true }))?.result;
}

/** What a send's marks correct, by the sketch they were sent in (its id when known), for `follows`. */
export function correctsOf(marks: readonly PtMark[]): Array<{ id?: string; number: number; marks: number[] }> {
  const by = new Map<number, { id?: string; number: number; marks: number[] }>();
  for (const m of marks) {
    const s = m.sent;
    if (!s) continue;
    const e = by.get(s.sketch) ?? { ...(s.id ? { id: s.id } : {}), number: s.sketch, marks: [] };
    if (!e.marks.includes(s.k)) e.marks.push(s.k);
    by.set(s.sketch, e);
  }
  return [...by.values()].sort((a, b) => a.number - b.number);
}

/** After a send: was a chat taking sketches? Asked once, right after, so the toast does not claim more than is true. */
async function takingNow(res: LinkResult): Promise<boolean | undefined> {
  if (!res.ok) return undefined;
  await refreshSent();
  return sent.reachable && sent.listed ? chatTaking(sent.facts) : undefined;
}

const chatAction = { label: START_CHAT, onClick: () => { startWorkingChat(); } };
const setupAction = { label: 'Set up', onClick: () => { openClaudeSetup(); } };

/** Send `marks` as one sketch. `again`: they went before as that sketch and nobody worked on it. */
async function sendMarks(marks: readonly PtMark[], onlyNew: boolean, again?: number): Promise<void> {
  if (!pt.model || !marks.length || sending) return;
  sending = true;
  userMoved();
  const gen = pt.gen;
  const rid = pt.rid, place = pt.page ? 'page' : 'real';
  try {
    const shot = await captureForSend();
    const real = shot ? await fitPicture(shot) : null;
    // No screenshot without a prompt: every sketch still carries a picture, drawn from what Point and tell knows.
    const drawnBlob = real ? null : await drawnPicture(shownNumbers(marks)).catch(() => null);
    const picture = pushedPicture(real, drawnBlob ? await fitPicture(drawnBlob) : null);
    if (!pt.active || pt.gen !== gen) return;
    const input = briefInput(marks, onlyNew);
    if (!input) return;
    const text = buildBrief({ ...input, screenshot: !!picture, ...(again !== undefined ? { again } : {}) });
    const page = currentPageName() ?? pt.model.pageName ?? '';
    const at = Date.now();
    const corrects = onlyNew ? correctsOf(marks.filter(m => m.sent)) : [];
    const follows: SketchFollows | undefined = followsOf(undefined, corrects);
    const res = await pushSketch({ text, ...(page ? { page } : {}), pageKey: pageKeyNow(), ...(picture ? { picture } : {}), ...(follows ? { follows } : {}) });
    if (res?.ok && pt.active && pt.rid === rid && (pt.page ? 'page' : 'real') === place) {
      // What went out is sent: the next send carries only what is drawn or changed from here. Undo starts again from here.
      resetHistory(); forgetGroup();
      setMarks(markSent(pt.marks, marks, { sketch: res.number, at, ...(res.id ? { id: res.id } : {}) }), pt.next);
    }
    const out = outcomeToast(res, !real && !!picture, !real && !!picture && firstDrawn(), res?.ok ? await takingNow(res) : undefined);
    if (out.type === 'success') react('nod');
    showToast(out.text, out.type, out.link ? setupAction : out.chat ? chatAction : undefined, { key: 'crev-pt-send', showInLog: false, ...(out.type === 'success' ? { long: true as const } : {}) });
  } finally { sending = false; }
}

/** Send to Claude: what is new on this page since the last send. The marks that went become "sent" and show what comes back. */
export async function sendToClaude(): Promise<void> {
  await sendMarks(freshNow(), true);
}

/**
 * "Send again" on a sketch nobody works on, or one the listener no longer lists. A listed sketch with an id goes back
 * in line where the desktop extension can do that (it then tells the next chat it was handed out before); otherwise
 * the same marks go out as a new sketch whose brief says they were sent before.
 */
export async function sendAgain(sketch: number): Promise<void> {
  const marks = marksOfSketch(pt.marks, sketch);
  if (!marks.length || sending) return;
  userMoved();
  // An answer nobody took goes again as the answer; anything else as its marks.
  const ans = marks[0].sent!.answer;
  const asAnswer = ans && ans.asks !== undefined ? ans : null;
  const row = rowOf(sent.rows, asAnswer ?? marks[0].sent!);
  if (await requeued(row)) return;
  if (asAnswer) { await sendAnswer(sketch, asAnswer.asks!, asAnswer.text); return; }
  await sendMarks(marks, false, sketch);
}

/** Put a listed sketch back in line where the desktop extension can. True when that is done or failed with a word to the user. */
async function requeued(row: SketchRow | undefined): Promise<boolean> {
  if (row?.id && sent.caps.includes('requeue')) {
    const r: RequeueResult | undefined = (await sendRequest<RequeueData>({ type: 'POINT_TELL_REQUEUE', id: row.id }))?.result;
    if (r?.ok) {
      void refreshSent();
      showToast(AGAIN_QUEUED, 'success', chatTaking(sent.facts) ? undefined : chatAction, { key: 'crev-pt-send', showInLog: false });
      return true;
    }
    if (r && r.reason !== 'unsupported') {
      showToast(r.reason === 'none' ? NOT_LISTENING : `Claude Desktop did not put it back in line: ${r.error ?? 'no reason given'}`, 'error', r.reason === 'none' ? setupAction : undefined, { key: 'crev-pt-send', showInLog: false });
      return true;
    }
  }
  return false;
}

/** "Clear" on a sketch the listener no longer lists: its marks leave the page. */
export function clearUnlisted(sketch: number): void {
  const left = clearSketch(pt.marks, sketch);
  if (left.length === pt.marks.length) return;
  pt.reply = null;
  setMarks(left, pt.next);
}

export const ANSWER_SENT = 'Answer sent to Claude.';

/**
 * Answer Claude's question in place: a short text-only sketch, `Answer to sketch N: "<words>"` with the page line. The
 * marks of sketch `group` carry it, show "Answered", and then the reply to the answer. True when it went out.
 */
export async function sendAnswer(group: number, asks: number, words: string): Promise<boolean> {
  const text = words.replace(/\s+/g, ' ').trim();
  if (!pt.model || !text || sending) return false;
  sending = true;
  userMoved();
  try {
    const input = briefInput([]);
    if (!input) return false;
    const page = currentPageName() ?? pt.model.pageName ?? '';
    const at = Date.now();
    // The question's row, for its id (the group's own sketch, or the answer that asked again).
    const asked = sent.rows.find(r => r.number === asks);
    const follows = followsOf({ ...(asked?.id ? { id: asked.id } : {}), number: asks });
    const r = await pushSketch({ text: buildAnswer(input, asks, text), ...(page ? { page } : {}), pageKey: pageKeyNow(), ...(follows ? { follows } : {}) });
    if (r?.ok) {
      rememberAnswer(r.number, asks, at, r.id);
      if (pt.active) setMarks(markAnswered(pt.marks, group, { sketch: r.number, at, text, asks, ...(r.id ? { id: r.id } : {}) }), pt.next);
      react('nod');
      void refreshSent();
      showToast(ANSWER_SENT, 'success', undefined, { key: 'crev-pt-send', showInLog: false });
      return true;
    }
    const out = outcomeToast(r);
    showToast(out.text, 'error', out.link ? setupAction : undefined, { key: 'crev-pt-send', showInLog: false });
    return false;
  } finally { sending = false; }
}
