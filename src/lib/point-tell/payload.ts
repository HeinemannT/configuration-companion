/**
 * The copied text: a short instruction and one JSON object. Every mark says what it `drew` (a fact), what
 * Companion `guess`es it means (absent when unsure) and what the user `says`; the marked objects' current
 * values are in `objects`; then the outline (the page now), the vocabulary (everything the answer may do) and
 * the answer's format. Built from the layout model and the marks; no rid and no code body of an unmarked object
 * leaves the page. The copy also returns the snapshot the page keeps, with the structure behind each guess, so a
 * pasted answer is judged against what the AI was shown.
 */
import { findNode } from '../layout/model';
import type { LModel, LNode } from '../layout/types';
import { buildOutline, pageSignature, type OutlineNode } from './outline';
import { assignRefs, type RefTable } from './refs';
import { buildColours, buildVocabulary, changeableProps, type PtColour, type PtProp, type PtVocabulary } from './vocabulary';
import { draftTabs, isDraftId, isTabMark, withDrafts } from './drafts';
import { directOps } from './direct';
import { drewOf, guessOf, rawPlace } from './phrases';
import type { PtCopiedMark, PtCopySnapshot, PtMark } from './types';
import type { ColorSetData } from '../types';

export const PT_FORMAT = 'companion.point-and-tell/1';
export const ANSWER_FORMAT = 'companion.point-and-tell.answer/1';

/** The instruction, as the owner approved it. */
export const INSTRUCTION = `This is a page in Corporater BMP and the marks a user drew on it to say what they want changed.
Each mark has \`drew\` (what is on the page, a fact), \`guess\` (our reading of it, which may be wrong or missing) and \`says\` (the user's own words).
Trust \`says\` first, then \`drew\`, then \`guess\`. A cross means the user rejects something: decide from the words and the page whether that is delete, hide or replace.
If a mark is unclear, ask in \`questions\` instead of guessing further. If something cannot be done with the operations listed, put it in \`cannot\`.
Change nothing no mark asks for. Answer with one JSON block in the format below.`;

/** The lines the format needs. Refs and numbers always; the rest only when the copy has what they are about. */
export const FORMAT_LINE = 'Refs come from the outline (t1, c2, o3 ...) or are names you create with "as". Every operation carries its mark\'s number as "note". "objects" holds the current values of the marked objects; "vocabulary" is everything an operation may use.';
export const HANDLED_LINE = 'A mark with "handled": true is already taken care of: do not answer it again.';
export const TAB_LINE = 'Companion adds a tab the user drew itself (its "as" name, n1 ...): never add it, but put things into it with {"into": "n1"}.';
export const NEW_PAGE_LINE = 'The page does not exist yet: Companion creates it empty first. Its drawn tabs are in the outline as "new".';
export const SHOT_LINE = 'The attached picture shows the same numbers.';

/** What the page knows about an object beyond the layout (version 1.1: text properties and code, read on Copy). */
export interface ObjectExtras { text?: Record<string, string>; code?: Record<string, string>; /** Code properties too long to include. */ omitted?: string[] }

export interface PayloadInput {
  model: LModel;
  marks: PtMark[];
  colors: ColorSetData[] | null;
  liveTabId: string | null;
  scope: 'template' | 'instance';
  now: number;
  extras?: Record<string, ObjectExtras>;
  /** A screenshot was taken in this session since the last Clear. */
  screenshot?: boolean;
  /** The page does not exist yet (a paper page). */
  newPage?: boolean;
}

/** What the AI is told about a marked object that the outline does not say. */
export interface ObjectOut {
  id: string;
  now?: Record<string, unknown>;
  text?: Record<string, string>;
  code?: Record<string, string>;
  /** Code properties that exist but are too long to include: the answer cannot replace them whole. */
  codeTooLong?: string[];
}

export interface MarkOut {
  n: number;
  /** What is on the page; absent for a note about the page. */
  drew?: string;
  /** What Companion thinks that means; absent when it has no reading. */
  guess?: string;
  /** The user's words, unchanged; absent when there are none. */
  says?: string;
  /** Companion stages this mark itself: do not answer it. */
  handled?: true;
}

export interface PtPayload {
  page: { type: string; id?: string; name: string; scope?: 'template'; shownTab?: string; new?: true };
  marks: MarkOut[];
  objects?: Record<string, ObjectOut>;
  outline: OutlineNode[];
  vocabulary: PtVocabulary;
  answerFormat: { operations: unknown[]; questions: unknown[]; cannot: unknown[] };
}

const refOf = (refs: RefTable, id: string): string | null => refs.byId.get(id)?.ref ?? null;

