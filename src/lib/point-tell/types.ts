/**
 * Point and tell: the shapes. Pure types, no DOM and no chrome.
 *
 * A MARK is what the user left on the page. It is deliberately richer than "a note on one object", so
 * a drawing layer (freehand strokes, arrows, boxes) can be added beside the click-to-note behaviour
 * without changing the store, the payload or the answer:
 *
 *   - a number (shown on the pin, quoted in the answer's `note`);
 *   - optional words;
 *   - zero, one or several target objects (zero is a note for the page or a place; several is a group);
 *   - an optional structured meaning: `move` (with a destination), `add` (with a place), `crossed`
 *     (struck out: the words and the context say whether that is a delete, a hide or a replace),
 *     `change`, or none;
 *   - optional raw ink: strokes as point arrays in page coordinates, plus the place they cover in
 *     page-grid terms (tab, container, row, columns, the objects underneath).
 *
 * Objects are named by their model id (the BMP business ID), never by a rid and never by a ref: refs
 * (t1, c2, o3 ...) exist only inside one copied payload.
 */

/** A point in page (document) coordinates, px. */
export type PtPoint = [number, number];

/** One freehand stroke: points in the order they were drawn, and the pen's radius at each (px). The points
 *  are in page coordinates as drawn; `PtInk.anchor` says what they follow when the layout moves. */
export interface PtStroke { points: PtPoint[]; r?: number[] }

/** A place in the layout, relative to one object: before it, after it, or inside it (a tab or container). */
export type PtPlace = { before: string } | { after: string } | { into: string };

/** What a sketched widget was read as: a box with lines across, a box with bars, a small rounded box, wavy lines. */
export type PtWidgetKind = 'table' | 'chart' | 'button' | 'text';

/** What a mark asks for, in structure. `words` is the plain sentence the resolver wrote for it. */
export type PtMeaning =
  | { kind: 'move'; to: PtPlace; /** The width of the square the arrow ended in. */ columns?: number; words?: string }
  | { kind: 'add'; place: PtPlace; columns?: number; widget?: PtWidgetKind; /** Widget types of the add list that fit the sketch; the answer picks one. */ types?: string[]; /** A tab drawn on the tab row: the mark's words are its name; the place is beside another tab. */ tab?: true; /** A page drawn past the last breadcrumb: the mark's words are its name. */ page?: true; words?: string }
  | { kind: 'crossed' }
  | { kind: 'change' };

/** Where ink sits, in page-grid terms: the tab and container it is in, the row and the first column
 *  (1..6) and the width in columns, and the objects it covers. */
export interface PtGridPlace {
  tabId?: string;
  containerId?: string;
  row?: number;
  col?: number;
  cols?: number;
  over?: string[];
}

/** The object a mark's ink follows, and its box (page coordinates) when the ink was drawn. */
export interface PtAnchor { id: string; box: { left: number; top: number; width: number; height: number } }

/** Raw ink of a mark. The strokes are kept as drawn; the payload sends a simplified copy. */
export interface PtInk { strokes: PtStroke[]; place: PtGridPlace; anchor?: PtAnchor }

export interface PtMark {
  n: number;
  /** The user's words; may be empty (an arrow or a circle can stand alone). */
  text: string;
  /** Object ids the mark points at. Empty: a note for the page, or for a place (see `meaning`, `ink`). */
  targets: string[];
  meaning?: PtMeaning;
  /** The one quiet line the page shows for what the ink was read as ("Move Export before Add risk"); dropped with the reading. */
  reading?: string;
  /** An arrow from empty space onto an object (not a loop round it): both read as "about this". */
  pointer?: true;
  ink?: PtInk;
  /** Set after the mark's operations were staged in Blueprint and not yet applied. */
  staged?: boolean;
  /** When it was made (ms since epoch). */
  at: number;
}

// ── Copy and answer ─────────────────────────────────────────────────────────────────────────────

/** One object of the page as the copied outline knew it. `rid` stays here, in the page, and is never copied. */
export interface PtRefEntry { ref: string; id: string; rid?: string; kind: 'tab' | 'container' | 'widget'; className: string; name: string }

/** A tab the user drew that BMP does not have yet: its temporary id (`draft:<mark number>`), its ref in the "as" namespace (n1, n2 ...), its name and where it goes. */
export interface PtDraft { ref: string; id: string; name: string; /** The tab it goes beside: a real tab's id, or another draft's id. */ anchor?: string; before?: boolean }

/** One mark as copied: its words and targets, what the AI was told it drew and guessed, and the structure behind the guess (refs, not ids). */
export interface PtCopiedMark {
  n: number; text: string; targets: string[];
  drew?: string; guess?: string; handled?: true;
  /** The sketch kind, the widget types that fit it, the width and the place, as the guess was made. */
  add?: { widget?: PtWidgetKind; types?: string[]; columns?: number; place?: PtRawPlace };
  move?: { to?: PtRawPlace; columns?: number };
}

/** What a copy remembers, so a pasted answer can be judged against the page the AI saw. */
export interface PtCopySnapshot {
  at: number;
  /** Signature of the page when copied (outline.pageSignature). */
  sig: string;
  /** Which model the copy described. */
  scope: 'template' | 'instance';
  refs: PtRefEntry[];
  /** ref -> the colour (CorpoColor businessId) it stood for. */
  colors: Record<string, string>;
  /** object id -> the "now" values the AI was given for it. */
  now: Record<string, Record<string, unknown>>;
  /** The marks as copied, by number: their text and target ids. */
  marks: Array<PtCopiedMark>;
  /** Tabs the user drew (new): the answer must not add them again. */
  drafts?: PtDraft[];
  /** What can be staged without an AI: the operations the marks say on their own (see direct.ts). */
  direct?: PtOp[];
}

export type PtOpKind = 'change' | 'move' | 'add' | 'delete';

/** A place as an answer writes it: one of the three, naming a ref. */
export interface PtRawPlace { before?: string; after?: string; into?: string }

/** One operation of an answer, as parsed (not yet judged). */
export interface PtOp {
  /** The marks it serves (the first one groups it in the tray). */
  notes: number[];
  /** 'unknown' when the answer used a verb that is not one of the four; `verb` keeps what it wrote. */
  op: PtOpKind | 'unknown';
  verb?: string;
  ref?: string;
  property?: string;
  value?: unknown;
  to?: PtRawPlace;
  place?: PtRawPlace;
  type?: string;
  name?: string;
  properties?: Record<string, unknown>;
  as?: string;
}

export interface PtQuestion { notes: number[]; text: string }

export interface PtAnswer {
  operations: PtOp[];
  questions: PtQuestion[];
  cannot: PtQuestion[];
}

export type PtParse = { ok: true; answer: PtAnswer } | { ok: false; error: string };
