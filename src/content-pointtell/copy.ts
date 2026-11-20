/**
 * Point and tell: Copy. The marks go to the clipboard as a short brief that a person pastes into a coding agent
 * (see lib/point-tell/brief.ts). It is one way: nothing is kept for an answer, and nothing is read from the server
 * for it (the page, its template and the marks are already here; the server's name is held by the worker).
 * The first copy in a tab says what the text contains.
 */
import { copyFailureMessage, copyTextResult } from '../lib/copy-feedback';
import { findNode } from '../lib/layout/model';
import { showToast } from '../lib/toast';
import { briefAddress, buildBrief, type BriefInput, type BriefTemplate } from '../lib/point-tell/brief';
import { briefMarks, correctionsOf, earlierSketches, freshMarks } from '../lib/point-tell/sent-marks';
import { screenshotWaiting } from './capture';
import { react } from './mascot';
import { currentPageName } from './measure';
import { fanoutCache } from './service';
import { pt } from './state';

const NOTICE_KEY = 'crev_pt_noticed';
export const PROMPT_FIRST = "Answer the browser's prompt first, then copy again.";
export const NOTICE = "The text names this page, its objects and IDs, and the page address.";

function firstCopy(): boolean {
  try {
    if (sessionStorage.getItem(NOTICE_KEY)) return false;
    sessionStorage.setItem(NOTICE_KEY, '1');
    return true;
  } catch { return false; }
}

/** The notes a brief can hold: every mark but the one that drew a page (the page is in the brief's own line). */
export const copyable = () => briefMarks(pt.marks);
/** What the next send and Copy for AI carry: the marks not sent yet, and the sent ones changed since. */
export const freshNow = () => freshMarks(pt.marks);
/** Some marks of this page went to Claude already. */
export const anySent = (): boolean => pt.marks.some(m => !!m.sent);

/** The shared template the page uses, from what is already read (the count of pages only when it was read before). */
function templateNow(): BriefTemplate | undefined {
  const model = pt.model, ctx = pt.ctx;
  if (!model || pt.page || !ctx) return undefined;
  const own = { id: model.pageId, ...(model.pageName ? { name: model.pageName } : {}), ...(model.pageClass ? { className: model.pageClass } : {}) };
  // An object shown through an EnterpriseTemplate: the layout read is the template's, always.
  if (ctx.viewedObject) return { ...own, className: 'EnterpriseTemplate', shared: true, pages: null };
  if (pt.scope === 'template' && ctx.templateRid) return { ...own, shared: true, pages: fanoutCache.get(model.pageId) ?? null };
  if (ctx.templateId) return { id: ctx.templateId, shared: false };
  return undefined;
}

/** The page or object on screen while the layout is a shared template's. */
function viewedNow(template: BriefTemplate | undefined): BriefInput['viewed'] | undefined {
  const ctx = pt.ctx;
  if (!template?.shared || !ctx) return undefined;
  const shown = currentPageName();
  const v = ctx.viewedObject;
  if (v) return { ...(v.id ? { id: v.id } : {}), ...(v.name || shown ? { name: v.name || shown } : {}), ...(v.className ? { className: v.className } : {}) };
  return ctx.instanceId ? { id: ctx.instanceId, ...(shown ? { name: shown } : {}) } : undefined;
}

/** Everything the brief needs, from the page as it is now. `onlyNew`: the brief is the next sketch (corrections say so, earlier sketches are named). */
export function briefInput(marks: BriefInput['marks'], onlyNew = false): BriefInput | null {
  const model = pt.model;
  if (!model) return null;
  const template = templateNow();
  const viewed = viewedNow(template);
  const shelf = pt.page?.shelf;
  const sv = shelf?.ctx?.viewedObject;
  const from = shelf
    ? sv
      ? { ...(sv.id ? { id: sv.id } : {}), ...(sv.name ? { name: sv.name } : {}), ...(sv.className ? { className: sv.className } : {}) }
      : shelf.scope === 'template'
        ? { ...(shelf.ctx?.instanceId ? { id: shelf.ctx.instanceId } : {}), className: shelf.model.pageClass }
        : { ...(shelf.model.pageName ? { name: shelf.model.pageName } : {}), id: shelf.model.pageId, className: shelf.model.pageClass }
    : undefined;
  const liveTab = pt.scene?.liveTabId ? findNode(model, pt.scene.liveTabId)?.node : null;
  const address = briefAddress(window.location.href, liveTab?.rid);
  return {
    model, marks, liveTabId: pt.scene?.liveTabId ?? null, screenshot: pt.shot,
    ...(template ? { template } : {}),
    ...(viewed ? { viewed } : {}),
    ...(pt.page ? { newPage: { name: pt.page.name, ...(from ? { from } : {}) } } : {}),
    server: { ...(pt.serverName ? { name: pt.serverName } : {}), ...(address ? { address } : {}) },
    ...(onlyNew ? { corrections: correctionsOf(marks), earlier: earlierSketches(pt.marks) } : {}),
  };
}

/** Copy for AI: what is new (like a send), or everything (`all`, and when nothing is new). */
/** "Copied 2 marks", "Copied all 5 marks". */
export const copiedWords = (n: number, all: boolean): string => `Copied ${all ? 'all ' : ''}${n} mark${n === 1 ? '' : 's'}`;

export async function copyMarks(all = false): Promise<void> {
  const fresh = freshNow();
  const every = all || !fresh.length;
  const marks = every ? copyable() : fresh;
  if (!pt.model || !marks.length) return;
  const input = briefInput(marks, !every);
  if (!input) return;
  const res = await copyTextResult(buildBrief(input));
  if (!res.ok) { showToast(screenshotWaiting() ? PROMPT_FIRST : copyFailureMessage(res.reason), 'error'); return; }
  react('nod');
  const n = marks.length;
  showToast(`${copiedWords(n, every && anySent())} as a brief for your coding agent.${firstCopy() ? ` ${NOTICE}` : ''}`, 'success', undefined, { key: 'crev-pt-copy', long: true });
}