/** Ramer-Douglas-Peucker: the shape of a stroke in few points. */
export function simplifyStroke(points: Array<[number, number]>, tolerance = 6, max = 24): Array<[number, number]> {
  if (points.length <= 2) return points.map(p => [Math.round(p[0]), Math.round(p[1])]);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const dist = (p: [number, number], a: [number, number], b: [number, number]): number => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = dx * dx + dy * dy;
    if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const rec = (lo: number, hi: number, tol: number): void => {
    let worst = -1, at = -1;
    for (let i = lo + 1; i < hi; i++) { const d = dist(points[i], points[lo], points[hi]); if (d > worst) { worst = d; at = i; } }
    if (worst > tol && at >= 0) { keep[at] = true; rec(lo, at, tol); rec(at, hi, tol); }
  };
  let tol = tolerance;
  for (;;) {
    keep.fill(false); keep[0] = keep[points.length - 1] = true;
    rec(0, points.length - 1, tol);
    if (keep.filter(Boolean).length <= max || tol > 400) break;
    tol *= 1.6;
  }
  return points.filter((_, i) => keep[i]).map(p => [Math.round(p[0]), Math.round(p[1])]);
}

/** The "now" values of one object: columns always; every other property only when it is set or off its default. */
export function nowOf(node: LNode, colourOf: (bid: string) => string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = new Set<PtProp>(changeableProps(node));
  if (node.kind === 'tab') return out;
  out.columns = node.cols.L === 0 ? 6 : node.cols.L;
  // 6 is what BMP shows when a smaller screen has no width of its own: not worth saying.
  if (node.cols.M !== undefined && node.cols.M !== 6) out.columnsMedium = node.cols.M;
  if (node.cols.S !== undefined && node.cols.S !== 6) out.columnsSmall = node.cols.S;
  if (node.height !== undefined && allowed.has('height')) out.height = node.height;
  const s = node.style;
  if (!s) return out;
  const set = (p: PtProp, v: unknown, def: unknown): void => { if (allowed.has(p) && v !== undefined && v !== def) out[p] = v; };
  // A colour the table does not hold is left out: null would read as "no colour".
  const header = s.headerColorBid ? colourOf(s.headerColorBid) : null;
  const font = s.fontColorBid ? colourOf(s.fontColorBid) : null;
  if (header && allowed.has('headerColor')) out.headerColor = header;
  if (font && allowed.has('fontColor')) out.fontColor = font;
  set('shadow', s.shadow, false);
  set('headerStyle', s.headerStyle || undefined, 'INSIDE'); // BMP's own defaults: header inside, a line border
  set('borderStyle', s.borderStyle || undefined, 'LINE');
  set('transparency', s.transparency, 0);
  set('showToolMenu', s.showToolMenu, true);
  set('disableSearch', s.disableSearch, false);
  set('visibility', s.visibility, 'VISIBLE');
  set('shownOnLargeDisplay', s.shownOnLargeDisplay, true);
  set('shownOnMediumDisplay', s.shownOnMediumDisplay, true);
  set('shownOnSmallDisplay', s.shownOnSmallDisplay, true);
  return out;
}

export interface Built {
  payload: PtPayload; snapshot: PtCopySnapshot; refs: RefTable; colours: PtColour[];
  /** The instruction for this copy: the fixed lines and the ones its marks need. */
  instruction: string;
}

/** The instruction with the lines this copy needs. */
export function instructionFor(o: { handled: boolean; tabs: boolean; newPage: boolean; screenshot: boolean }): string {
  return [INSTRUCTION, FORMAT_LINE, ...(o.handled ? [HANDLED_LINE] : []), ...(o.tabs ? [TAB_LINE] : []), ...(o.newPage ? [NEW_PAGE_LINE] : []), ...(o.screenshot ? [SHOT_LINE] : [])].join('\n');
}

