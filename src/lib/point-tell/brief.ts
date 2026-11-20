/**
 * Point and tell: the text Copy puts on the clipboard. A short, plain brief that a person pastes into a coding
 * agent (Claude Code, Codex and the like), which has its own access to the BMP workspace and its own knowledge of
 * Corporater. It is one-way: nothing comes back into Companion, so the text is for reading, not for parsing.
 *
 *   where the user is   page (name, type, business ID), the shown tab, the shared template, the server, the address
 *   what was drawn      one numbered line per mark: the drawing in plain words, every object by name, type and
 *                       business ID, our guess (only when there is one), the user's words
 *   one closing line    guesses can be wrong; the user's words win
 *
 * No JSON, no outline of the page, no current values or code of objects: the agent reads what it needs itself.
 * Pure: the model and the marks in, text out. Internal short refs (o3, t2, n1) and rids never appear.
 */
import { findNode } from '../layout/model';
import type { LModel, LNode } from '../layout/types';
import { draftTabs, isDraftId, withDrafts } from './drafts';
import { shownNumbers } from './numbering';
import { gridWords, kindOf } from './phrases';
import type { PtGridPlace, PtMark, PtPlace, PtWidgetKind } from './types';

export interface BriefTemplate {
  name?: string;
  id: string;
  /** Its class: Scorecard for a page template, EnterpriseTemplate for the template objects are shown through. */
  className?: string;
  /** The marks are about the shared template (true), or about this page only while it uses one (false). */
  shared: boolean;
  /** How many pages use it, when that is already known. */
  pages?: number | null;
}

export interface BriefInput {
  /** The layout the marks point at: the shared template when `template.shared`, else the page itself. */
  model: LModel;
  marks: readonly PtMark[];
  /** The object id of the tab BMP shows. */
  liveTabId: string | null;
  /** The page or object on screen when `model` is the shared template: its business ID, name and class. */
  viewed?: { id?: string; name?: string; className?: string };
  template?: BriefTemplate;
  /** A page that does not exist yet (the paper page); `from` is the page the user was looking at. */
  newPage?: { name: string; from?: { name?: string; id?: string; className?: string } };
  /** The server profile's name and the address of the page. */
  server?: { name?: string; address?: string };
  /** A screenshot was taken since the last Clear. */
  screenshot?: boolean;
  /** Marks (by internal number) that change a mark sent before: the sketch and the number they correct. */
  corrections?: Readonly<Record<number, { sketch: number; k: number }>>;
  /** Sketches sent from this page before; this brief then holds only what is new. */
  earlier?: readonly number[];
  /** The marks were sent before as this sketch, and nobody worked on it: this is Send again. */
  again?: number;
}

export const OPENING = 'Change request for a Corporater BMP page, sketched in Configuration Companion.';
export const CLOSING_GUESSES = "Guesses are Companion's reading of the drawing and can be wrong; the user's words win. Ask before changing anything that is unclear.";
export const CLOSING_PLAIN = "The user's words win. Ask before changing anything that is unclear.";
export const SHOT_LINE = 'A picture with the same numbers is attached.';
/** A cross or a strike over objects with no words: it can mean delete, hide or replace. */
export const CROSS_NO_WORDS = 'The user did not say what to do with it: ask before deleting.';
/** Freehand ink with no words: nothing says what it asks for. */
export const INK_NO_WORDS = 'The user did not say what it means: ask before changing anything.';
/** Send again: the same marks went out before and got no reply. */
export const againLine = (sketch: number): string => `Sent again: sketch ${sketch} got no reply and nobody is working on it. Check in BMP what is already done before you change anything.`;

/** Query parameters that look like a secret never go into the address. */
const SECRET_PARAM = /token|auth|key|pass|secret|session|jwt|sig/i;

/**
 * The page address for the brief, cut down to what opens the same page and tab: the path, `rid` and `tabrid`
 * (BMP does not write a clicked tab into the address, so the shown tab's rid is added). The period, the home flag
 * and the like only change what is shown and are dropped. No credentials, no fragment. Null when it is not a web
 * address. An address without a `rid` keeps its other parameters (minus secret-looking ones): it is then the only
 * thing that says which page this is.
 */
export function briefAddress(href: string | undefined, tabRid?: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.username = ''; u.password = ''; u.hash = '';
    const rid = u.searchParams.get('rid');
    if (rid) {
      const tab = tabRid && /^\d{6,}$/.test(tabRid) ? tabRid : u.searchParams.get('tabrid');
      u.search = '';
      u.searchParams.set('rid', rid);
      if (tab) u.searchParams.set('tabrid', tab);
    } else {
      for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return null; }
}

