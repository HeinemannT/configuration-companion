/**
 * Point and tell: the single `pt` state object, data only. Actions change it and call view.render();
 * the view reads it. The mode lives in the Blueprint bundle (it needs the layout model and Blueprint's
 * geometry) but owns its own folder, layer and styles.
 */
import type { BlueprintCtx } from '../lib/layout/sync';
import type { LModel } from '../lib/layout/types';
import type { PtMark } from '../lib/point-tell/types';
import type { PtScene } from '../lib/point-tell/resolve';
import type { PtTarget } from '../lib/point-tell/hit';
import type { PtStageResult } from '../lib/point-tell/stage';
import type { PtAnswer, PtCopySnapshot } from '../lib/point-tell/types';
import type { InkCanvas } from './ink-canvas';

export const LAYER_ID = 'crev-pointtell-layer';
export const STYLE_ID = 'crev-pointtell-style';

/** The note field: which mark it is for (a number, or a new one), and what it is about. */
export interface PtEditor {
  /** An existing mark's number, or null for a new one. */
  n: number | null;
  targets: string[];
  /** Words so far. */
  text: string;
  /** A note for the page (no object, no ink). */
  page: boolean;
  /** Where the pen lifted (page coordinates): the field sits beside it. */
  lift?: [number, number];
}

/** What the pointer draws with: the brush pen, or the eraser that takes strokes. */
export type PtToolId = 'pen' | 'eraser';

/** What a pasted answer came to: judged against the copy, ready to show and to stage. */
export interface PtAnswerView {
  /** The pasted text, kept in the field. */
  text: string;
  /** The answer could not be read: the one sentence. */
  error?: string;
  /** A sentence above the result (the page changed, or could not be read again). */
  banner?: string;
  result?: PtStageResult;
  answer?: PtAnswer;
  snapshot?: PtCopySnapshot;
  /** The page is being read again before the answer is judged. */
  busy?: boolean;
}

/** A page drawn past the last breadcrumb, while its paper page is open: what the real page had, put aside until it is closed. */
export interface PtPageDraft {
  /** The mark that drew it (in the real page's set). */
  n: number;
  name: string;
  shelf: { model: LModel; ctx: BlueprintCtx | null; scope: 'template' | 'instance'; links: Record<string, string>; paper: string | null; marks: PtMark[]; next: number };
}

/** The card that creates the page: what is created, where, and what BMP said to a dry run. */
export interface PtCard {
  input: { text: string; snapshot: PtCopySnapshot; result: PtStageResult };
  kind: 'Scorecard' | 'ModelPage';
  id: string;
  /** The ID was typed: it is no longer proposed from the name. */
  idEdited: boolean;
  parentRid: string;
  parents: Array<{ rid: string; name: string }>;
  status: 'checking' | 'ready' | 'error' | 'creating';
  error?: string;
  previewId?: string;
}

export interface PtState {
  active: boolean;
  /** Session counter: in-flight work from an earlier session checks it and drops its result. */
  gen: number;
  /** The BMP object the page shows (a 64-bit rid, always a string). */
  rid: string;
  /** loading: reading the layout; ready: marks can be written; unavailable: the page has no layout to point at. */
  phase: 'idle' | 'loading' | 'ready' | 'unavailable';
  /** The one sentence shown when `phase` is 'unavailable'. */
  failure: string | null;

  // The page, as read.
  model: LModel | null;
  ctx: BlueprintCtx | null;
  env: string | null;
  /** Which layout the marks point at: the shared template (Blueprint's default) or this page itself. */
  scope: 'template' | 'instance';
  /** Instance widget rid -> template widget id (templated pages only). */
  links: Record<string, string>;
  /** What the page shows right now, measured. */
  scene: PtScene | null;
  /** Objects on screen that the layout does not hold (an instance widget while pointing at the template). */
  foreign: PtTarget[];

  // Marks.
  marks: PtMark[];
  next: number;
  /** The one-line notice about what leaves the browser was shown. */
  noticed: boolean;
  hover: { id: string; foreign: boolean; tag: string } | null;
  tool: PtToolId;
  editor: PtEditor | null;
  /** The bar's list of marks is open. */
  listOpen: boolean;
  /** The paste panel or the result of a pasted answer is open. */
  sheet: 'paste' | null;
  answer: PtAnswerView | null;
  /** The drawn tab shown as paper (its draft id), or null: BMP's own tab. */
  paper: string | null;
  /** The paper page of a drawn page is open (null: the real page). */
  page: PtPageDraft | null;
  card: PtCard | null;
  /** The menu asked for a new page before the layout was read. */
  wantPage: boolean;
  /** A screenshot was taken since the last Clear: the copy says the picture shows the same numbers. */
  shot: boolean;
  /** Chrome's prompt to share this tab is open, so the Screenshot button shows it waits. Nothing else is held. */
  shotWaiting: boolean;
  /** "Click again to clear" is armed. */
  clearArm: boolean;
  clearTimer: number;

  // DOM.
  layer: HTMLElement | null;
  surface: HTMLElement | null;
  dock: HTMLElement | null;
  ink: InkCanvas | null;
  hoverEl: HTMLElement | null;
  pinLayer: HTMLElement | null;
  paperEl: HTMLElement | null;
  cardEl: HTMLElement | null;
  fieldEl: HTMLElement | null;
  panelEl: HTMLElement | null;
  sheetEl: HTMLElement | null;

  // Listeners and watchers.
  onResize: (() => void) | null;
  onScroll: (() => void) | null;
  onPop: (() => void) | null;
  onKey: ((e: KeyboardEvent) => void) | null;
  observer: MutationObserver | null;
  resizeObs: ResizeObserver | null;
  ridSig: string;
  raf: number;
  mutRaf: number;
  bodyResizeTimer: number;
}

function freshState(): Omit<PtState, 'gen'> {
  return {
    active: false, rid: '', phase: 'idle', failure: null,
    model: null, ctx: null, env: null, scope: 'template', links: {}, scene: null, foreign: [],
    marks: [], next: 1, noticed: false, hover: null, tool: 'pen', editor: null, listOpen: false, sheet: null, answer: null, paper: null, page: null, card: null, wantPage: false, shot: false, shotWaiting: false, clearArm: false, clearTimer: 0,
    layer: null, surface: null, dock: null, ink: null, hoverEl: null, pinLayer: null, paperEl: null, cardEl: null, fieldEl: null, panelEl: null, sheetEl: null,
    onResize: null, onScroll: null, onPop: null, onKey: null, observer: null, resizeObs: null, ridSig: '', raf: 0, mutRaf: 0, bodyResizeTimer: 0,
  };
}

export const pt: PtState = { gen: 0, ...freshState() };

/** Every per-session field back to idle; `gen` keeps counting. */
export function resetState(): void { Object.assign(pt, freshState()); }