export function buildPayload(input: PayloadInput): Built {
  const { model, marks } = input;
  // The tabs the user drew are in the outline ("new") with refs of their own; the real model is what everything else reads.
  const drafts = draftTabs(marks);
  const shown = withDrafts(model, drafts);
  const refs = assignRefs(shown);
  const inUse = new Set<string>();
  for (const m of marks) for (const id of m.targets) {
    const st = findNode(model, id)?.node.style;
    if (st?.headerColorBid) inUse.add(st.headerColorBid);
    if (st?.fontColorBid) inUse.add(st.fontColorBid);
  }
  const colours = buildColours(input.colors, inUse);
  const refOfBid = new Map(colours.flatMap(c => [[c.bid, c.ref] as const, ...(c.same ?? []).map(b => [b, c.ref] as const)]));
  const colourOf = (bid: string): string | null => refOfBid.get(bid) ?? null;

  const liveRef = input.liveTabId ? refOf(refs, input.liveTabId) : null;
  const ctx = { refs, ...(liveRef ? { shownTab: liveRef } : {}) };
  const direct = directOps(marks, refs);
  const handledNotes = new Set(direct.map(o => o.notes[0]));

  const now: PtCopySnapshot['now'] = {};
  const objects: Record<string, ObjectOut> = {};
  const copied: PtCopiedMark[] = [];
  const markOut: MarkOut[] = marks.map(m => {
    // A mark Companion stages itself needs nothing from the AI: its objects are not repeated.
    for (const id of handledNotes.has(m.n) ? [] : m.targets) {
      const node = findNode(model, id)?.node;
      const ref = refOf(refs, id);
      if (!node || !ref || objects[ref]) continue;
      const nowVals = nowOf(node, colourOf);
      now[id] = nowVals;
      // The outline says the type, the name and the columns; only what it does not say is repeated here.
      const { columns: _columns, ...more } = nowVals;
      const ex = input.extras?.[id];
      objects[ref] = {
        id: node.id,
        ...(Object.keys(more).length ? { now: more } : {}),
        ...(ex?.text && Object.keys(ex.text).length ? { text: ex.text } : {}),
        ...(ex?.code && Object.keys(ex.code).length ? { code: ex.code } : {}),
        ...(ex?.omitted?.length ? { codeTooLong: ex.omitted } : {}),
      };
    }
    const draft = isTabMark(m) ? drafts.find(d => d.id === `draft:${m.n}`) : undefined;
    const drew = drewOf(m, ctx);
    const guess = guessOf(m, ctx, draft);
    const says = m.text.trim();
    // A drawn tab is always added by Companion (named or not), and so is a named widget sketch or a move with no words.
    const handled = handledNotes.has(m.n) || !!draft;
    const mean = m.meaning;
    const place = mean?.kind === 'add' ? rawPlace(ctx, mean.place) : mean?.kind === 'move' ? rawPlace(ctx, mean.to) : null;
    copied.push({
      n: m.n, text: m.text, targets: m.targets,
      ...(drew ? { drew } : {}), ...(guess ? { guess } : {}), ...(handled ? { handled: true as const } : {}),
      ...(mean?.kind === 'add' && !mean.tab && !mean.page ? { add: { ...(mean.widget ? { widget: mean.widget } : {}), ...(mean.types?.length ? { types: mean.types } : {}), ...(mean.columns ? { columns: mean.columns } : {}), ...(place ? { place } : {}) } } : {}),
      ...(mean?.kind === 'move' ? { move: { ...(place ? { to: place } : {}), ...(mean.columns ? { columns: mean.columns } : {}) } } : {}),
    });
    return { n: m.n, ...(drew ? { drew } : {}), ...(guess ? { guess } : {}), ...(says ? { says } : {}), ...(handled ? { handled: true as const } : {}) };
  });

  const realRefs = refs.entries.filter(e => !isDraftId(e.id));
  const payload: PtPayload = {
    page: {
      type: model.pageClass,
      ...(input.newPage ? { new: true as const } : { id: model.pageId }),
      name: model.pageName ?? model.pageId,
      ...(input.scope === 'template' ? { scope: 'template' as const } : {}),
      ...(liveRef ? { shownTab: liveRef } : {}),
    },
    marks: markOut,
    ...(Object.keys(objects).length ? { objects } : {}),
    outline: buildOutline(shown, refs),
    vocabulary: buildVocabulary(model, colours),
    answerFormat: {
      operations: [
        { note: 1, op: 'change', ref: 'o3', property: 'columns', value: 2 },
        { note: 2, op: 'move', ref: 'o7', to: { after: 'o5' } },
        { note: 3, op: 'add', type: 'BarChart', name: 'Risks by owner', place: { after: 'o5' }, properties: { columns: 2 }, as: 'n2' },
        { note: 4, op: 'delete', ref: 'o8' },
      ],
      questions: [{ note: 5, text: '...' }],
      cannot: [{ note: 6, text: '...' }],
    },
  };
  const snapshot: PtCopySnapshot = {
    at: input.now,
    sig: pageSignature(model),
    scope: input.scope,
    refs: realRefs,
    colors: Object.fromEntries(colours.map(c => [c.ref, c.bid])),
    now,
    marks: copied,
    ...(drafts.length ? { drafts } : {}),
    ...(direct.length ? { direct } : {}),
  };
  const instruction = instructionFor({ handled: copied.some(c => c.handled), tabs: drafts.length > 0, newPage: !!input.newPage, screenshot: !!input.screenshot });
  return { payload, snapshot, refs, colours, instruction };
}

/** The JSON, laid out to be read: each mark, each object, each top-level tab and each part of the vocabulary on a line of its own. */
export function formatPayload(p: PtPayload): string {
  const line = (v: unknown): string => JSON.stringify(v);
  const list = (items: unknown[]): string => `[\n${items.map(i => `  ${line(i)}`).join(',\n')}\n ]`;
  const object = (o: Record<string, unknown>): string => `{\n${Object.entries(o).map(([k, v]) => `  ${line(k)}: ${line(v)}`).join(',\n')}\n }`;
  const parts = [
    ` ${line('page')}: ${line(p.page)}`,
    ` ${line('marks')}: ${list(p.marks)}`,
    ...(p.objects ? [` ${line('objects')}: ${object(p.objects as unknown as Record<string, unknown>)}`] : []),
    ` ${line('outline')}: ${list(p.outline)}`,
    ` ${line('vocabulary')}: ${object(p.vocabulary as unknown as Record<string, unknown>)}`,
    ` ${line('answerFormat')}: ${object(p.answerFormat as unknown as Record<string, unknown>)}`,
  ];
  return `{\n${parts.join(',\n')}\n}`;
}

/** The text that goes on the clipboard: the instruction, a blank line, the JSON. */
export function clipboardText(payload: PtPayload, instruction: string = INSTRUCTION): string {
  return `${instruction}\n\n${formatPayload(payload)}\n`;
}
