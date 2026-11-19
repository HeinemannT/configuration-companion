/**
 * Point and tell: Copy. The notes, the outline and the vocabulary go to the clipboard as one text for an
 * AI chat; what the AI was shown is kept in the tab (the snapshot), so the pasted answer can be judged
 * against it. The first copy in a tab says what the text contains.
 */
import { copyFailureMessage, copyTextResult } from '../lib/copy-feedback';
import { showToast } from '../lib/toast';
import { findNode } from '../lib/layout/model';
import { buildPayload, clipboardText, type ObjectExtras } from '../lib/point-tell/payload';
import { routedProps } from '../lib/point-tell/routes';
import { saveCopy } from '../lib/point-tell/store';
import { isPageMark } from '../lib/point-tell/drafts';
import { marksKey } from './marks';
import { holdReading, react } from './mascot';
import { screenshotWaiting } from './capture';
import { colorSets, ensureColors, fetchNow } from './service';
import { pt } from './state';

const NOTICE_KEY = 'crev_pt_noticed';
export const PROMPT_FIRST = "Answer the browser's prompt first, then copy again.";
export const NOTICE = "The text contains this page's object names and IDs.";

function firstCopy(): boolean {
  try {
    if (sessionStorage.getItem(NOTICE_KEY)) return false;
    sessionStorage.setItem(NOTICE_KEY, '1');
    return true;
  } catch { return false; }
}

/** The notes that go out: the ones not yet staged in Blueprint. */
export const copyable = () => pt.marks.filter(m => !m.staged && !isPageMark(m));

/** What the noted objects hold in text properties and code (one small read, only for objects that have any; none for a page of plain layout). */
async function readExtras(marks: ReturnType<typeof copyable>): Promise<Record<string, ObjectExtras> | undefined> {
  if (!pt.model) return undefined;
  const items: Array<{ rid: string; className: string; id: string }> = [];
  // Only a mark with words can ask for a change of text or code; a cross is about the object, not its contents.
  for (const id of new Set(marks.filter(m => m.text.trim() && m.meaning?.kind !== 'crossed').flatMap(m => m.targets))) {
    const node = findNode(pt.model, id)?.node;
    const r = node ? routedProps(node.className) : null;
    if (node?.rid && r && (r.code.length || r.text.length)) items.push({ rid: node.rid, className: node.className, id });
  }
  if (!items.length) return undefined;
  const read = await Promise.race([fetchNow(items), new Promise<null>(r => setTimeout(() => r(null), 4000))]);
  if (!read) return undefined;
  const out: Record<string, ObjectExtras> = {};
  for (const it of items) {
    const e = read[it.rid];
    if (e) out[it.id] = { text: e.text, code: e.code, omitted: e.omitted };
  }
  return out;
}

export async function copyMarks(): Promise<void> {
  const marks = copyable();
  if (!pt.model || !marks.length) return;
  const gen = pt.gen;
  // The colours: usually read already; if not, wait for them briefly (the click's permission lasts a few seconds).
  const done = holdReading();
  let extras: Awaited<ReturnType<typeof readExtras>>;
  try {
    if (!colorSets()) await Promise.race([ensureColors(), new Promise(r => setTimeout(r, 3000))]);
    extras = await readExtras(marks);
  } finally { done(); }
  if (!pt.active || pt.gen !== gen || !pt.model) return;
  const { payload, snapshot, instruction } = buildPayload({
    model: pt.model, marks, colors: colorSets(), liveTabId: pt.scene?.liveTabId ?? null, scope: pt.scope, now: Date.now(), screenshot: pt.shot, newPage: !!pt.page,
    ...(extras ? { extras } : {}),
  });
  const res = await copyTextResult(clipboardText(payload, instruction));
  if (!res.ok) { showToast(screenshotWaiting() ? PROMPT_FIRST : copyFailureMessage(res.reason), 'error'); return; }
  saveCopy(marksKey(), snapshot);
  react('nod');
  const n = marks.length;
  showToast(`Copied ${n} note${n === 1 ? '' : 's'} for an AI chat.${firstCopy() ? ` ${NOTICE}` : ''}`, 'success', undefined, { key: 'crev-pt-copy', long: true });
}