/** Words as a quoted phrase on one line. */
export function quoted(text: string): string {
  return `"${text.replace(/\s+/g, ' ').trim().replace(/"/g, '\\"')}"`;
}

const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
const list = (items: string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Ctx {
  model: LModel;
  liveTabId: string | null;
}

/** How an object is named for an agent: its name, its type and its business ID; when it has none, what identifies it best, said so. */
function refOf(c: Ctx, id: string | undefined): string {
  const found = id ? findNode(c.model, id) : null;
  if (!found) return 'an object that is no longer on the page';
  const n = found.node;
  const name = n.name && n.name !== n.id ? quoted(n.name) : '';
  if (isDraftId(n.id)) return `the new tab ${name || '(no name yet)'}`;
  const hasId = !!n.id && n.id !== n.rid && !/^-?\d{13,}$/.test(n.id);
  // An ID that is only digits is the ID BMP assigned when none was given: it is the object's ID, said as numeric.
  const numeric = hasId && /^-?\d+$/.test(n.id);
  let idText: string;
  if (!hasId) {
    const parent = found.parent;
    const at = found.siblings.indexOf(n) + 1;
    idText = `no business ID${parent ? `, ${ordinal(at)} in ${quoted(parent.name)}` : ''}`;
  } else idText = numeric ? `numeric ID ${n.id}` : n.id;
  const kind = n.kind === 'tab' ? 'tab ' : n.kind === 'container' ? 'container ' : '';
  const type = n.kind === 'widget' ? `${n.className}, ` : '';
  // Without a name of its own, the ID is the name: say it once.
  if (!name && hasId) return `${kind}${n.kind === 'widget' ? `${n.className} ` : ''}${numeric ? 'numeric ID' : 'ID'} ${n.id}`;
  return `${kind}${name || quoted(n.id)} (${type}${idText})`;
}

/** "after X", "before X", "inside X": a place as an agent can check it. */
function placeOf(c: Ctx, p: PtPlace): string {
  return 'before' in p ? `just before ${refOf(c, p.before)}` : 'after' in p ? `just after ${refOf(c, p.after)}` : `inside ${refOf(c, p.into)}`;
}

/** Where ink sits: the tab (when it is not the shown one), the container and the row and columns. */
function gridOf(c: Ctx, g: PtGridPlace): string {
  const parts: string[] = [];
  // A drawn tab is not a tab BMP has: it is always named, even while it is the one on screen.
  if (g.tabId && (g.tabId !== c.liveTabId || isDraftId(g.tabId))) parts.push(isDraftId(g.tabId) ? `in ${refOf(c, g.tabId)}` : `on ${refOf(c, g.tabId)}`);
  if (g.containerId) parts.push(`inside ${refOf(c, g.containerId)}`);
  const grid = gridWords(g);
  if (grid) parts.push(`at ${grid}`);
  return parts.join(', ');
}

const INSIDE: Record<PtWidgetKind, string> = { table: 'with lines across drawn inside', chart: 'with bars drawn inside', button: 'as a small rounded box', text: 'with wavy lines drawn inside' };
const NOUN: Record<PtWidgetKind, string> = { table: 'a new table', chart: 'a new chart', button: 'a new button', text: 'a new text' };

/** "buttons "A" (...) and "B" (...)": objects by name, type and ID; a group of buttons says so. */
function objects(c: Ctx, ids: readonly string[]): string {
  const nodes = ids.map(id => findNode(c.model, id)?.node).filter((n): n is LNode => !!n);
  const refs = ids.map(id => refOf(c, id));
  const noun = nodes.length === ids.length && nodes.length > 0 && nodes.every(n => n.kind === 'widget' && /Button$/.test(n.className)) ? `button${nodes.length > 1 ? 's' : ''} ` : '';
  return `${noun}${list(refs)}`;
}

/** The drawing in plain words, and our guess about it (undefined when we have none). */
function describe(m: PtMark, c: Ctx): { drew?: string; guess?: string; name?: boolean } {
  const mean = m.meaning;
  switch (kindOf(m)) {
    case 'click': return { drew: `Comment on ${objects(c, m.targets)}` };
    case 'circle': return { drew: `Circle around ${objects(c, m.targets)}` };
    case 'pointer': return { drew: `Arrow pointing at ${objects(c, m.targets)}` };
    case 'cross': return { drew: `Cross over ${objects(c, m.targets)}` };
    case 'underline': return { drew: `Underline under ${objects(c, m.targets)}` };
    case 'arrow': {
      const to = mean?.kind === 'move' ? placeOf(c, mean.to) : '';
      return { drew: `Arrow from ${refOf(c, m.targets[0])}${to ? ` to ${to}` : ''}`, ...(to ? { guess: 'move it there' } : {}) };
    }
    case 'pair': {
      const where = m.ink ? gridOf(c, m.ink.place) : '';
      const wide = mean?.kind === 'move' && mean.columns ? `, about ${plural(mean.columns, 'column')} wide` : '';
      return { drew: `Arrow from ${refOf(c, m.targets[0])} into a square${where ? ` ${where}` : ''}`, guess: `move it there${wide}` };
    }
    case 'square': {
      const add = mean?.kind === 'add' ? mean : null;
      const where = m.ink ? gridOf(c, m.ink.place) : '';
      const drawn = `Square on empty space${where ? ` ${where}` : ''}${add?.widget ? `, ${INSIDE[add.widget]}` : ''}`;
      const wide = add?.columns ? `, about ${plural(add.columns, 'column')} wide` : '';
      const anchor = !where.includes('row') && add ? `, ${placeOf(c, add.place)}` : '';
      return { drew: drawn, guess: `${add?.widget ? NOUN[add.widget] : 'a new widget'}${wide}${anchor}` };
    }
    case 'tab': {
      const p = mean?.kind === 'add' ? mean.place : null;
      const at = p && ('before' in p ? ` before ${refOf(c, p.before)}` : 'after' in p ? ` after ${refOf(c, p.after)}` : '');
      const name = m.text.trim();
      return { drew: `The user drew a new tab ${name ? quoted(name) : 'with no name yet'}${at || ' on the tab row'}. It is a sketch and does not exist in BMP`, name: true };
    }
    case 'page': return { drew: 'A new page drawn past the last breadcrumb', name: true };
    case 'ink': {
      if (m.targets.length) return { drew: `Freehand ink near ${objects(c, m.targets)}, not a shape Companion recognised` };
      const where = m.ink ? gridOf(c, m.ink.place) : '';
      return { drew: `Freehand ink ${where || 'on the page'}, not a shape Companion recognised` };
    }
    default: return {};
  }
}

/** "Correction to sketch 3, mark 1": what a changed mark says it corrects. */
export const correctionLead = (c: { sketch: number; k: number }): string => `Correction to sketch ${c.sketch}, mark ${c.k}`;

/** One mark as one numbered line (`num`: the number shown for it; `fix`: the sent mark it corrects). */
export function markLine(m: PtMark, c: Ctx, num: number = m.n, fix?: { sketch: number; k: number }): { text: string; guessed: boolean } {
  const d = describe(m, c);
  const words = m.text.trim();
  const lead = fix ? `${correctionLead(fix)}. ` : '';
  if (!d.drew) return { text: `${num}. ${lead}Note for the whole page: ${quoted(words)}`, guessed: false };
  const parts = [`${d.drew}.`];
  if (d.guess) parts.push(`Our guess: ${d.guess}.`);
  if (words && !d.name) parts.push(`The user says: ${quoted(words)}`);
  // Marks that can be read as a delete, with nothing said: the agent asks first.
  const kind = kindOf(m);
  if (!words && kind === 'cross') parts.push(CROSS_NO_WORDS);
  else if (!words && kind === 'ink') parts.push(INK_NO_WORDS);
  return { text: `${num}. ${lead}${parts.join(' ')}`, guessed: !!d.guess };
}

/** "ID x"; an ID of digits only is the one BMP assigned, said as numeric (as for objects). */
const idText = (id: string | undefined): string => (id ? `${/^-?\d+$/.test(id) ? 'numeric ID' : 'ID'} ${id}` : '');

/**
 * The template line: which template the layout is, and where a change lands. A page template (a Scorecard others
 * link to) is shared by pages; an EnterpriseTemplate is what objects of a type are shown through, so a change shows
 * for every such object. The values on screen stay the viewed object's own.
 */
function templateLine(t: BriefTemplate, viewed: BriefInput['viewed']): string {
  const facts = [t.className, `ID ${t.id}`].filter(Boolean).join(', ');
  const label = `${t.name && t.name !== t.id ? `${quoted(t.name)} ` : ''}(${facts})`;
  if (!t.shared) return `Template: ${label}. The marks are about this page only, not the template.`;
  const objects = t.className === 'EnterpriseTemplate';
  const who = objects ? `every ${viewed?.className && viewed.className !== 'EnterpriseTemplate' ? viewed.className : 'object'} that uses it` : 'every page that uses it';
  const count = t.pages ? ` (${plural(t.pages, objects ? 'object' : 'page')})` : '';
  const own = viewed?.name ? `; the values shown belong to ${quoted(viewed.name)}` : '';
  return `Template: ${label}. Layout changes go on the template and show on ${who}${count}${own}.`;
}

/** The few lines that say where the user is. */
function headerLines(input: BriefInput, c: Ctx): string[] {
  const out: string[] = [];
  const m = input.model;
  if (input.newPage) {
    const from = input.newPage.from;
    const facts = [from?.className, idText(from?.id)].filter(Boolean).join(', ');
    const looking = from && (from.name || from.id) ? [from.name ? quoted(from.name) : '', facts && `(${facts})`].filter(Boolean).join(' ') : '';
    out.push(`Page: the user sketched a new page ${quoted(input.newPage.name)}${looking ? `, past the last breadcrumb of ${looking}` : ''}. It is a sketch and does not exist in BMP.`);
  } else {
    const shared = input.template?.shared === true;
    const name = shared ? input.viewed?.name : m.pageName;
    const id = shared ? input.viewed?.id : m.pageId;
    const cls = (shared ? input.viewed?.className : undefined) ?? (input.template?.className === 'EnterpriseTemplate' ? undefined : m.pageClass);
    const facts = [cls, idText(id)].filter(Boolean).join(', ');
    const tab = input.liveTabId && !isDraftId(input.liveTabId) ? findNode(c.model, input.liveTabId)?.node : null;
    out.push(`Page: ${[name ? quoted(name) : '', facts ? `(${facts})` : ''].filter(Boolean).join(' ')}${tab ? `, tab ${quoted(tab.name)}` : ''}`);
  }
  const t = input.template;
  if (t && !input.newPage) out.push(templateLine(t, input.viewed));
  const s = input.server;
  const server = [s?.name, s?.address].filter(Boolean).join(', ');
  if (server) out.push(`Server: ${server}`);
  return out;
}

/** "Marks from sketches 3 and 5 are still on this page. They are not repeated here…": what the page already sent. */
export function earlierLine(sketches: readonly number[]): string {
  const which = sketches.length === 1 ? `sketch ${sketches[0]}` : `sketches ${list(sketches.map(String))}`;
  return `Marks from ${which} are still on this page. They are not repeated here and need no action, unless a mark below corrects one. The numbers below start at 1.`;
}

/** The text of an answer to Claude's question on a sketch: the words, then where the user is. */
export function buildAnswer(input: Pick<BriefInput, 'model' | 'liveTabId' | 'viewed' | 'template' | 'newPage' | 'server'>, sketch: number, words: string): string {
  const c: Ctx = { model: input.model, liveTabId: input.liveTabId };
  const where = headerLines({ ...input, marks: [] }, c);
  return `${answerLine(sketch, words)}\n\n${where.join('\n')}\n`;
}

/** `Answer to sketch 4: "Overview"`. */
export const answerLine = (sketch: number, words: string): string => `Answer to sketch ${sketch}: ${quoted(words)}`;

/** The brief, ready for the clipboard. */
export function buildBrief(input: BriefInput): string {
  const shown = withDrafts(input.model, draftTabs(input.marks));
  const c: Ctx = { model: shown, liveTabId: input.liveTabId };
  const numbers = shownNumbers(input.marks);
  const lines = input.marks.filter(m => numbers.has(m.n)).map(m => markLine(m, c, numbers.get(m.n), input.corrections?.[m.n]));
  const body = [
    OPENING,
    headerLines(input, c).join('\n'),
    ...(input.again !== undefined ? [againLine(input.again)] : []),
    ...(input.earlier?.length ? [earlierLine(input.earlier)] : []),
    lines.map(l => l.text).join('\n'),
    ...(input.screenshot ? [SHOT_LINE] : []),
    lines.some(l => l.guessed) ? CLOSING_GUESSES : CLOSING_PLAIN,
  ];
  return `${body.join('\n\n')}\n`;
}
