/**
 * Transport window state. Two tabs:
 *
 *  - Find: one box and three filter buttons. With nothing in the box and no
 *    date, the chosen areas as a tree, each node read when it opens (children,
 *    then their counts). Otherwise a result list, a tree per group
 *    (transport-model.ts): words that must all match (the longest searched
 *    on the workspace; a single word that can be an ID also opens that object
 *    with what is under it), a pasted list of IDs, objects changed since a
 *    day, or the objects of the BMP page the window sits on. A row's tick box
 *    says whether the object is in the transport; the end button takes
 *    everything under it as a folder taken whole (one line, read again at
 *    every comparison), or the matches under it. A new search replaces the
 *    result list; the transport stays. The scan engine below (`scope`,
 *    `scan()`) is what the box drives.
 *  - Transport: the collection (transport-collection.ts), an ordered set of
 *    objects by RID kept per workspace as a dated draft in local storage; a
 *    target (a connected workspace, a comparison by pasted script, or scripts
 *    for any workspace without comparison); Compare or Build scripts; what
 *    each object's comparison says; what the objects use, read with their
 *    text; what uses one object, read on request.
 *
 * Every read is one request at a time, stoppable, behind a user action. A
 * patch is compared and applied by Companion when it is connected to the
 * target (DirectPhase), or the comparison script is pasted by a person. No
 * DOM: the worker is reached through the injected `TransportDeps`, so tests
 * drive it with fake senders.
 */

import {
  addressOf, assembleBundle, checkAddress, isScanDay, isStartSpace, isTransportRoot, parseScanStart, START_ID, TRANSPORT_DEFAULT_ROOTS, TRANSPORT_READ_BATCH, TRANSPORT_ROOTS,
  TRANSPORT_SCAN_TOTAL, addressKey, FILE_LIMIT_KB_DEFAULT, fileContent, fileLimitChars, fileLimitKb, isPropertyDefinition, objectAtLine, SCHEDULE_CLASS, splitAddress,
  type BundleInput, type TransportBundle, type TransportRoot, type UploadFile,
} from '../lib/transport-bundle';
import {
  assemblePatch, buildProbe, checkSaysReady, createdTimesText, NO_CHANGES_LINE, parseCreatedTimes, PATCH_STEPS, propertyDefinitionRids, parseProbeAnswer, storedNothing, transportEntryId,
  type PatchCounts, type PatchPart, type PatchStep, type ProbeAnswer, type ProbeAnswerErrorKind, type TransportPatch, type TransportProbe,
} from '../lib/transport-patch';
import {
  isFactAddress, searchText, TRANSPORT_FACTS_BATCH, TRANSPORT_FACTS_CAP,
  type TransportCreationRead, type TransportFact, type TransportLogEntry, type TransportObjectRead, type TransportRowRead, type TransportScanRow, type TransportTarget, type TransportUser,
} from '../lib/transport-read';
import type { InspectorMessage } from '../lib/types';
import {
  buildUndoPlan, buildUndoRecord, finishUndoRecord, keptLines, readUndoRecord, undoKey, type UndoPlan, type UndoRecord,
} from '../lib/transport-undo';
import {
  AREA_LABELS, BOX_DEBOUNCE_MS, buildGroupTree, dayOf, holdsWords, isNewRow, isNumericId, MATCH, NO_FILTERS, orderedAreas, rankOf, readBox, rowMatches, showTree, sinceDay, sortRows, wordsOf,
  type Filters, type GroupTree, type SinceKey, type TreeNode, type TreeShow,
} from './transport-model';
import {
  draftFileContent, draftFileLimit, draftKey, itemStates, mapModel, placeGroups, readDraft, rootOfId, toDraft, transportLines, useKind, usesIndex, TransportCollection,
  type CollectionItem, type ItemStateInfo, type PlaceGroup, type PlaceStep, type TransportMapModel, type UsesIndex, type UseState, type WholeFolder,
} from './transport-collection';

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

/** How long the window waits for one scan answer: the worker's own limit
 *  plus time queued behind another request of the same server. */
export const SCAN_WAIT_MS = 150_000;
/** How long the window waits for one batch read. */
export const READ_WAIT_MS = 200_000;
/** A group with more rows than this starts closed, and its nodes below the
 *  first level too. */
export const OPEN_GROUP_LIMIT = 500;
/** How long the window waits for one part run on a target: the worker's own
 *  limit (TRANSPORT_PART_TIMEOUT_MS) plus time queued behind another request. */
export const PART_WAIT_MS = 200_000;
/** Above this many characters of script text, the confirmation says that it
 *  stays in the target server's memory until it restarts (script-kinds.ts). */
export const TRANSPORT_APPLY_WARN_CHARS = 2_000_000;
/** Characters of a server message shown at most. */
export const MESSAGE_SHOWN = 600;
/** Lines of a Check answer shown at most. */
export const CHECK_LINES_SHOWN = 40;
/** IDs an ID list looks up at most. */
export const ID_LIST_MAX = 500;

export interface TransportConnection {
  /** The server profile token requests are bound to. */
  environment: string;
  /** The workspace's name for people (file names). */
  label: string;
}

/** Local storage for the draft (chrome.storage.local in the window). */
export interface DraftStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface TransportDeps {
  /** Send a request to the worker; resolves with its answer (undefined
   *  when there is none), rejects on time-out, abort or a worker that
   *  cannot be reached. */
  request(msg: InspectorMessage, timeoutMs: number, signal: AbortSignal): Promise<InspectorMessage | undefined>;
  /** Send without waiting for an answer. */
  post(msg: InspectorMessage): void;
  /** The window's server, or null when the page has none. */
  connection(): Promise<TransportConnection | null>;
  now(): Date;
  /** Where the draft is kept; without it nothing is kept. */
  store?: DraftStore;
}

export type AreaStatus = 'waiting' | 'scanning' | 'done' | 'missing' | 'failed' | 'stopped';

/** The one group of a search under an object. */
export const UNDER = 'under' as const;
/** The group of an ID list. */
export const IDLIST = 'idlist' as const;
/** The group of the objects on the page. */
export const ONPAGE = 'onpage' as const;
/** A group of the result list: an area, or the result of one other way. */
export type GroupKey = TransportRoot | typeof UNDER | typeof IDLIST | typeof ONPAGE;

/** One step of reading a cut scan to the end: list the children of an
 *  object (`rid` '': of the area's root), or read one child and what is
 *  under it. */
export type RestTask = { kind: 'children'; rid: string } | { kind: 'below'; rid: string };

/** Reading a cut scan to the end, child by child. */
export interface RestState {
  status: 'reading' | 'stopped' | 'done';
  /** What is left, first in first out (breadth-first). */
  todo: RestTask[];
  /** Steps that failed; Try again runs only these. */
  failed: RestTask[];
  /** Children already queued, by RID. */
  queued: Set<string>;
  /** The group reached TRANSPORT_SCAN_TOTAL rows: nothing more is read. */
  full: boolean;
}

/** Looking up the used objects of "Add them". */
export interface RefsState {
  status: 'reading' | 'stopped';
  addresses: string[];
  /** Looked up so far. */
  done: number;
  found: TransportScanRow[];
  requestId?: string;
  abort?: AbortController;
}

/** How Find finds its objects. */
export type ScanScope = 'changed' | 'under' | 'search' | 'ids' | 'page';

export interface AreaResult {
  root: GroupKey;
  status: AreaStatus;
  /** Sorted by class, then ID; under an object, the starting object first. */
  rows: TransportScanRow[];
  /** More than the cap: the rows are cut. */
  more: boolean;
  error?: string;
  /** Under an object: the starting object's row. */
  origin?: TransportScanRow;
  /** The cut rows are being, or were, read to the end. */
  rest?: RestState;
  /** An ID list: the IDs no object has, and the entries that are no ID. */
  notFound?: string[];
  invalid?: string[];
}

export interface ScanRun {
  roots: GroupKey[];
  /** Position of the area being read (0-based). */
  index: number;
  current: GroupKey;
  stopped: boolean;
  /** Reading the rest of a cut group, not a scan. */
  rest?: boolean;
  /** An ID list or the page: done of total. */
  done?: number;
  total?: number;
  requestId?: string;
  abort?: AbortController;
}

/** How the last scan ended. */
export type ScanOutcome = { kind: 'done' | 'stopped' | 'failed'; areas: number; of: number };

/** What the transport is built into: scripts that replay the full state of
 *  each object on any workspace, or a comparison with one target. */
export type BuildMode = 'any' | 'target';

/** The target picker's value: a connected workspace (`env:<environment>`),
 *  a comparison by pasted script, or scripts without comparison. */
export type TargetChoice = string;
export const CHOICE_PASTE = 'paste';
export const CHOICE_ANY = 'any';
export const choiceOf = (environment: string): TargetChoice => `env:${environment}`;

/** What "Add them" looks up: used objects, parents, or steps of flow projects. */
export type NeedKind = 'uses' | 'parents' | 'steps';
export const NEED_KINDS: readonly NeedKind[] = ['uses', 'parents', 'steps'];
/** The most rounds of "Add what is missing and compare again". */
export const MISSING_ROUNDS = 6;

/** The `generate(true)` text of the property definitions (their links),
 *  read after the target's answer. */
export interface CreationState {
  status: 'reading' | 'stopped' | 'failed' | 'done';
  /** The property definitions whose text the patch needs, in list order. */
  rids: string[];
  error?: string;
  requestId?: string;
  abort?: AbortController;
}

/** The comparison: the comparison script, the answer and the scripts built from it. */
export interface TargetState {
  probe: TransportProbe;
  /** Creation texts read so far, by RID (kept across answers). */
  texts: Map<string, TransportCreationRead>;
  /** The creation read for the current answer. */
  creation?: CreationState;
  /** The pasted text as it was last read (kept when it fails). */
  answerText: string;
  answerError?: { kind: ProbeAnswerErrorKind | 'patch'; error: string };
  answer?: ProbeAnswer;
  patch?: TransportPatch;
  /** Clear values only the target has. */
  clearExtra: boolean;
  /** Add a transport log entry on the target. */
  record: boolean;
  recordTitle: string;
  /** Fixed when the record option is turned on. */
  recordEntryId?: string;
  /** The comparison lists what the target has under one object: its
   *  address, and the IDs of every object under it here. */
  listing?: { start: string; ids: string[] };
  /** What this workspace has under the listing start, read again at every
   *  comparison (its IDs, its own included); absent until read or when the
   *  read failed (`sourceError`): then nothing counts as only on the target. */
  sourceIds?: string[];
  sourceError?: string;
  /** Delete the objects only the target has. */
  deleteExtra: boolean;
  /** ID changes (RenameHint.key) turned off. */
  renamesOff: Set<string>;
  /** Compared and applied by Companion on a connected target (no paste). */
  direct?: DirectState;
  /** The scripts shown are the undo of this apply (UndoPlan). */
  undoOf?: UndoRecord;
  undoPlan?: UndoPlan;
  /** Objects of the transport that could not be read here: nothing is
   *  deleted on the target. */
  unreadHere?: number;
}

/** Where comparing or applying stopped or failed. */
export type ApplyStage = 'compare' | 'check' | 'dryrun' | 'apply' | 'verify';

/**
 * Comparing with and applying to a connected target:
 * idle → comparing → reviewed → confirming → applying (part i) → verifying →
 * done, or failed (where, and why), or stopped (after part i). A failure or
 * a stop while applying leaves only Compare again: the scripts are no longer
 * what the target needs.
 */
export type DirectPhase =
  | { kind: 'idle' }
  | { kind: 'comparing'; part: number; total: number }
  | { kind: 'reviewed' }
  | { kind: 'confirming' }
  | { kind: 'applying'; part: number; total: number; step: PatchStep; stepIndex: number; stepTotal: number; startedAt: number }
  /** Each committed part run once as a preview before the first write. */
  | { kind: 'trying'; part: number; total: number }
  | { kind: 'verifying'; part: number; total: number }
  /** Applied and compared again: `remaining` objects and deletes still differ.
   *  An undo: `undone`, and the added objects it `kept`. */
  | { kind: 'done'; remaining: number; undone?: true; kept?: number }
  | {
    kind: 'failed'; stage: ApplyStage; error: string;
    /** The part that failed (1-based among the parts of the run) and its step. */
    part?: number; total?: number; step?: PatchStep;
    /** The Check part's lines (it did not say Ready); the dry run's lines. */
    lines?: string[];
    /** The dry run: the objects its lines name (addresses), in order. */
    objects?: string[];
    /** A committed part whose answer did not arrive: it may have been applied. */
    unknown?: boolean;
    /** Committed parts applied before it. */
    applied?: number;
  }
  | { kind: 'stopped'; stage: 'compare' | 'apply'; after: number; total: number; applied: number };

export interface DirectState {
  target: TransportTarget;
  phase: DirectPhase;
  /** The target whose comparison the current answer is (the apply refuses
   *  any other). */
  answerFrom?: string;
  /** The files added without content by the last apply (the outcome lists them). */
  uploads?: UploadFile[];
  /** Stop asked: before the next part. */
  stopping: boolean;
  /** After the creation texts are read: reviewed (a comparison) or done
   *  (the comparison after an apply). */
  then?: 'reviewed' | 'done';
  requestId?: string;
  abort?: AbortController;
}

/** Lines of a dry run that say a part would fail, at most. */
export const DRY_RUN_LINES = 20;

/**
 * The lines of a part's preview that say it would fail when run committed:
 * a value that cannot be written, a value the class does not have, a class
 * that cannot be under its parent, a run that stored nothing. "Missing
 * value for" lines are not among them: a later part only sees what earlier
 * parts would add inside its own run, so in a preview most of its
 * statements are skipped by their guards (measured on 5.6.17).
 */
export function dryRunProblems(log: string): string[] {
  return log.split(/\r\n?|\n/).map(l => l.trim()).filter(l => /Failed to write|Property .+ not found\b|Can't add an object of type|No changes done due to errors/.test(l));
}

/**
 * A dry-run line with the object it is about, when known: from "at line n"
 * (the part's statement on that line, BundlePart.spans; the line and column
 * are then left out) or from an ID of the transport named in it ("Failed to
 * write" names the object's ID and name). "Add · t.x: Property p not found".
 */
export function namedProblem(part: Pick<PatchPart, 'step' | 'spans'>, line: string, ids: ReadonlyMap<string, string>): { text: string; address?: string } {
  const step = PATCH_STEPS[part.step].title;
  const at = /\s*\bat line (\d+)(?:,\s*column \d+)?/.exec(line);
  let address = at ? objectAtLine(part, Number(at[1])) : undefined;
  let text = line;
  if (address) text = (line.slice(0, at!.index) + line.slice(at!.index + at![0].length)).replace(/^\[[A-Z]+\]\s*/, '').trim();
  else {
    for (const w of line.match(/[A-Za-z0-9_]+/g) ?? []) {
      const a = ids.get(w.toLowerCase());
      if (a) { address = a; break; }
    }
  }
  return address ? { text: `${step} · ${address}: ${text}`, address } : { text: `${step}: ${text}` };
}

/** One part run on a target. */
type PartRun = { kind: 'ok'; log: string } | { kind: 'stopped' } | { kind: 'failed'; error: string; unknown?: boolean };

/** The parts an apply runs, in order: the Check parts as previews, then the
 *  committed parts (the Log entry part last when it is there). The Report
 *  is left out: the comparison afterwards is the exact check. */
export function applyParts(patch: TransportPatch): PatchPart[] {
  return patch.parts.filter(p => p.step === 'check' || p.run === 'committed');
}

/** What an apply sends: its parts and their characters. */
export function applySize(patch: TransportPatch): { parts: number; chars: number } {
  const parts = applyParts(patch);
  return { parts: parts.length, chars: parts.reduce((n, p) => n + p.text.length, 0) };
}

/** "12 to add, 30 to change, 4 to move, 2 to delete, 1 ID to change". */
export function applyCounts(c: PatchCounts): string {
  const bits: string[] = [];
  const add = (n: number, words: string) => { if (n) bits.push(`${n.toLocaleString('en-US')} ${words}`); };
  add(c.create, 'to add');
  add(c.change, 'to change');
  add(c.move, 'to move');
  add(c.delete, 'to delete');
  add(c.rename, c.rename === 1 ? 'ID to change' : 'IDs to change');
  return bits.join(', ');
}

/** What still differs: objects to add, change or move, and deletes. */
export const remainingOf = (c: PatchCounts): number => c.create + c.change + c.move + c.delete;

/** A server message for the window: trimmed, at most MESSAGE_SHOWN characters. */
export function shownMessage(text: string): string {
  const t = text.trim();
  return t.length > MESSAGE_SHOWN ? `${t.slice(0, MESSAGE_SHOWN)}…` : t;
}

export interface BundleState {
  mode: BuildMode;
  /** Mode 'target', compared by Companion: the target chosen when it was built. */
  direct?: TransportTarget;
  status: 'reading' | 'stopped' | 'failed' | 'done';
  /** The objects of the transport when it was built, in order. */
  rids: string[];
  /** Their facts then (the transport may change after). */
  items: Map<string, CollectionItem>;
  reads: Map<string, TransportObjectRead>;
  /** "Carry the content of files up to n KB" when it was built. */
  fileLimitKb: number;
  /** "Carry the content of files" when it was built. */
  fileContent: boolean;
  /** What the reads gave, in order (when done). */
  inputs?: BundleInput[];
  /** Mode 'any'. */
  result?: TransportBundle;
  /** Mode 'target'. */
  target?: TargetState;
  error?: string;
  requestId?: string;
  abort?: AbortController;
}

export interface LogState {
  status: 'reading' | 'stopped' | 'failed' | 'done';
  /** Newest first; kept from the last read while a new one runs. */
  entries: TransportLogEntry[];
  more: boolean;
  missingLog: boolean;
  /** Whether a read has finished at least once. */
  read: boolean;
  error?: string;
  requestId?: string;
  abort?: AbortController;
}

/** "Find what uses this" for one object. */
export interface UsedByState {
  status: 'reading' | 'stopped' | 'failed' | 'done';
  users: TransportUser[];
  more: boolean;
  error?: string;
  requestId?: string;
  abort?: AbortController;
}

/** Reading the rows of the transport again (Refresh). */
export interface RefreshState {
  status: 'reading' | 'stopped' | 'failed' | 'done';
  done: number;
  total: number;
  /** Not found any more. */
  gone: number;
  error?: string;
  requestId?: string;
  abort?: AbortController;
}

export type Change =
  | { kind: 'scan' }
  /** The box, a filter button or the way of finding changed: the bar and the list. */
  | { kind: 'find' }
  /** A node of the tree opened, closed, was read, or a count arrived. */
  | { kind: 'browse' }
  /** Taking everything under an object, or an area. */
  | { kind: 'taking' }
  | { kind: 'areas' }
  | { kind: 'area'; root: GroupKey }
  /** A node of a group opened or closed. */
  | { kind: 'node'; root: GroupKey; key: string }
  /** Progress of reading the rest of a group. */
  | { kind: 'rest'; root: GroupKey }
  /** What is in the transport changed. */
  | { kind: 'collection' }
  | { kind: 'filters' }
  | { kind: 'where' }
  | { kind: 'bundle' }
  /** The answer, scripts or their options changed; `partsOnly`: only the parts. */
  | { kind: 'patch'; partsOnly?: boolean }
  /** Comparing with or applying to a connected target. */
  | { kind: 'apply' }
  /** The connected workspaces were read, or the chosen target changed. */
  | { kind: 'targets' }
  | { kind: 'log' }
  /** The tab, or the log opened or closed. */
  | { kind: 'view' }
  /** List or Map. */
  | { kind: 'tview' }
  /** One object's row opened or closed in the transport list. */
  | { kind: 'detail'; rid: string }
  | { kind: 'usedby'; rid: string }
  /** What this workspace has at used addresses: read on. */
  | { kind: 'facts' }
  /** The draft: restored, read again, cleared. */
  | { kind: 'draft' }
  /** "Carry the content of files up to n KB" changed. */
  | { kind: 'fileLimit' };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NOT_CONNECTED = 'Not connected to a server. Open this window on a BMP page Companion is set up for.';
const NO_ANSWER = 'Companion did not answer. Close the window and open it again.';
/** What reading an object says when it is gone. */
const NOT_THERE = 'It is not on this workspace any more.';
const TIMED_OUT = 'The server did not answer in time.';
/** The status line after the comparison script was built again over a pasted answer. */
export const PROBE_CHANGED = 'The comparison script changed: run it again and paste its answer.';
export const NONE_FOUND = 'None of them are on this workspace.';
/** Lower-case root IDs (`portal`): a parent with one of these is a root. */
const ROOT_IDS: readonly string[] = TRANSPORT_ROOTS.map(r => r.toLowerCase());

/** A failed answer that concerns one area or batch only: the server ran the
 *  read and it failed there. A refusal, or a failure of the connection,
 *  stops the whole run. */
function isLocalFailure(res: { errorKind?: string; refused?: boolean }): boolean {
  return !res.refused && (res.errorKind === 'server' || res.errorKind === 'protocol');
}

/** The one line for a request that could not be made or answered. */
function requestFailureLine(e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  if (kind === 'timeout') return TIMED_OUT;
  if (kind === 'no-response') return NO_ANSWER;
  // A refusal by the worker (REQUEST_FAILED) or a worker that cannot be reached.
  return errorText(e) || NO_ANSWER;
}

/** The entries of a pasted ID list: addresses `<space>.<ID>` or IDs (the
 *  `t.` space), separated by spaces, commas, semicolons or lines; each once
 *  (without regard to case), at most ID_LIST_MAX. Entries of another form
 *  are `invalid`. */
export function parseIdList(text: string): { addresses: string[]; invalid: string[]; more: boolean } {
  const seen = new Set<string>();
  const addresses: string[] = [];
  const invalid: string[] = [];
  let more = false;
  // A `.get("…")` form is one entry, whatever it holds.
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]*\.get\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)|[^\s,;]+/g) ?? []) {
    const t = token.trim();
    if (!t) continue;
    const s = parseScanStart(t);
    if (!s.ok) { if (!invalid.includes(t)) invalid.push(t); continue; }
    const k = s.address.toLowerCase();
    if (seen.has(k)) continue;
    if (addresses.length >= ID_LIST_MAX) { more = true; continue; }
    seen.add(k);
    addresses.push(s.address);
  }
  return { addresses, invalid, more };
}

/** A read that can be stopped: its request and its abort. */
interface Holder { requestId?: string; abort?: AbortController; stopped?: boolean }

/** What the box, the filters and the page button ask Find to show. */
export type FindPlan =
  /** The areas as a tree, read as it is opened. */
  | { kind: 'browse' }
  | { kind: 'page' }
  | { kind: 'ids'; text: string }
  | { kind: 'changed'; day: string }
  /** `longest` is searched; `single` is the one word typed, tried as an ID too. */
  | { kind: 'search'; longest: string; single: string | null };

/** The children of one node of the tree (an area, or an object), read once. */
export interface BrowseNode {
  status: 'reading' | 'done' | 'failed';
  /** In the server's order. */
  rows: TransportScanRow[];
  error?: string;
}

/** Taking everything under an object or an area. */
export interface TakingState {
  /** The node's key: `a:<root>` for an area, else the object's RID. */
  key: string;
  label: string;
  holder: Holder;
}

/** The key of an area in the tree. */
export const areaKey = (root: TransportRoot): string => `a:${root}`;

const planKey = (p: FindPlan, chosen: ReadonlySet<TransportRoot>): string => {
  const areas = orderedAreas(chosen).join(',');
  switch (p.kind) {
    case 'browse': return 'browse';
    case 'page': return 'page';
    case 'ids': return `ids:${p.text}`;
    case 'changed': return `changed:${p.day}:${areas}`;
    case 'search': return `search:${p.longest}:${p.single ?? ''}:${areas}`;
  }
};

export class TransportController {
  /** The tab shown. */
  tab: 'find' | 'transport' = 'find';
  /** The transport log is open (over either tab). */
  logOpen = false;
  /** How Find finds its objects. */
  scope: ScanScope = 'changed';
  since: string;
  readonly chosen: Set<TransportRoot>;
  /** Under an object: the object as typed (an ID or `t.<ID>`). */
  start = '';
  /** Under an object: the day, or '' for everything under it. */
  underSince = '';
  /** Search: the text as typed. */
  query = '';
  /** ID list: the text as pasted. */
  idText = '';
  /** The way the shown results were found (null before the first). */
  scannedScope: ScanScope | null = null;
  /** The day the shown results are for ('' for none; null before the first scan). */
  scannedSince: string | null = null;
  /** The starting object's ID the shown results are for (null for other ways). */
  scannedStart: string | null = null;
  /** The text the shown search results are for. */
  searchedText = '';
  /** Its address (`t.<ID>`, `k.<ID>` …). */
  private scannedAddress = '';
  areas: AreaResult[] = [];
  run: ScanRun | null = null;
  outcome: ScanOutcome | null = null;
  /** One line: why nothing could be found or read. */
  error: string | null = null;
  filters: Filters = { ...NO_FILTERS };

  // ── the one box ──
  /** The text in the box. */
  box = '';
  /** How "Changed" is set; `customDay` is the day of a date typed in. */
  sinceKey: SinceKey = 'any';
  customDay = '';
  /** "This page": the objects on the page behind the window. */
  onPage = false;
  /** What Find shows now (or reads now). */
  plan: FindPlan = { kind: 'browse' };
  private shownKey: string | null = null;
  private findSeq = 0;
  private boxTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWaiters: Array<() => void> = [];
  /** A single word searched and also tried as an ID: its text as typed. */
  private searchUnder: string | null = null;
  /** The words typed, as the status line says them. */
  private queryLabel = '';

  // ── the tree ──
  /** Nodes of the tree that are open (area keys, object RIDs). */
  readonly browseOpen = new Set<string>();
  /** Children read, by node key; read once per window until Refresh. */
  readonly browseNodes = new Map<string, BrowseNode>();
  /** Objects under a node (`descendants().size()`), by area key or RID. A
   *  count may include objects Transport never lists. */
  readonly counts = new Map<string, number>();
  private browseIndex = new Map<string, { row: TransportScanRow; area?: TransportRoot }>();
  private browseHolders = new Map<string, Holder>();
  private countHolders = new Set<Holder>();
  private browseStarted = false;
  /** Everything under an object or an area is being read to take it. */
  taking: TakingState | null = null;
  /** The folders taken whole are being read again for a comparison. */
  rereading = false;
  /** Areas taken one by one this window: the RIDs, to take them out again. */
  private areaTaken = new Map<TransportRoot, string[]>();
  private coverMemo: { version: number; index: Map<string, string> } | null = null;
  readonly collapsed = new Set<GroupKey>();
  /** The objects that go. */
  readonly collection = new TransportCollection();
  /** The transport came from a stored draft. */
  draftRestored = false;
  /** The restored draft was read again in this window (Refresh, to the end). */
  draftRefreshed = false;

  /** The transport is a stored draft not read again here: the Apply
   *  confirmation says how old it is. */
  get draftUnread(): boolean {
    return this.draftRestored && !this.draftRefreshed;
  }
  refresh: RefreshState | null = null;
  /** The objects of the last Clear, for Undo. */
  cleared: CollectionItem[] | null = null;
  /** List or Map on the Transport tab. */
  transportView: 'list' | 'map' = 'list';
  /** "Carry the content of files up to n KB" (KB: 1,000 characters of a
   *  file's generated text, its content as gzip-base64; not its size on
   *  disk). Kept per workspace with the draft. */
  fileLimitKb = FILE_LIMIT_KB_DEFAULT;
  /** "Carry the content of files": off by default (reading and writing file
   *  content can be slow and makes the scripts large). Off: a file is read
   *  with its values only and added without content. Kept with the draft. */
  fileContent = false;
  /** Rows opened in the transport list. */
  readonly openRows = new Set<string>();
  /** Places closed in the transport list (keys of PlaceGroup), and large
   *  places (more than OPEN_GROUP_LIMIT objects, closed at first) opened. */
  readonly closedPlaces = new Set<string>();
  readonly openPlaces = new Set<string>();
  /** What Build makes of the transport. */
  mode: BuildMode = 'target';
  bundle: BundleState | null = null;
  log: LogState | null = null;
  /** Looking up used objects ("Add them"). */
  refs: RefsState | null = null;
  /** "Add what is missing and compare again" is running: its round. */
  missing: { round: number; of: number } | null = null;
  private missingStopped = false;
  readonly usedBy = new Map<string, UsedByState>();
  /** What this workspace has at used addresses outside the transport (lower case). */
  readonly facts = new Map<string, TransportFact>();
  /** Reading those facts: never blocks anything else. */
  factsRead: { status: 'reading' | 'stopped' | 'failed' | 'done'; done: number; total: number; error?: string; requestId?: string; abort?: AbortController } | null = null;
  /** One line about what just happened (not an error). */
  notice: string | null = null;
  connection: TransportConnection | null = null;
  /** The other workspaces Companion is connected to (null: not read yet). */
  targets: TransportTarget[] | null = null;
  /** The chosen connected workspace's environment, or '' for the paste flow. */
  target = '';

  /** Why Find refused the typed input, while it is shown. */
  private inputError: string | null = null;
  /** The person chose a target: reading the targets again does not choose one. */
  private choiceMade = false;
  private readonly listeners = new Set<(c: Change) => void>();
  private rowIndex = new Map<string, TransportScanRow>();
  /** The result group of each result row. */
  private rowGroup = new Map<string, GroupKey>();
  /** Per group: its tree, built once per rows, and what the filters show. */
  private trees = new Map<GroupKey, { rows: readonly TransportScanRow[]; rankKey: string; tree: GroupTree; show?: { filters: Filters; since: string; show: TreeShow } }>();
  /** Per group: the closed nodes, and the nodes seen (a new one may start closed). */
  private closedNodes = new Map<GroupKey, Set<string>>();
  private seenNodes = new Map<GroupKey, Set<string>>();
  /** Used addresses looked up and not found (lower case). */
  private notFound = new Set<string>();
  /** Used objects found by "Add them" (by lower-case address). */
  private looked = new Map<string, TransportScanRow>();
  private groupsMemo: { items: readonly CollectionItem[]; groups: PlaceGroup[] } | null = null;
  private savePending = false;
  private seq = 0;
  private readonly winId = Math.random().toString(36).slice(2, 10);
  private disposed = false;

  constructor(private readonly deps: TransportDeps, defaults: { since: string }) {
    this.since = defaults.since;
    this.chosen = new Set(TRANSPORT_DEFAULT_ROOTS);
  }

  onChange(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(c: Change): void {
    for (const fn of this.listeners) fn(c);
    if (!this.run && this.idleWaiters.length) {
      const waiting = this.idleWaiters;
      this.idleWaiters = [];
      for (const fn of waiting) fn();
    }
  }

  /** Resolves when no scan runs. */
  private untilIdle(): Promise<void> {
    return this.run ? new Promise(resolve => { this.idleWaiters.push(resolve); }) : Promise.resolve();
  }

  private nextId(): string {
    return `tr-${this.winId}-${++this.seq}`;
  }

  get scanning(): boolean { return !!this.run; }
  get reading(): boolean { return this.bundle?.status === 'reading' || this.bundle?.target?.creation?.status === 'reading'; }
  get readingLog(): boolean { return this.log?.status === 'reading'; }
  get lookingUp(): boolean { return this.refs?.status === 'reading'; }
  get refreshing(): boolean { return this.refresh?.status === 'reading'; }
  get readingUsedBy(): boolean { return [...this.usedBy.values()].some(u => u.status === 'reading'); }
  /** Comparing with, applying to or comparing again a connected target. */
  get running(): boolean {
    const k = this.bundle?.target?.direct?.phase.kind;
    return k === 'comparing' || k === 'trying' || k === 'applying' || k === 'verifying';
  }
  get busy(): boolean {
    return this.scanning || this.reading || this.readingLog || this.lookingUp || this.running || this.refreshing || this.readingUsedBy || !!this.taking || this.rereading;
  }
  /** The transport may not change: an apply is confirmed or runs. */
  get locked(): boolean {
    const k = this.bundle?.target?.direct?.phase.kind;
    return this.running || k === 'confirming' || this.refreshing;
  }

  // ── tabs ────────────────────────────────────────────────────────

  showTab(tab: 'find' | 'transport'): void {
    if (this.tab === tab && !this.logOpen) return;
    if (this.logOpen) this.closeLog();
    this.tab = tab;
    this.emit({ kind: 'view' });
  }

  setTransportView(v: 'list' | 'map'): void {
    if (this.transportView === v) return;
    this.transportView = v;
    this.emit({ kind: 'tview' });
  }

  toggleRow(rid: string): void {
    if (this.openRows.has(rid)) this.openRows.delete(rid); else this.openRows.add(rid);
    this.emit({ kind: 'detail', rid });
  }

  /** Is a place of the transport list closed? One of more than
   *  OPEN_GROUP_LIMIT objects starts closed. */
  placeClosed(g: PlaceGroup): boolean {
    return g.items.length > OPEN_GROUP_LIMIT ? !this.openPlaces.has(g.key) : this.closedPlaces.has(g.key);
  }

  togglePlace(key: string): void {
    const g = this.placeGroups().find(x => x.key === key);
    if (!g) return;
    const set = g.items.length > OPEN_GROUP_LIMIT ? this.openPlaces : this.closedPlaces;
    if (set.has(key)) set.delete(key); else set.add(key);
    this.emit({ kind: 'collection' });
  }

  /** Show one object in the list: its place open, its row open. */
  showInList(rid: string): void {
    const item = this.collection.get(rid);
    if (!item) return;
    const g = this.placeGroups().find(x => x.items.some(i => i.rid === rid));
    if (g) { this.closedPlaces.delete(g.key); this.openPlaces.add(g.key); }
    this.openRows.add(rid);
    this.transportView = 'list';
    this.tab = 'transport';
    this.emit({ kind: 'view' });
  }

  // ── inputs ──────────────────────────────────────────────────────

  setSince(day: string): void {
    this.since = day;
    this.emit({ kind: 'scan' });
  }

  setArea(root: TransportRoot, on: boolean): void {
    if (on) this.chosen.add(root); else this.chosen.delete(root);
    this.emit({ kind: 'where' });
  }

  setScope(scope: ScanScope): void {
    if (this.scope === scope || this.scanning) return;
    this.scope = scope;
    this.clearInputError();
    this.emit({ kind: 'scan' });
  }

  setStart(text: string): void {
    this.start = text;
    this.clearInputError();
    this.emit({ kind: 'scan' });
  }

  setQuery(text: string): void {
    this.query = text;
    this.clearInputError();
    this.emit({ kind: 'scan' });
  }

  setIdText(text: string): void {
    this.idText = text;
    this.clearInputError();
    this.emit({ kind: 'scan' });
  }

  /** The line of an input Find refused goes when the input changes. */
  private clearInputError(): void {
    if (this.error && this.error === this.inputError) this.error = null;
    this.inputError = null;
  }

  setUnderSince(day: string): void {
    this.underSince = day;
    this.emit({ kind: 'scan' });
  }

  /** Can Find run with the inputs as they are? A start or ID list that does
   *  not read is said on Find. */
  canScan(): boolean {
    if (this.busy) return false;
    switch (this.scope) {
      case 'under': return !!this.start.trim() && (!this.underSince || isScanDay(this.underSince));
      case 'search': return searchText(this.query) != null && this.chosen.size > 0;
      case 'ids': return !!this.idText.trim();
      case 'page': return true;
      default: return isScanDay(this.since) && this.chosen.size > 0;
    }
  }

  /** The starting object's address of the shown results ('' for other ways). */
  get startAddress(): string {
    return this.scannedStart ? this.scannedAddress : '';
  }

  private async ensureConnection(): Promise<TransportConnection | null> {
    if (this.connection) return this.connection;
    try { this.connection = await this.deps.connection(); } catch { this.connection = null; }
    return this.connection;
  }

  // ── the one box ─────────────────────────────────────────────────

  /** The day "Changed" is set to ('' for any date). */
  get changedDay(): string {
    return sinceDay(this.sinceKey, this.deps.now(), this.lastTransportDay, this.customDay);
  }

  /** The day of the last apply kept for this workspace, for "Since the last transport". */
  get lastTransportDay(): string | null {
    const at = this.lastApply?.at;
    const d = at ? new Date(at) : null;
    return d && !Number.isNaN(d.getTime()) ? dayOf(d) : null;
  }

  /** Is anything set on the Changed button (a day, a user, new only)? */
  get changedSet(): boolean {
    return !!this.changedDay || !!this.filters.user || this.filters.newOnly;
  }

  /** What the box, the date and the page button ask for now. */
  private planNow(): FindPlan {
    const box = readBox(this.box);
    if (box.kind === 'ids') return { kind: 'ids', text: box.text };
    if (this.onPage) return { kind: 'page' };
    const day = this.changedDay;
    if (day) return { kind: 'changed', day };
    if (box.kind === 'words') return { kind: 'search', longest: box.longest, single: box.single };
    return { kind: 'browse' };
  }

  /** The tree, or results (a search, a date, a list, the page). */
  get findMode(): 'browse' | 'results' {
    return this.plan.kind === 'browse' && this.scannedScope == null ? 'browse' : 'results';
  }

  /** The words that narrow the rows of a read: the box's, for everything but a list. */
  private textFor(plan: FindPlan): string {
    return plan.kind === 'browse' || plan.kind === 'ids' ? '' : readBox(this.box).kind === 'words' ? wordsOf(this.box).join(' ') : '';
  }

  private clearBoxTimer(): void {
    if (this.boxTimer) { clearTimeout(this.boxTimer); this.boxTimer = null; }
  }

  /** The text in the box changed. A search or a list waits for a pause in
   *  typing (BOX_DEBOUNCE_MS); a date or the page narrows its rows at once. */
  setBox(text: string): void {
    this.box = text;
    this.findChanged();
  }

  /** The box, the date, the page button or an area changed. */
  private findChanged(): void {
    this.clearBoxTimer();
    const plan = this.planNow();
    const key = planKey(plan, this.chosen);
    if (key === this.shownKey) {
      // The same read: only the words that narrow it changed.
      this.setFilters({ text: this.textFor(plan) });
      this.emit({ kind: 'find' });
      return;
    }
    if (plan.kind === 'search' || plan.kind === 'ids') {
      this.boxTimer = setTimeout(() => { this.boxTimer = null; void this.refind(); }, BOX_DEBOUNCE_MS);
      this.emit({ kind: 'find' });
      return;
    }
    this.emit({ kind: 'find' });
    void this.refind();
  }

  /** "Changed" set to a preset, to since the last transport, or to a day. */
  setChanged(key: SinceKey, day = ''): void {
    this.sinceKey = key;
    if (key === 'custom') this.customDay = day;
    if (!this.changedDay) this.filters = { ...this.filters, user: '', newOnly: false };
    this.findChanged();
  }

  /** Clear the Changed button: any date, anyone, not only new. */
  clearChanged(): void {
    this.sinceKey = 'any';
    this.filters = { ...this.filters, user: '', newOnly: false };
    this.findChanged();
  }

  /** "This page" pressed, or cleared. */
  setOnPage(on: boolean): void {
    if (this.onPage === on) return;
    this.onPage = on;
    this.findChanged();
  }

  /** An area ticked or not: a search or a date reads again, the tree gets its count. */
  setAreaChoice(root: TransportRoot, on: boolean): void {
    this.setArea(root, on);
    if (on) void this.readAreaCounts();
    this.findChanged();
  }

  /** Back to the default areas. */
  resetAreas(): void {
    this.chosen.clear();
    for (const r of TRANSPORT_DEFAULT_ROOTS) this.chosen.add(r);
    this.emit({ kind: 'where' });
    void this.readAreaCounts();
    this.findChanged();
  }

  /** Are the chosen areas the default ones? */
  get defaultAreas(): boolean {
    return this.chosen.size === TRANSPORT_DEFAULT_ROOTS.length && TRANSPORT_DEFAULT_ROOTS.every(r => this.chosen.has(r));
  }

  /** Find as the box, the date, the areas and the page ask: the tree, or a
   *  read whose answer replaces the results. A read still running is stopped
   *  first, so an older search never answers over a newer one. */
  async refind(): Promise<void> {
    this.clearBoxTimer();
    const seq = ++this.findSeq;
    if (this.run) { this.stopScan(); await this.untilIdle(); }
    if (this.disposed || seq !== this.findSeq) return;
    const plan = this.planNow();
    this.plan = plan;
    this.shownKey = planKey(plan, this.chosen);
    this.filters = { ...this.filters, text: this.textFor(plan) };
    if (plan.kind === 'browse') { this.clearResults(); return; }
    this.searchUnder = null;
    this.queryLabel = '';
    switch (plan.kind) {
      case 'ids': this.scope = 'ids'; this.idText = plan.text; break;
      case 'page': this.scope = 'page'; break;
      case 'changed': this.scope = 'changed'; this.since = plan.day; break;
      case 'search': this.scope = 'search'; this.query = plan.longest; this.searchUnder = plan.single; this.queryLabel = this.box.trim(); break;
    }
    await this.scan();
    if (seq === this.findSeq && !this.scanning && !this.areas.length) this.emit({ kind: 'find' });
  }

  /** Back to the tree: no results. */
  private clearResults(): void {
    this.areas = [];
    this.outcome = null;
    this.error = null;
    this.scannedScope = null;
    this.scannedSince = null;
    this.scannedStart = null;
    this.searchedText = '';
    this.rowIndex.clear();
    this.rowGroup.clear();
    this.trees.clear();
    this.closedNodes.clear();
    this.seenNodes.clear();
    this.collapsed.clear();
    this.emit({ kind: 'find' });
    this.emit({ kind: 'view' });
  }

  /** "Add the n found" of a pasted list: every object found, a numeric ID too (it was asked for). */
  addFound(): void {
    const a = this.areas.find(x => x.root === IDLIST);
    if (!a || this.locked) return;
    if (this.addRows(a.rows)) this.collectionChanged();
  }

  // ── the tree ────────────────────────────────────────────────────

  /** Start the tree: the count of every chosen area. Once, when the window opens. */
  startBrowse(): void {
    if (this.browseStarted) return;
    this.browseStarted = true;
    void this.readAreaCounts();
  }

  /** Read again what the tree read: the counts, and every node that is open. */
  refreshBrowse(): void {
    if (!this.browseStarted) return;
    for (const h of this.browseHolders.values()) this.stopHolder(h);
    for (const h of this.countHolders) this.stopHolder(h);
    this.browseHolders.clear();
    this.countHolders.clear();
    this.browseNodes.clear();
    this.counts.clear();
    this.browseIndex.clear();
    void this.readAreaCounts();
    for (const key of this.browseOpen) void this.readChildren(key);
    this.emit({ kind: 'browse' });
  }

  private stopHolder(h: Holder): void {
    h.stopped = true;
    if (h.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: h.requestId });
    h.abort?.abort();
  }

  /** One request: its answer, or why there is none (`stopped`, or the line to say). */
  private async ask<T extends InspectorMessage['type']>(holder: Holder, make: (requestId: string) => InspectorMessage, answer: T): Promise<{ ok: true; res: Msg<T> } | { ok: false; stopped?: true; error?: string }> {
    const requestId = this.nextId();
    holder.requestId = requestId;
    holder.abort = new AbortController();
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request(make(requestId), SCAN_WAIT_MS, holder.abort.signal);
    } catch (e) {
      return holder.stopped || this.disposed ? { ok: false, stopped: true } : { ok: false, error: requestFailureLine(e) };
    }
    if (holder.stopped || this.disposed) return { ok: false, stopped: true };
    if (res?.type === 'REQUEST_FAILED' || res?.type !== answer) return { ok: false, error: res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER };
    const r = res as unknown as { ok?: boolean; cancelled?: boolean; error?: string };
    if (r.cancelled) return { ok: false, stopped: true };
    if (!r.ok) return { ok: false, error: r.error || 'The read failed.' };
    return { ok: true, res: res as Msg<T> };
  }

  /** The count of every chosen area that has none yet: one request. */
  private async readAreaCounts(): Promise<void> {
    if (!this.browseStarted) return;
    const roots = orderedAreas(this.chosen).filter(r => !this.counts.has(areaKey(r)));
    if (!roots.length) return;
    const conn = await this.ensureConnection();
    if (!conn || this.disposed) return;
    const holder: Holder = {};
    this.countHolders.add(holder);
    const got = await this.ask(holder, requestId => ({ type: 'TRANSPORT_COUNTS', requestId, environment: conn.environment, roots }), 'TRANSPORT_COUNTS_RESULT');
    this.countHolders.delete(holder);
    if (!got.ok) return;
    for (const [root, n] of Object.entries(got.res.counts ?? {})) if (isTransportRoot(root)) this.counts.set(areaKey(root), n);
    this.emit({ kind: 'browse' });
  }

  /** The counts of the objects in a node, 25 per request, after its rows are shown. */
  private async readCounts(rids: readonly string[]): Promise<void> {
    const todo = rids.filter(r => !this.counts.has(r));
    const conn = todo.length ? await this.ensureConnection() : null;
    if (!conn) return;
    for (let i = 0; i < todo.length; i += TRANSPORT_READ_BATCH) {
      if (this.disposed) return;
      const batch = todo.slice(i, i + TRANSPORT_READ_BATCH);
      const holder: Holder = {};
      this.countHolders.add(holder);
      const got = await this.ask(holder, requestId => ({ type: 'TRANSPORT_COUNTS', requestId, environment: conn.environment, rids: batch }), 'TRANSPORT_COUNTS_RESULT');
      this.countHolders.delete(holder);
      if (!got.ok) return;
      for (const [rid, n] of Object.entries(got.res.counts ?? {})) this.counts.set(rid, n);
      this.emit({ kind: 'browse' });
    }
  }

  /** The row of an object the tree read. */
  browsedRow(rid: string): TransportScanRow | undefined {
    return this.browseIndex.get(rid)?.row;
  }

  /** "Try again" on a node of the tree that could not be read. */
  retryBrowse(key: string): void {
    if (!this.browseOpen.has(key) || this.browseNodes.get(key)?.status === 'reading') return;
    this.browseNodes.delete(key);
    void this.readChildren(key);
  }

  /** The number under an area or object, when it was read. */
  countOf(key: string): number | undefined {
    return this.counts.get(key);
  }

  /** Is anything of the tree being read (children, not counts)? */
  get browseReading(): boolean {
    for (const n of this.browseNodes.values()) if (n.status === 'reading') return true;
    return false;
  }

  /** Something Find reads that Stop ends: a search, children, everything under an object. */
  get findReading(): boolean {
    return this.scanning || this.browseReading || !!this.taking;
  }

  /** Stop what Find reads. What was read stays. */
  stopFind(): void {
    this.clearBoxTimer();
    this.stopScan();
    for (const [key, h] of this.browseHolders) {
      this.stopHolder(h);
      if (this.browseNodes.get(key)?.status === 'reading') { this.browseNodes.delete(key); this.browseOpen.delete(key); }
    }
    this.browseHolders.clear();
    if (this.taking) this.stopHolder(this.taking.holder);
    this.emit({ kind: 'browse' });
  }

  /** Open or close a node of the tree. A node is read the first time it opens. */
  toggleBrowse(key: string): void {
    if (this.browseOpen.has(key)) {
      this.browseOpen.delete(key);
      const h = this.browseHolders.get(key);
      if (h && this.browseNodes.get(key)?.status === 'reading') { this.stopHolder(h); this.browseHolders.delete(key); this.browseNodes.delete(key); }
      this.emit({ kind: 'browse' });
      return;
    }
    this.browseOpen.add(key);
    const node = this.browseNodes.get(key);
    if (node?.status === 'done' || node?.status === 'reading') { this.emit({ kind: 'browse' }); return; }
    void this.readChildren(key);
  }

  /** The children of an area or an object: their RIDs, then their rows, then their counts. */
  private async readChildren(key: string): Promise<void> {
    const holder: Holder = {};
    this.browseHolders.set(key, holder);
    const node: BrowseNode = { status: 'reading', rows: [] };
    this.browseNodes.set(key, node);
    this.emit({ kind: 'browse' });
    const conn = await this.ensureConnection();
    if (this.disposed || this.browseNodes.get(key) !== node) return;
    if (!conn) { node.status = 'failed'; node.error = NOT_CONNECTED; this.browseHolders.delete(key); this.emit({ kind: 'browse' }); return; }
    const root = key.startsWith('a:') ? key.slice(2) : '';
    const area = isTransportRoot(root) ? root : this.browseIndex.get(key)?.area;
    const fail = (error: string) => {
      if (this.browseNodes.get(key) !== node) return;
      node.status = 'failed';
      node.error = error;
      this.browseHolders.delete(key);
      this.emit({ kind: 'browse' });
    };
    const kids = await this.ask(holder, requestId => ({ type: 'TRANSPORT_CHILDREN', requestId, environment: conn.environment, ...(root ? { root } : { rid: key }) }), 'TRANSPORT_CHILDREN_RESULT');
    if (!kids.ok) { if (!kids.stopped) fail(kids.error ?? 'The children could not be read.'); return; }
    const rids = kids.res.rids ?? [];
    const rows: TransportScanRow[] = [];
    for (let i = 0; i < rids.length; i += TRANSPORT_READ_BATCH) {
      const batch = rids.slice(i, i + TRANSPORT_READ_BATCH);
      const got = await this.ask(holder, requestId => ({ type: 'TRANSPORT_ROWS', requestId, environment: conn.environment, rids: batch }), 'TRANSPORT_ROWS_RESULT');
      if (!got.ok) { if (!got.stopped) fail(got.error ?? 'The objects could not be read.'); return; }
      for (const r of got.res.rows ?? []) {
        if ('row' in r) rows.push(r.row);
        else if ('error' in r) { fail(r.error); return; }
      }
    }
    if (this.browseNodes.get(key) !== node) return;
    node.rows = rows;
    node.status = 'done';
    this.browseHolders.delete(key);
    for (const r of rows) this.browseIndex.set(r.rid, { row: r, ...(area ? { area } : {}) });
    this.emit({ kind: 'browse' });
    void this.readCounts(rows.map(r => r.rid));
  }

  // ── taking everything under an object or an area ────────────────

  /**
   * Everything under an object (`rid`) or an area (`root`): the object and
   * what is under it (TRANSPORT_SCAN_BELOW; one that is cut is read on child
   * by child), for an area each child of the root. At most
   * TRANSPORT_SCAN_TOTAL rows. One request at a time.
   */
  private async collectUnder(of: { rid: string } | { root: string }, holder: Holder, conn: TransportConnection): Promise<{ rows: TransportScanRow[]; origin?: TransportScanRow } | { stopped: true } | { error: string }> {
    type Task = { kind: 'below'; rid: string } | { kind: 'children'; rid?: string; root?: string };
    const queue: Task[] = 'rid' in of ? [{ kind: 'below', rid: of.rid }] : [{ kind: 'children', root: of.root }];
    const rows = new Map<string, TransportScanRow>();
    const seen = new Set<string>('rid' in of ? [of.rid] : []);
    let origin: TransportScanRow | undefined;
    while (queue.length) {
      const task = queue.shift()!;
      if (task.kind === 'below') {
        const got = await this.ask(holder, requestId => ({ type: 'TRANSPORT_SCAN_BELOW', requestId, environment: conn.environment, rid: task.rid, since: '' }), 'TRANSPORT_SCAN_BELOW_RESULT');
        if (!got.ok) return got.stopped ? { stopped: true } : { error: got.error ?? 'The objects could not be read.' };
        if (got.res.missing) { if ('rid' in of && task.rid === of.rid) return { error: NOT_THERE }; continue; }
        if ('rid' in of && task.rid === of.rid) origin = got.res.origin;
        for (const r of got.res.rows ?? []) rows.set(r.rid, r);
        if (got.res.more) queue.push({ kind: 'children', rid: task.rid });
      } else {
        const got = await this.ask(holder, requestId => ({ type: 'TRANSPORT_CHILDREN', requestId, environment: conn.environment, ...(task.root ? { root: task.root } : { rid: task.rid }) }), 'TRANSPORT_CHILDREN_RESULT');
        if (!got.ok) return got.stopped ? { stopped: true } : { error: got.error ?? 'The children could not be read.' };
        for (const rid of got.res.rids ?? []) if (!seen.has(rid)) { seen.add(rid); queue.push({ kind: 'below', rid }); }
      }
      if (rows.size > TRANSPORT_SCAN_TOTAL) return { error: `More than ${TRANSPORT_SCAN_TOTAL.toLocaleString('en-US')} objects: take parts of it.` };
    }
    return { rows: [...rows.values()], ...(origin ? { origin } : {}) };
  }

  /** "+ n under it": read everything under the object and take it as one
   *  line, a folder taken whole. An ID BMP assigned (digits) is left out. */
  async takeAll(rid: string): Promise<void> {
    const row = this.knownRow(rid);
    if (!row || this.locked || this.busy) return;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'taking' }); return; }
    const holder: Holder = {};
    this.error = null;
    this.taking = { key: rid, label: row.id || row.name || rid, holder };
    this.emit({ kind: 'taking' });
    const got = await this.collectUnder({ rid }, holder, conn);
    this.taking = null;
    if (this.disposed) return;
    if ('error' in got) this.error = got.error;
    else if (!('stopped' in got)) this.takeWhole(got.origin ?? row, got.rows);
    this.emit({ kind: 'taking' });
  }

  /** Put an object and what is under it into the transport as a folder taken whole. */
  private takeWhole(origin: TransportScanRow, under: readonly TransportScanRow[]): void {
    const rows = [origin, ...under.filter(r => r.rid !== origin.rid)];
    const byRid = new Map(rows.map(r => [r.rid, r]));
    const address = addressOf('t', origin.id);
    const area = this.itemOf(origin).area;
    const place = (r: TransportScanRow): CollectionItem => ({
      rid: r.rid, row: r, ...this.trailOf(r, id => byRid.get(id) ?? this.knownRow(id), area), readAt: this.deps.now().toISOString(),
    });
    if (!origin.id || !parseScanStart(address).ok) {
      // No address to list from: the objects go one by one.
      for (const r of rows) this.collection.add(place(r));
      this.collectionChanged();
      return;
    }
    const left = rows.filter(r => r.rid !== origin.rid && isNumericId(r)).map(r => r.rid);
    const whole: WholeFolder = { address, ids: rows.map(r => r.id), rids: rows.map(r => r.rid), ...(left.length ? { leftOut: left } : {}) };
    const leftSet = new Set(left);
    for (const r of rows) if (!leftSet.has(r.rid) && !this.collection.has(r.rid)) this.collection.add(place(r));
    this.collection.update(origin.rid, { whole });
    // A folder taken whole inside it is one line with it.
    for (const i of this.collection.list()) if (i.whole && i.rid !== origin.rid && byRid.has(i.rid)) this.collection.update(i.rid, { whole: undefined });
    this.collectionChanged();
  }

  /** The pressed button of a folder taken whole: it and everything under it leave the transport. */
  releaseWhole(rid: string): void {
    if (this.locked || !this.collection.get(rid)?.whole) return;
    if (this.removeRids([rid])) this.collectionChanged();
  }

  /** "All 21" on an area: read everything in it and add the objects. An ID BMP assigned is left out. */
  async takeArea(root: TransportRoot): Promise<void> {
    if (this.locked || this.busy) return;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'taking' }); return; }
    const holder: Holder = {};
    this.error = null;
    this.taking = { key: areaKey(root), label: AREA_LABELS[root], holder };
    this.emit({ kind: 'taking' });
    const got = await this.collectUnder({ root }, holder, conn);
    this.taking = null;
    if (this.disposed) return;
    if ('error' in got) this.error = got.error;
    else if (!('stopped' in got)) {
      const rows = got.rows.filter(r => !isNumericId(r));
      const byRid = new Map(got.rows.map(r => [r.rid, r]));
      for (const r of rows) {
        if (this.collection.has(r.rid)) continue;
        this.collection.add({ rid: r.rid, row: r, ...this.trailOf(r, id => byRid.get(id), root), readAt: this.deps.now().toISOString() });
      }
      this.areaTaken.set(root, rows.map(r => r.rid));
      this.collectionChanged();
    }
    this.emit({ kind: 'taking' });
  }

  /** Is every object "All" took from the area still in the transport? */
  areaTakenAll(root: TransportRoot): boolean {
    const rids = this.areaTaken.get(root);
    return !!rids?.length && rids.every(r => this.collection.has(r));
  }

  /** The pressed button of an area: the objects it took leave the transport. */
  releaseArea(root: TransportRoot): void {
    const rids = this.areaTaken.get(root);
    if (!rids || this.locked) return;
    this.areaTaken.delete(root);
    if (this.removeRids(rids)) this.collectionChanged();
  }

  /** The folders taken whole are read again, so objects added under them
   *  since come along; what was left out stays out. A folder that cannot be
   *  read stops the comparison. */
  private async rereadFolders(): Promise<boolean> {
    const folders = this.collection.list().filter(i => i.whole && !i.gone);
    if (!folders.length) return true;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'bundle' }); return false; }
    this.rereading = true;
    this.notice = folders.length === 1 ? 'Reading the folder again' : `Reading ${folders.length} folders again`;
    this.emit({ kind: 'bundle' });
    let ok = true;
    for (const f of folders) {
      if (this.disposed) { ok = false; break; }
      const got = await this.collectUnder({ rid: f.rid }, {}, conn);
      if ('stopped' in got) { ok = false; break; }
      if ('error' in got) {
        // A folder that is not there any more is left to the comparison (it is not found).
        if (got.error === NOT_THERE) continue;
        this.error = `${f.row.id || f.row.name}: ${got.error}`;
        ok = false;
        break;
      }
      this.applyReread(f, got.origin ?? f.row, got.rows);
    }
    this.rereading = false;
    this.notice = null;
    this.collectionChanged();
    return ok && !this.disposed;
  }

  private applyReread(folder: CollectionItem, origin: TransportScanRow, read: readonly TransportScanRow[]): void {
    const old = folder.whole;
    if (!old) return;
    const rows = [origin, ...read.filter(r => r.rid !== origin.rid)];
    const byRid = new Map(rows.map(r => [r.rid, r]));
    const known = new Set(old.rids);
    const left = new Set((old.leftOut ?? []).filter(r => byRid.has(r)));
    const now = this.deps.now().toISOString();
    for (const r of rows) {
      const item = this.collection.get(r.rid);
      if (item) { this.collection.update(r.rid, { row: r }); continue; }
      if (known.has(r.rid)) continue;
      // Added under the folder since: it comes along, an ID BMP assigned does not.
      if (r.rid !== origin.rid && isNumericId(r)) { left.add(r.rid); continue; }
      this.collection.add({ rid: r.rid, row: r, ...this.trailOf(r, id => byRid.get(id) ?? this.collection.get(id)?.row, folder.area), readAt: now });
    }
    // Gone from the workspace: gone from the folder.
    for (const rid of old.rids) if (rid !== folder.rid && !byRid.has(rid)) this.collection.remove(rid);
    this.collection.update(folder.rid, { row: origin, whole: { address: old.address, ids: rows.map(r => r.id), rids: rows.map(r => r.rid), ...(left.size ? { leftOut: [...left] } : {}) } });
  }

  // ── find ────────────────────────────────────────────────────────

  /** Find with the chosen way. The result list is replaced; the transport stays. */
  async scan(): Promise<void> {
    if (!this.canScan()) return;
    const scope = this.scope;
    let roots: GroupKey[];
    let since = '';
    let start: string | null = null;
    let ids: ReturnType<typeof parseIdList> | null = null;
    if (scope === 'under') {
      const s = parseScanStart(this.start);
      if (!s.ok) { this.error = this.inputError = s.error; this.emit({ kind: 'scan' }); return; }
      roots = [UNDER];
      since = this.underSince;
      start = s.id;
      this.scannedAddress = s.address;
    } else if (scope === 'ids') {
      ids = parseIdList(this.idText);
      if (!ids.addresses.length) {
        this.error = this.inputError = 'No IDs found. Paste IDs or addresses such as t.my_id, separated by spaces, commas or lines.';
        this.emit({ kind: 'scan' });
        return;
      }
      roots = [IDLIST];
    } else if (scope === 'page') {
      roots = [ONPAGE];
    } else {
      roots = orderedAreas(this.chosen);
      since = scope === 'changed' ? this.since : '';
      // A single word typed that is an ID: the object and what is under it first.
      const exact = scope === 'search' && this.searchUnder ? parseScanStart(this.searchUnder) : null;
      if (exact?.ok) {
        roots = [UNDER, ...roots];
        start = exact.id;
        this.scannedAddress = exact.address;
      }
    }
    this.error = null;
    this.outcome = null;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'scan' }); return; }
    if (this.disposed) return;
    this.scannedScope = scope;
    this.scannedSince = scope === 'changed' || scope === 'under' ? since : '';
    this.scannedStart = start;
    this.searchedText = scope === 'search' ? this.queryLabel || (searchText(this.query) ?? '') : '';
    // Without a day nothing is new: "New only" would hide every row.
    if (!this.scannedSince && this.filters.newOnly) this.filters = { ...this.filters, newOnly: false };
    this.areas = roots.map(root => ({ root, status: 'waiting', rows: [], more: false }));
    this.rowIndex.clear();
    this.rowGroup.clear();
    this.collapsed.clear();
    this.trees.clear();
    this.closedNodes.clear();
    this.seenNodes.clear();
    this.notice = null;
    if (this.tab !== 'find') { this.tab = 'find'; }
    this.emit({ kind: 'view' });
    if (ids) await this.runIdList(ids, conn);
    else if (scope === 'page') await this.runPage(conn);
    else await this.runAreas(roots, since, conn);
  }

  /** Scan one area again (after it failed or was not reached). */
  async retry(root: GroupKey): Promise<void> {
    const area = this.areas.find(a => a.root === root);
    const since = this.scannedSince;
    if (!area || since == null || this.busy || root === IDLIST || root === ONPAGE) return;
    this.error = null;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'scan' }); return; }
    for (const r of area.rows) { this.rowIndex.delete(r.rid); this.rowGroup.delete(r.rid); }
    Object.assign(area, { status: 'waiting', rows: [], more: false, error: undefined, origin: undefined, rest: undefined });
    this.closedNodes.delete(root);
    this.seenNodes.delete(root);
    await this.runAreas([root], since, conn);
  }

  private async runAreas(roots: GroupKey[], since: string, conn: TransportConnection): Promise<void> {
    const run: ScanRun = { roots, index: 0, current: roots[0], stopped: false };
    this.run = run;
    let fatal = false;
    let scanned = 0;
    for (let i = 0; i < roots.length; i++) {
      if (run.stopped || this.disposed) break;
      const area = this.areas.find(a => a.root === roots[i]);
      if (!area) continue;
      run.index = i;
      run.current = roots[i];
      area.status = 'scanning';
      this.emit({ kind: 'scan' });
      this.emit({ kind: 'area', root: area.root });
      const end = await this.scanArea(area, run, since, conn);
      this.emit({ kind: 'area', root: area.root });
      if (end === 'fatal') { fatal = true; break; }
      if (end !== 'stopped') scanned++;
    }
    this.endRun(run, roots, fatal, scanned);
  }

  private endRun(run: ScanRun, roots: GroupKey[], fatal: boolean, scanned: number): void {
    for (const r of roots) {
      const area = this.areas.find(a => a.root === r);
      if (area && (area.status === 'waiting' || area.status === 'scanning')) { area.status = 'stopped'; this.emit({ kind: 'area', root: r }); }
    }
    this.run = null;
    this.outcome = { kind: fatal ? 'failed' : run.stopped ? 'stopped' : 'done', areas: scanned, of: roots.length };
    this.emit({ kind: 'areas' });
    this.emit({ kind: 'scan' });
    this.emit({ kind: 'collection' });
  }

  /** Put a group's rows into the index (and sort them). */
  private setAreaRows(area: AreaResult, rows: TransportScanRow[]): void {
    area.rows = rows;
    for (const row of rows) { this.rowIndex.set(row.rid, row); this.rowGroup.set(row.rid, area.root); }
  }

  private async scanArea(area: AreaResult, run: ScanRun, since: string, conn: TransportConnection): Promise<'next' | 'stopped' | 'fatal'> {
    const requestId = this.nextId();
    run.requestId = requestId;
    run.abort = new AbortController();
    const under = area.root === UNDER;
    const search = this.scannedScope === 'search';
    const msg: InspectorMessage = under
      ? { type: 'TRANSPORT_SCAN_UNDER', requestId, environment: conn.environment, start: this.scannedAddress, since }
      : search ? { type: 'TRANSPORT_SEARCH', requestId, environment: conn.environment, root: area.root, text: searchText(this.query) ?? this.searchedText }
        : { type: 'TRANSPORT_SCAN', requestId, environment: conn.environment, root: area.root, since };
    const answer = under ? 'TRANSPORT_SCAN_UNDER_RESULT' : search ? 'TRANSPORT_SEARCH_RESULT' : 'TRANSPORT_SCAN_RESULT';
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request(msg, SCAN_WAIT_MS, run.abort.signal);
    } catch (e) {
      if (run.stopped || this.disposed) { area.status = 'stopped'; return 'stopped'; }
      area.status = 'failed';
      area.error = requestFailureLine(e);
      this.error = area.error;
      return 'fatal';
    }
    if (run.stopped || this.disposed) { area.status = 'stopped'; return 'stopped'; }
    if (res?.type === 'REQUEST_FAILED' || res?.type !== answer) {
      area.status = 'failed';
      area.error = res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER;
      this.error = area.error;
      return 'fatal';
    }
    const r = res as Msg<'TRANSPORT_SCAN_RESULT'> | Msg<'TRANSPORT_SCAN_UNDER_RESULT'> | Msg<'TRANSPORT_SEARCH_RESULT'>;
    if (r.cancelled) { area.status = 'stopped'; return 'stopped'; }
    if (!r.ok) {
      area.status = 'failed';
      area.error = r.error || 'The search failed.';
      if (isLocalFailure(r)) return 'next';
      this.error = area.error;
      return 'fatal';
    }
    if (r.type === 'TRANSPORT_SCAN_UNDER_RESULT' ? r.missingStart : r.missingRoot) { area.status = 'missing'; return 'next'; }
    if (r.type === 'TRANSPORT_SCAN_UNDER_RESULT') {
      const origin = r.origin;
      const rows = r.rows ?? [];
      area.origin = origin;
      this.setAreaRows(area, [...rows.filter(x => x.rid === origin?.rid), ...sortRows(rows.filter(x => x.rid !== origin?.rid))]);
    } else {
      // What is under an exact ID is shown once, in its own group.
      this.setAreaRows(area, sortRows((r.rows ?? []).filter(x => this.rowGroup.get(x.rid) !== UNDER)));
    }
    area.more = !!r.more;
    if (area.rows.length > OPEN_GROUP_LIMIT) this.collapsed.add(area.root);
    this.settleNodes(area);
    area.status = 'done';
    return 'next';
  }

  /**
   * An ID list: each address looked up on this workspace (TRANSPORT_FIND),
   * one at a time, stoppable. Found objects are the group's rows; addresses
   * no object has are `notFound`, entries of another form `invalid`.
   */
  private async runIdList(ids: ReturnType<typeof parseIdList>, conn: TransportConnection): Promise<void> {
    const area = this.areas[0];
    const run: ScanRun = { roots: [IDLIST], index: 0, current: IDLIST, stopped: false, done: 0, total: ids.addresses.length };
    this.run = run;
    area.status = 'scanning';
    area.invalid = ids.invalid;
    area.notFound = [];
    area.more = ids.more;
    this.emit({ kind: 'scan' });
    this.emit({ kind: 'area', root: IDLIST });
    const found: TransportScanRow[] = [];
    let fatal = false;
    for (const address of ids.addresses) {
      if (run.stopped || this.disposed) break;
      const requestId = this.nextId();
      run.requestId = requestId;
      run.abort = new AbortController();
      let res: InspectorMessage | undefined;
      try {
        res = await this.deps.request({ type: 'TRANSPORT_FIND', requestId, environment: conn.environment, address }, SCAN_WAIT_MS, run.abort.signal);
      } catch (e) {
        if (run.stopped || this.disposed) break;
        this.error = area.error = requestFailureLine(e);
        fatal = true;
        break;
      }
      if (run.stopped || this.disposed) break;
      if (res?.type !== 'TRANSPORT_FIND_RESULT') {
        this.error = area.error = res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER;
        fatal = true;
        break;
      }
      if (res.cancelled) break;
      if (!res.ok) {
        if (!isLocalFailure(res)) { this.error = area.error = res.error || 'The object could not be looked up.'; fatal = true; break; }
        area.notFound.push(address);
      } else if (res.row) {
        if (!found.some(f => f.rid === res.row!.rid)) found.push(res.row);
      } else {
        area.notFound.push(address);
      }
      run.done = (run.done ?? 0) + 1;
      this.setAreaRows(area, sortRows(found));
      this.emit({ kind: 'scan' });
      this.emit({ kind: 'area', root: IDLIST });
    }
    area.status = fatal ? 'failed' : run.stopped ? 'stopped' : 'done';
    this.setAreaRows(area, sortRows(found));
    this.settleNodes(area);
    this.endRun(run, [IDLIST], fatal, fatal || run.stopped ? 0 : 1);
  }

  /** The objects of the page the window sits on: their RIDs from the page,
   *  then their rows, TRANSPORT_READ_BATCH per request, stoppable. */
  private async runPage(conn: TransportConnection): Promise<void> {
    const area = this.areas[0];
    const run: ScanRun = { roots: [ONPAGE], index: 0, current: ONPAGE, stopped: false, done: 0, total: 0 };
    this.run = run;
    area.status = 'scanning';
    this.emit({ kind: 'scan' });
    this.emit({ kind: 'area', root: ONPAGE });
    let fatal = false;
    const fail = (line: string) => { this.error = area.error = line; fatal = true; };
    const found: TransportScanRow[] = [];
    run.requestId = this.nextId();
    run.abort = new AbortController();
    let rids: string[] = [];
    try {
      const res = await this.deps.request({ type: 'TRANSPORT_PAGE_OBJECTS', requestId: run.requestId, environment: conn.environment }, SCAN_WAIT_MS, run.abort.signal);
      if (res?.type !== 'TRANSPORT_PAGE_OBJECTS_RESULT') fail(res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER);
      else if (!res.ok) fail(res.error || 'The page did not answer.');
      else rids = res.rids ?? [];
    } catch (e) {
      if (!run.stopped && !this.disposed) fail(requestFailureLine(e));
    }
    run.total = rids.length;
    for (let i = 0; i < rids.length && !fatal; i += TRANSPORT_READ_BATCH) {
      if (run.stopped || this.disposed) break;
      const batch = rids.slice(i, i + TRANSPORT_READ_BATCH);
      const read = await this.readRows(batch, conn, run);
      if (!Array.isArray(read)) { if ('error' in read) fail(read.error); break; }
      for (const r of read) if ('row' in r) found.push(r.row);
      run.done = Math.min(rids.length, i + batch.length);
      this.setAreaRows(area, sortRows(found));
      this.emit({ kind: 'scan' });
      this.emit({ kind: 'area', root: ONPAGE });
    }
    area.status = fatal ? 'failed' : run.stopped ? 'stopped' : 'done';
    this.setAreaRows(area, sortRows(found));
    if (area.rows.length > OPEN_GROUP_LIMIT) this.collapsed.add(ONPAGE);
    this.settleNodes(area);
    this.endRun(run, [ONPAGE], fatal, fatal || run.stopped ? 0 : 1);
  }

  /** One TRANSPORT_ROWS request: the rows, stopped, or the failure line. */
  private async readRows(rids: string[], conn: TransportConnection, holder: { requestId?: string; abort?: AbortController; stopped?: boolean; status?: string }): Promise<TransportRowRead[] | { stopped: true } | { error: string }> {
    const STOPPED = { stopped: true as const };
    const requestId = this.nextId();
    holder.requestId = requestId;
    holder.abort = new AbortController();
    const stopped = () => holder.stopped === true || holder.status === 'stopped' || this.disposed;
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request({ type: 'TRANSPORT_ROWS', requestId, environment: conn.environment, rids }, READ_WAIT_MS, holder.abort.signal);
    } catch (e) {
      return stopped() ? STOPPED : { error: requestFailureLine(e) };
    }
    if (stopped()) return STOPPED;
    if (res?.type !== 'TRANSPORT_ROWS_RESULT') return { error: res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER };
    if (res.cancelled) return STOPPED;
    if (!res.ok) {
      if (isLocalFailure(res)) return rids.map(rid => ({ rid, error: res.error || 'The objects could not be read.' }));
      return { error: res.error || 'The objects could not be read.' };
    }
    const byRid = new Map((res.rows ?? []).map(r => [r.rid, r]));
    return rids.map(rid => byRid.get(rid) ?? { rid, error: 'The server did not answer for this object.' });
  }

  // ── the rest of a cut group ─────────────────────────────────────

  /** Can the rest of a cut group be read (or the failed children again)? */
  canReadRest(a: AreaResult): boolean {
    if (this.busy || this.scannedSince == null || this.scannedScope === 'search' || a.rest?.full) return false;
    if (a.root !== UNDER && !isTransportRoot(a.root)) return false;
    if (a.rest) return a.rest.status === 'stopped' || (a.rest.status === 'done' && a.rest.failed.length > 0);
    return a.more && a.status === 'done' && (a.root !== UNDER || !!a.origin);
  }

  /**
   * Read the rest of a cut group: the children of the cut object (the
   * area's root, or the starting object) one by one, each with what is under
   * it; a child that is cut itself is read on the same way, breadth-first.
   * Rows are merged by RID, up to TRANSPORT_SCAN_TOTAL. One request at a
   * time; Stop keeps what is left for later. A child that fails is named
   * and can be read again on its own.
   */
  async readRest(root: GroupKey): Promise<void> {
    const area = this.areas.find(a => a.root === root);
    const since = this.scannedSince;
    if (!area || since == null || !this.canReadRest(area)) return;
    this.error = null;
    this.notice = null;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'scan' }); return; }
    if (this.disposed || this.busy) return;
    let rest = area.rest;
    if (!rest) {
      rest = { status: 'reading', todo: [{ kind: 'children', rid: area.root === UNDER ? area.origin?.rid ?? '' : '' }], failed: [], queued: new Set(), full: false };
      area.rest = rest;
    } else if (rest.status === 'done') {
      rest.todo = rest.failed;
      rest.failed = [];
    }
    rest.status = 'reading';
    const run: ScanRun = { roots: [root], index: 0, current: root, stopped: false, rest: true };
    this.run = run;
    this.emit({ kind: 'scan' });
    this.emit({ kind: 'rest', root });
    const have = new Set(area.rows.map(r => r.rid));
    const rows = [...area.rows];
    let fatal = false;
    while (rest.todo.length) {
      if (run.stopped || this.disposed) break;
      if (rows.length >= TRANSPORT_SCAN_TOTAL) { rest.full = true; break; }
      const task = rest.todo[0];
      const end = await this.restTask(area, task, run, since, conn);
      if (end === 'stopped') break;
      if (end === 'fatal') { fatal = true; break; }
      rest.todo.shift();
      if (end === 'failed') rest.failed.push(task);
      else {
        for (const r of end.rows) {
          if (have.has(r.rid)) continue;
          if (rows.length >= TRANSPORT_SCAN_TOTAL) { rest.full = true; break; }
          have.add(r.rid);
          rows.push(r);
        }
        for (const t of end.next) {
          if (t.kind === 'below' && rest.queued.has(t.rid)) continue;
          if (t.kind === 'below') rest.queued.add(t.rid);
          rest.todo.push(t);
        }
        // Rows count as found as they come.
        area.rows = rows;
      }
      this.emit({ kind: 'rest', root });
      this.emit({ kind: 'scan' });
    }
    rest.status = fatal || run.stopped || (rest.todo.length && !rest.full) ? 'stopped' : 'done';
    if (rest.status === 'done' && !rest.full && !rest.failed.length) area.more = false;
    const origin = area.origin;
    this.setAreaRows(area, area.root === UNDER && origin
      ? [...rows.filter(x => x.rid === origin.rid), ...sortRows(rows.filter(x => x.rid !== origin.rid))]
      : sortRows(rows));
    this.settleNodes(area);
    this.run = null;
    this.emit({ kind: 'area', root });
    this.emit({ kind: 'scan' });
    this.emit({ kind: 'collection' });
  }

  /** One step of readRest: its rows and the steps it adds, 'failed' for a
   *  failure of this step only, 'stopped', or 'fatal' (said in `error`). */
  private async restTask(area: AreaResult, task: RestTask, run: ScanRun, since: string, conn: TransportConnection): Promise<{ rows: TransportScanRow[]; next: RestTask[] } | 'failed' | 'stopped' | 'fatal'> {
    const requestId = this.nextId();
    run.requestId = requestId;
    run.abort = new AbortController();
    const children = task.kind === 'children';
    const msg: InspectorMessage = !children
      ? { type: 'TRANSPORT_SCAN_BELOW', requestId, environment: conn.environment, rid: task.rid, since }
      : task.rid ? { type: 'TRANSPORT_CHILDREN', requestId, environment: conn.environment, rid: task.rid }
        : { type: 'TRANSPORT_CHILDREN', requestId, environment: conn.environment, root: area.root };
    const answer = children ? 'TRANSPORT_CHILDREN_RESULT' : 'TRANSPORT_SCAN_BELOW_RESULT';
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request(msg, SCAN_WAIT_MS, run.abort.signal);
    } catch (e) {
      if (run.stopped || this.disposed) return 'stopped';
      this.error = requestFailureLine(e);
      return 'fatal';
    }
    if (run.stopped || this.disposed) return 'stopped';
    if (res?.type === 'REQUEST_FAILED' || res?.type !== answer) {
      this.error = res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER;
      return 'fatal';
    }
    const r = res as Msg<'TRANSPORT_CHILDREN_RESULT'> | Msg<'TRANSPORT_SCAN_BELOW_RESULT'>;
    if (r.cancelled) return 'stopped';
    if (!r.ok) {
      if (isLocalFailure(r)) return 'failed';
      this.error = r.error || 'The search failed.';
      return 'fatal';
    }
    if (r.missing) return { rows: [], next: [] };
    if (r.type === 'TRANSPORT_CHILDREN_RESULT') return { rows: [], next: (r.rids ?? []).map(rid => ({ kind: 'below', rid })) };
    return { rows: r.rows ?? [], next: r.more ? [{ kind: 'children', rid: task.rid }] : [] };
  }

  /** Stop the running search: the request being read is cancelled, nothing
   *  further is read. */
  stopScan(): void {
    const run = this.run;
    if (!run || run.stopped) return;
    run.stopped = true;
    if (run.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: run.requestId });
    run.abort?.abort();
    this.emit({ kind: 'scan' });
  }

  /** Rows found so far. */
  found(): number {
    const search = this.scannedScope === 'search';
    return this.areas.reduce((n, a) => n + (search && a.root === UNDER ? 0 : a.rows.length), 0);
  }

  areaLabel(root: TransportRoot): string {
    return AREA_LABELS[root];
  }

  /** A group's title: the area, the starting object's ID and name (its
   *  address when it was not read), "ID list" or "This page". */
  groupLabel(a: AreaResult): string {
    if (a.root === IDLIST) return 'ID list';
    if (a.root === ONPAGE) return 'This page';
    if (a.root !== UNDER) return AREA_LABELS[a.root];
    const o = a.origin;
    if (!o) return this.startAddress;
    return o.name ? `${o.id || this.startAddress} · ${o.name}` : o.id || this.startAddress;
  }

  // ── result list: filters, groups ────────────────────────────────

  setFilters(f: Partial<Filters>): void {
    this.filters = { ...this.filters, ...f };
    this.emit({ kind: 'filters' });
  }

  toggleGroup(root: GroupKey): void {
    if (this.collapsed.has(root)) this.collapsed.delete(root); else this.collapsed.add(root);
    this.emit({ kind: 'area', root });
  }

  /** The filters of a group: what is under an exact ID is not narrowed by the text. */
  private filtersFor(a: AreaResult): Filters {
    if (a.root !== UNDER || this.scannedScope !== 'search') return this.filters;
    if (this.underFilters?.src !== this.filters) this.underFilters = { src: this.filters, out: { ...this.filters, text: '' } };
    return this.underFilters.out;
  }
  private underFilters: { src: Filters; out: Filters } | null = null;

  private treeEntry(a: AreaResult) {
    let c = this.trees.get(a.root);
    const words = a.root === UNDER ? [] : wordsOf(this.filters.text);
    const rankKey = words.join(' ');
    if (!c || c.rows !== a.rows || c.rankKey !== rankKey) {
      const o = a.origin;
      const rank = words.length ? (r: TransportScanRow) => (holdsWords(r, words) ? rankOf(r, words) : 9) : undefined;
      const opts = a.root === UNDER ? (o ? { top: { rid: o.rid, id: o.id, name: o.name } } : {})
        : { rootIds: isTransportRoot(a.root) ? [a.root] : ROOT_IDS, ...(rank ? { rank } : {}) };
      c = { rows: a.rows, rankKey, tree: buildGroupTree(a.rows, opts) };
      this.trees.set(a.root, c);
    }
    return c;
  }

  /** The group's rows as a tree (built once per rows). */
  groupTree(a: AreaResult): GroupTree {
    return this.treeEntry(a).tree;
  }

  /** What of the tree the filters show (once per filters). */
  groupShow(a: AreaResult): TreeShow {
    const c = this.treeEntry(a);
    const since = this.scannedSince ?? '';
    const f = this.filtersFor(a);
    if (!c.show || c.show.filters !== f || c.show.since !== since) {
      c.show = { filters: f, since, show: showTree(c.tree, r => rowMatches(r, f, since)) };
    }
    return c.show.show;
  }

  /** Is the node closed (its children not drawn)? */
  nodeClosed(root: GroupKey, n: TreeNode): boolean {
    return !!this.closedNodes.get(root)?.has(n.key);
  }

  /** Open or close a node. */
  toggleNode(root: GroupKey, key: string): void {
    let closed = this.closedNodes.get(root);
    if (!closed) { closed = new Set(); this.closedNodes.set(root, closed); }
    if (closed.has(key)) closed.delete(key); else closed.add(key);
    this.emit({ kind: 'node', root, key });
  }

  /** Nodes seen for the first time: in a group of more than
   *  OPEN_GROUP_LIMIT rows, those below the first level start closed. */
  private settleNodes(a: AreaResult): void {
    const tree = this.groupTree(a);
    let seen = this.seenNodes.get(a.root);
    if (!seen) { seen = new Set(); this.seenNodes.set(a.root, seen); }
    let closed = this.closedNodes.get(a.root);
    if (!closed) { closed = new Set(); this.closedNodes.set(a.root, closed); }
    const big = a.rows.length > OPEN_GROUP_LIMIT;
    for (const n of tree.order) {
      if (seen.has(n.key)) continue;
      seen.add(n.key);
      if (big && n.depth >= 1 && n.children.length) closed.add(n.key);
    }
  }

  /** The rows of an area that pass the filters. */
  visibleRows(area: AreaResult): TransportScanRow[] {
    const since = this.scannedSince ?? '';
    const f = this.filtersFor(area);
    return area.rows.filter(r => rowMatches(r, f, since));
  }

  isNew(row: TransportScanRow): boolean {
    return !!this.scannedSince && isNewRow(row, this.scannedSince);
  }

  row(rid: string): TransportScanRow | undefined {
    return this.rowIndex.get(rid);
  }

  /** All rows of every group. */
  allRows(): TransportScanRow[] {
    return this.areas.flatMap(a => a.rows);
  }

  // ── ticks: in the transport or not ──────────────────────────────

  /** Is the object in the transport? */
  inTransport(rid: string): boolean {
    return this.collection.has(rid);
  }

  /** The objects above a row, as far as `parentOf` knows them. */
  private trailOf(row: TransportScanRow, parentOf: (rid: string) => TransportScanRow | undefined, hint?: TransportRoot): { area?: TransportRoot; trail: PlaceStep[] } {
    const steps: PlaceStep[] = [];
    const seen = new Set<string>([row.rid]);
    let cur = row;
    for (;;) {
      const p = cur.parentRid ? parentOf(cur.parentRid) : undefined;
      if (p && !seen.has(p.rid)) { steps.unshift({ id: p.id, name: p.name }); seen.add(p.rid); cur = p; continue; }
      const root = rootOfId(cur.parentId);
      const area = hint ?? root;
      if (!root && cur.parentId) steps.unshift({ id: cur.parentId, name: cur.parentName });
      return { ...(area ? { area } : {}), trail: steps };
    }
  }

  /** A transport object of a row of a result group or of the tree. */
  private itemOf(row: TransportScanRow): CollectionItem {
    const g = this.rowGroup.get(row.rid);
    const a = g ? this.areas.find(x => x.root === g) : undefined;
    const b = this.browseIndex.get(row.rid);
    const byKey = a ? this.groupTree(a).byKey : undefined;
    const hint = a && isTransportRoot(a.root) ? a.root : b?.area;
    const place = this.trailOf(row, rid => (byKey ? byKey.get(rid)?.row : undefined) ?? this.browseIndex.get(rid)?.row, hint);
    return { rid: row.rid, row, ...place, readAt: this.deps.now().toISOString() };
  }

  /** The row of an object the tree or the results show. */
  private knownRow(rid: string): TransportScanRow | undefined {
    return this.rowIndex.get(rid) ?? this.browseIndex.get(rid)?.row;
  }

  /** Add rows to the transport (ticked). */
  private addRows(rows: Iterable<TransportScanRow>): number {
    let n = 0;
    for (const r of rows) {
      if (!this.collection.add(this.itemOf(r))) continue;
      n++;
      // Ticked again under a folder taken whole: no longer left out.
      const owner = this.owningFolder(r.rid);
      if (owner?.whole.leftOut?.includes(r.rid)) this.collection.update(owner.rid, { whole: { ...owner.whole, leftOut: owner.whole.leftOut.filter(x => x !== r.rid) } });
    }
    return n;
  }

  // ── folders taken whole ─────────────────────────────────────────

  /** RID → the folder taken whole that holds it (the folder itself, what is
   *  under it, and what was left out), once per change of the transport. */
  private coverIndex(): Map<string, string> {
    const v = this.collection.version;
    if (this.coverMemo?.version === v) return this.coverMemo.index;
    const index = new Map<string, string>();
    for (const i of this.collection.list()) {
      if (!i.whole) continue;
      for (const r of i.whole.rids) if (!index.has(r)) index.set(r, i.rid);
    }
    this.coverMemo = { version: v, index };
    return index;
  }

  /** The folder taken whole that holds the object, with its item. */
  private owningFolder(rid: string): { rid: string; whole: WholeFolder } | null {
    const owner = this.coverIndex().get(rid);
    const whole = owner ? this.collection.get(owner)?.whole : undefined;
    return owner && whole ? { rid: owner, whole } : null;
  }

  /** The folder taken whole an object is the root of: "All 6 of 7 under it". */
  wholeFolder(rid: string): WholeFolder | null {
    return this.collection.get(rid)?.whole ?? null;
  }

  /** Is the object under a folder taken whole (not the folder, not left out)? */
  coveredBy(rid: string): boolean {
    const o = this.owningFolder(rid);
    return !!o && o.rid !== rid && !o.whole.leftOut?.includes(rid);
  }

  /** The lines of the transport: objects alone, and folders taken whole. */
  lines(): { objects: number; folders: number } {
    const l = transportLines(this.collection.list());
    return { objects: l.objects, folders: l.folders };
  }

  /** The IDs a taken folder has, without the folder itself: the objects under it. */
  underCount(w: WholeFolder): { total: number; taken: number } {
    const total = Math.max(0, w.rids.length - 1);
    const left = (w.leftOut ?? []).filter(r => w.rids.includes(r)).length;
    return { total, taken: total - left };
  }

  private removeRids(rids: Iterable<string>): number {
    let n = 0;
    for (const rid of rids) {
      const item = this.collection.get(rid);
      if (!item) continue;
      if (item.whole) {
        // The folder: it and everything under it go.
        for (const r of item.whole.rids) if (this.collection.remove(r)) { n++; this.openRows.delete(r); }
        continue;
      }
      // One object under a folder taken whole: the folder stays, the object is left out.
      const owner = this.owningFolder(rid);
      if (this.collection.remove(rid)) { n++; this.openRows.delete(rid); }
      if (owner) {
        const w = this.collection.get(owner.rid)?.whole;
        if (w && !w.leftOut?.includes(rid)) this.collection.update(owner.rid, { whole: { ...w, leftOut: [...(w.leftOut ?? []), rid] } });
      }
    }
    return n;
  }

  /** The transport changed: tell the view, keep the draft. */
  private collectionChanged(): void {
    this.groupsMemo = null;
    if (!this.collection.size) this.draftRestored = false;
    this.emit({ kind: 'collection' });
    this.scheduleSave();
  }

  setTicked(rid: string, on: boolean): void {
    const row = this.knownRow(rid);
    if (!row || this.locked) return;
    const n = on ? this.addRows([row]) : this.removeRids([rid]);
    if (n) this.collectionChanged();
  }

  /** Add or remove everything under a node that the filters show (the node
   *  itself has its tick box). Adding leaves out numeric IDs, as the group
   *  button does. */
  setSubtreeTicked(root: GroupKey, key: string, on: boolean): void {
    const area = this.areas.find(a => a.root === root);
    if (!area || this.locked) return;
    const tree = this.groupTree(area);
    const show = this.groupShow(area);
    const n = tree.byKey.get(key);
    if (!n) return;
    const rows: TransportScanRow[] = [];
    for (let i = n.index + 1; i < n.end; i++) {
      const r = tree.order[i].row;
      if (!r || show.state[i] !== MATCH) continue;
      if (!on || !isNumericId(r)) rows.push(r);
    }
    const changed = on ? this.addRows(rows) : this.removeRids(rows.map(r => r.rid));
    if (changed) this.collectionChanged();
  }

  /** Objects in the transport among those the subtree control adds, before
   *  each position of the group's order (as TreeShow.ticks). */
  subtreeTicked(a: AreaResult): Int32Array {
    const tree = this.groupTree(a);
    const show = this.groupShow(a);
    const out = new Int32Array(tree.order.length + 1);
    for (let i = 0; i < tree.order.length; i++) {
      const r = tree.order[i].row;
      out[i + 1] = out[i] + (r && show.state[i] === MATCH && !isNumericId(r) && this.collection.has(r.rid) ? 1 : 0);
    }
    return out;
  }

  /** Add or remove the shown rows of a group (rows hidden by the filters
   *  stay as they are). Adding leaves rows with a numeric ID out; removing
   *  includes them. */
  setGroupTicked(root: GroupKey, on: boolean): void {
    const area = this.areas.find(a => a.root === root);
    if (!area || this.locked) return;
    const rows = this.visibleRows(area).filter(r => !on || !isNumericId(r));
    const n = on ? this.addRows(rows) : this.removeRids(rows.map(r => r.rid));
    if (n) this.collectionChanged();
  }

  /** 'all', 'some' or 'none' of a group's shown rows that the group box
   *  adds are in the transport. */
  groupTick(area: AreaResult): 'all' | 'some' | 'none' | 'empty' {
    let total = 0, on = 0;
    for (const r of this.visibleRows(area)) {
      if (isNumericId(r)) continue;
      total++;
      if (this.collection.has(r.rid)) on++;
    }
    if (!total) return 'empty';
    return on === 0 ? 'none' : on === total ? 'all' : 'some';
  }

  // ── the transport ───────────────────────────────────────────────

  /** Remove one object from the transport. */
  remove(rid: string): void {
    if (this.locked || !this.removeRids([rid])) return;
    this.collectionChanged();
  }

  /** Empty the transport and its draft; Undo brings it back. */
  clearTransport(): void {
    if (this.locked || !this.collection.size) return;
    this.cleared = this.collection.list();
    this.collection.replace();
    this.openRows.clear();
    this.draftRestored = false;
    this.notice = null;
    this.collectionChanged();
    this.emit({ kind: 'draft' });
  }

  undoClear(): void {
    const items = this.cleared;
    if (!items || this.locked) return;
    this.cleared = null;
    for (const i of items) this.collection.add(i);
    this.collectionChanged();
    this.emit({ kind: 'draft' });
  }

  /** The objects of the transport that a build reads: not gone, not kept out. */
  transportItems(): CollectionItem[] {
    return this.collection.list().filter(i => !i.gone);
  }

  /** The transport grouped by place (once per change). */
  placeGroups(): PlaceGroup[] {
    const items = this.collection.list();
    if (this.groupsMemo && this.groupsMemo.items.length === items.length && this.groupsMemo.items.every((x, i) => x === items[i])) return this.groupsMemo.groups;
    const groups = placeGroups(items);
    this.groupsMemo = { items, groups };
    return groups;
  }

  /** Save the draft after the current change (one write per turn). */
  private scheduleSave(): void {
    const store = this.deps.store;
    if (!store || this.savePending) return;
    this.savePending = true;
    queueMicrotask(() => {
      this.savePending = false;
      void this.saveDraft();
    });
  }

  private async saveDraft(): Promise<void> {
    const store = this.deps.store;
    const env = this.connection?.environment;
    if (!store || !env || this.disposed) return;
    try {
      if (!this.collection.size) await store.remove(draftKey(env));
      else await store.set(draftKey(env), toDraft(env, this.collection.list(), this.deps.now().toISOString(), this.fileLimitKb, this.fileContent));
    } catch { /* the draft is a convenience: the transport stays in the window */ }
  }

  /** Restore the workspace's draft when the window opens (nothing is read
   *  from the server). */
  async restoreDraft(): Promise<void> {
    const store = this.deps.store;
    const conn = await this.ensureConnection();
    if (!store || !conn || this.disposed || this.collection.size) return;
    let value: unknown;
    try { value = await store.get(draftKey(conn.environment)); } catch { return; }
    const limit = draftFileLimit(value, conn.environment);
    if (limit != null && limit !== this.fileLimitKb) { this.fileLimitKb = limit; this.emit({ kind: 'fileLimit' }); }
    const content = draftFileContent(value, conn.environment);
    if (content != null && content !== this.fileContent) { this.fileContent = content; this.emit({ kind: 'fileLimit' }); }
    const items = readDraft(value, conn.environment);
    if (!items?.length || this.collection.size) return;
    this.collection.replace(items);
    this.draftRestored = true;
    this.draftRefreshed = false;
    this.groupsMemo = null;
    this.emit({ kind: 'collection' });
    this.emit({ kind: 'draft' });
  }

  /** Read the rows of the transport again on this workspace,
   *  TRANSPORT_READ_BATCH per request, stoppable; objects not found any more
   *  are marked. */
  async refreshTransport(): Promise<void> {
    if (this.busy || this.locked) return;
    const rids = this.collection.rids();
    if (!rids.length) return;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'draft' }); return; }
    this.refreshBrowse();
    const st: RefreshState = { status: 'reading', done: 0, total: rids.length, gone: 0 };
    this.refresh = st;
    this.emit({ kind: 'draft' });
    for (let i = 0; i < rids.length; i += TRANSPORT_READ_BATCH) {
      if (st.status !== 'reading' || this.disposed) break;
      const batch = rids.slice(i, i + TRANSPORT_READ_BATCH);
      const read = await this.readRows(batch, conn, st);
      if (!Array.isArray(read)) { if ('error' in read) { st.status = 'failed'; st.error = read.error; } break; }
      const now = this.deps.now().toISOString();
      for (const r of read) {
        const item = this.collection.get(r.rid);
        if (!item) continue;
        if ('row' in r) this.collection.update(r.rid, { row: r.row, readAt: now, gone: undefined });
        else if ('missing' in r) { this.collection.update(r.rid, { gone: true, readAt: now }); st.gone++; }
      }
      st.done = Math.min(rids.length, i + batch.length);
      this.groupsMemo = null;
      this.emit({ kind: 'draft' });
    }
    if (st.status === 'reading') { st.status = 'done'; this.draftRefreshed = true; }
    st.requestId = undefined;
    st.abort = undefined;
    this.collectionChanged();
    this.emit({ kind: 'draft' });
  }

  stopRefresh(): void {
    const st = this.refresh;
    if (!st || st.status !== 'reading') return;
    st.status = 'stopped';
    if (st.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: st.requestId });
    st.abort?.abort();
    this.emit({ kind: 'draft' });
  }

  // ── the target ──────────────────────────────────────────────────

  /** Compatibility: scripts for any workspace ('any') or a comparison ('target'). */
  setMode(mode: BuildMode): void {
    if (this.mode === mode || this.locked) return;
    this.mode = mode;
    this.choiceMade = true;
    this.dropBuild();
    this.emit({ kind: 'targets' });
  }

  /** Read which other workspaces Companion is connected to (sends nothing
   *  to a server). Until the person chose, the first one is the target; a
   *  chosen one that is no longer there goes back to the pasted comparison. */
  async loadTargets(): Promise<void> {
    const conn = await this.ensureConnection();
    let targets: TransportTarget[] = [];
    if (conn) {
      try {
        const res = await this.deps.request({ type: 'TRANSPORT_TARGETS', requestId: this.nextId(), environment: conn.environment }, SCAN_WAIT_MS, new AbortController().signal);
        if (res?.type === 'TRANSPORT_TARGETS_RESULT' && res.ok) targets = (res.targets ?? []).filter(t => t.environment !== conn.environment);
      } catch { /* none */ }
    }
    if (this.disposed) return;
    this.targets = targets;
    if (this.target && !targets.some(t => t.environment === this.target)) this.target = '';
    if (!this.choiceMade && this.mode === 'target' && !this.target && targets.length && !this.bundle) this.target = targets[0].environment;
    this.emit({ kind: 'targets' });
    await this.loadLastApply();
  }

  /** Choose the connected workspace to compare with, or '' for the pasted comparison. */
  setTarget(environment: string): void {
    if (this.locked || this.target === environment) return;
    if (environment && !this.targets?.some(t => t.environment === environment)) return;
    this.target = environment;
    this.choiceMade = true;
    if (this.bundle && this.bundle.mode === 'target') this.dropBuild();
    this.emit({ kind: 'targets' });
  }

  /** The target picker's value. */
  get choice(): TargetChoice {
    if (this.mode === 'any') return CHOICE_ANY;
    return this.target ? choiceOf(this.target) : CHOICE_PASTE;
  }

  /** Choose from the target picker. */
  setChoice(choice: TargetChoice): void {
    if (this.locked || choice === this.choice) return;
    if (choice === CHOICE_ANY) { this.mode = 'any'; this.choiceMade = true; this.dropBuild(); this.emit({ kind: 'targets' }); return; }
    if (choice === CHOICE_PASTE) { this.mode = 'target'; this.target = ''; this.choiceMade = true; this.dropBuild(); this.emit({ kind: 'targets' }); return; }
    if (!choice.startsWith('env:')) return;
    const env = choice.slice(4);
    if (!this.targets?.some(t => t.environment === env)) return;
    this.mode = 'target';
    this.target = env;
    this.choiceMade = true;
    this.dropBuild();
    this.emit({ kind: 'targets' });
    void this.loadLastApply();
  }

  /** The chosen connected target, when there is one. */
  get chosenTarget(): TransportTarget | undefined {
    return this.mode === 'target' && this.target ? this.targets?.find(t => t.environment === this.target) : undefined;
  }

  /** What was built goes (another target was chosen). */
  private dropBuild(): void {
    if (!this.bundle || this.running) return;
    this.stopCreation();
    this.stopReading();
    this.bundle = null;
    this.notice = null;
    this.emit({ kind: 'bundle' });
  }

  // ── build: scripts, or a comparison ─────────────────────────────

  /** The transport changed since it was built: what is shown is not its. */
  get stale(): boolean {
    const b = this.bundle;
    if (!b || b.target?.undoOf) return false;
    const now = this.transportItems().map(i => i.rid);
    return now.length !== b.rids.length || now.some((rid, i) => rid !== b.rids[i]);
  }

  /** The action the header offers. It always reads the objects again on this
   *  workspace first: a change made here since the last comparison would
   *  otherwise be compared from the text read before it. */
  async compareOrBuild(): Promise<void> {
    await this.buildBundle();
  }

  /** Read the objects of the transport, then build the scripts (mode 'any')
   *  or the comparison (mode 'target'; with a connected target, compare at
   *  once). */
  async buildBundle(): Promise<void> {
    if (this.busy || this.locked) return;
    if (!this.transportItems().length) return;
    this.error = null;
    this.notice = null;
    this.beforeUndo = null;
    // Folders taken whole are read again first: objects added under them since come along.
    if (!await this.rereadFolders()) return;
    const items = this.transportItems();
    if (!items.length) return;
    const direct = this.chosenTarget;
    this.bundle = { mode: this.mode, status: 'reading', rids: items.map(i => i.rid), items: new Map(items.map(i => [i.rid, i])), reads: new Map(), fileLimitKb: this.fileLimitKb, fileContent: this.fileContent, ...(direct ? { direct } : {}) };
    this.tab = 'transport';
    this.emit({ kind: 'view' });
    await this.readMissing();
  }

  /** Read the objects not read yet (after Stop). */
  async continueReading(): Promise<void> {
    const b = this.bundle;
    if (!b || this.busy || b.status === 'done') return;
    this.error = null;
    await this.readMissing();
  }

  private async readMissing(): Promise<void> {
    const b = this.bundle;
    if (!b) return;
    const conn = await this.ensureConnection();
    if (!conn) { b.status = 'failed'; b.error = NOT_CONNECTED; this.error = NOT_CONNECTED; this.emit({ kind: 'bundle' }); return; }
    b.status = 'reading';
    b.error = undefined;
    this.emit({ kind: 'bundle' });
    const todo = b.rids.filter(rid => !b.reads.has(rid));
    for (let i = 0; i < todo.length; i += TRANSPORT_READ_BATCH) {
      if (this.bundle !== b || b.status !== 'reading' || this.disposed) return;
      const batch = todo.slice(i, i + TRANSPORT_READ_BATCH);
      const end = await this.readBatch(b, batch, conn);
      if (this.bundle !== b) return;
      this.emit({ kind: 'bundle' });
      if (end !== 'next') return;
    }
    if (b.status !== 'reading') return;
    // An object the read says does not exist here: not found, left out.
    const gone = b.rids.filter(rid => { const r = b.reads.get(rid); return !!r && !r.ok && !!r.missing; });
    if (gone.length) {
      const now = this.deps.now().toISOString();
      for (const rid of gone) this.collection.update(rid, { gone: true, readAt: now });
      b.rids = b.rids.filter(rid => !gone.includes(rid));
      this.collectionChanged();
    }
    this.assemble(b);
    this.emit({ kind: 'bundle' });
    void this.readFacts();
    // Compared by Companion: the comparison runs on the target at once.
    if (b.target?.direct && this.bundle === b) await this.compare();
  }

  private async readBatch(b: BundleState, rids: string[], conn: TransportConnection): Promise<'next' | 'stopped' | 'fatal'> {
    const requestId = this.nextId();
    b.requestId = requestId;
    b.abort = new AbortController();
    // Every Add is made from the object's values, except that of a property
    // definition: its links to classes are only in generate(true). For any
    // workspace that text is read with the objects to add; for a comparison
    // after the answer, for every property definition (the target may have
    // it with other links).
    const creation = b.mode === 'any' ? rids.filter(rid => this.isNewRid(b, rid) && isPropertyDefinition(b.items.get(rid)?.row.className ?? '')) : [];
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request({ type: 'TRANSPORT_READ_OBJECTS', requestId, environment: conn.environment, rids, ...(creation.length ? { creation } : {}), fileLimit: b.fileContent ? fileLimitChars(b.fileLimitKb) : 0 }, READ_WAIT_MS, b.abort.signal);
    } catch (e) {
      if (b.status !== 'reading' || this.disposed) return 'stopped';
      return this.readFailed(b, requestFailureLine(e));
    }
    if (b.status !== 'reading' || this.disposed) return 'stopped';
    if (res?.type === 'REQUEST_FAILED' || res?.type !== 'TRANSPORT_OBJECTS_RESULT') {
      return this.readFailed(b, res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER);
    }
    const r = res as Msg<'TRANSPORT_OBJECTS_RESULT'>;
    if (r.cancelled) { b.status = 'stopped'; return 'stopped'; }
    if (!r.ok) {
      if (!isLocalFailure(r)) return this.readFailed(b, r.error || 'The objects could not be read.');
      for (const rid of rids) b.reads.set(rid, { rid, ok: false, error: r.error || 'The objects could not be read.' });
      return 'next';
    }
    const byRid = new Map((r.objects ?? []).map(o => [o.rid, o]));
    for (const rid of rids) b.reads.set(rid, byRid.get(rid) ?? { rid, ok: false, error: 'The server did not answer for this object.' });
    return 'next';
  }

  private readFailed(b: BundleState, line: string): 'fatal' {
    b.status = 'failed';
    b.error = line;
    this.error = line;
    return 'fatal';
  }

  /** Is the object added when the target lacks it, in scripts without
   *  comparison? Every object, except a linked copy (a copy is made by a
   *  link on the target). */
  private isNewRid(b: BundleState, rid: string): boolean {
    const item = b.items.get(rid);
    return !!item && !item.row.linkedTo;
  }

  /** The inputs of the reads, in the transport's order. */
  private inputsOf(b: BundleState): BundleInput[] {
    const inputs: BundleInput[] = [];
    for (const rid of b.rids) {
      const item = b.items.get(rid);
      const row = item?.row;
      const read = b.reads.get(rid);
      if (!item || !row || !read) continue;
      const base = {
        rid, id: row.id, name: row.name, isNew: this.isNewRid(b, rid),
        ...(row.linkedTo ? { linkedTo: row.linkedTo } : {}), ...(this.isTemplate(item) ? { template: true } : {}),
      };
      if (read.ok) {
        inputs.push({
          ...base, className: read.className || row.className, genedit: read.genedit,
          ...(read.isFile || read.fileSize != null ? { file: { ...(read.fileSize != null ? { size: read.fileSize } : {}), carried: !!read.contentCarried } } : {}),
          ...(read.generate != null ? { generate: read.generate } : {}), ...(read.creationError != null ? { creationError: read.creationError } : {}),
          ...(read.instances != null ? { instances: read.instances } : {}), ...(read.flowStep ? { flowStep: true } : {}),
          parentAddress: read.parentAddress, previousAddress: read.previousAddress, nextAddress: read.nextAddress,
          parentId: read.parentId, parentIsRoot: read.parentIsRoot, systemObject: read.systemObject,
          ...(read.neighboursError != null ? { neighboursError: read.neighboursError } : {}),
        });
      } else {
        inputs.push({ ...base, className: row.className, readError: read.error });
      }
    }
    return inputs;
  }

  /** Under the Templates area. */
  isTemplate(item: CollectionItem): boolean {
    return (item.area ?? rootOfId(item.row.parentId)) === 'templateCategory';
  }

  private assemble(b: BundleState): void {
    b.inputs = this.inputsOf(b);
    if (b.mode === 'any') b.result = assembleBundle(b.inputs);
    else {
      const listing = this.listingScope(b);
      b.target = {
        probe: buildProbe(b.inputs, listing ? { listing: { start: listing.start } } : {}), texts: new Map(), answerText: '', clearExtra: false, record: false, recordTitle: '',
        deleteExtra: false, renamesOff: new Set(), ...(listing ? { listing } : {}),
        ...(b.direct ? { direct: { target: b.direct, phase: { kind: 'idle' as const }, stopping: false } } : {}),
      };
    }
    b.status = 'done';
  }

  /**
   * What the comparison lists on the target: an object of the transport
   * that was read in full here (a search under it without a day, not cut)
   * with everything under it in the transport, and the IDs of all of them.
   * Null otherwise: without all of them, the comparison cannot tell what the
   * target has that this workspace does not.
   */
  private listingScope(b: BundleState): { start: string; ids: string[] } | null {
    for (const rid of b.rids) {
      const w = b.items.get(rid)?.whole;
      const left = new Set(w?.leftOut ?? []);
      if (w && w.rids.every(r => left.has(r) || b.items.has(r))) return { start: w.address, ids: w.ids };
    }
    return null;
  }

  private get targetState(): { inputs: BundleInput[]; t: TargetState } | null {
    const b = this.bundle;
    return b?.status === 'done' && b.inputs && b.target ? { inputs: b.inputs, t: b.target } : null;
  }

  /** Read a pasted answer, read the `generate(true)` text of the property
   *  definitions (their links; TRANSPORT_READ_BATCH per request, stoppable),
   *  then build the scripts. A text that cannot be read keeps its place and gets the
   *  parse's error. */
  async readAnswer(text: string): Promise<void> {
    const s = this.targetState;
    if (!s || this.busy || s.t.direct) return;
    await this.useAnswer(s.inputs, s.t, text);
  }

  /** readAnswer's work, for a pasted answer or one Companion read. */
  private async useAnswer(inputs: readonly BundleInput[], t: TargetState, text: string): Promise<void> {
    const s = { inputs, t };
    this.notice = null;
    t.answerText = text;
    const parsed = parseProbeAnswer(text, t.probe);
    t.answer = undefined;
    t.patch = undefined;
    t.answerError = undefined;
    t.creation = undefined;
    if (!parsed.ok) {
      t.answerError = { kind: parsed.kind, error: parsed.error };
      this.emit({ kind: 'patch' });
      return;
    }
    t.answer = parsed.answer;
    t.undoOf = undefined;
    t.undoPlan = undefined;
    // The comparison after an apply: the record of that apply is finished.
    if (this.pendingUndo && t.direct?.then === 'done') {
      const rec = this.pendingUndo, conn = this.pendingConn;
      this.pendingUndo = null;
      const created = conn && t.direct ? await this.readCreated(t.direct, conn, rec) : new Map<string, string>();
      await this.saveUndo(finishUndoRecord(rec, parsed.answer, created));
    }
    // What this workspace has under the listed object now, before anything
    // counts as only on the target.
    await this.readSourceListing(t);
    if (this.disposed || this.bundle?.target !== t) return;
    // A new answer is a new transport: its log entry gets its own ID.
    t.recordEntryId = t.record ? transportEntryId(this.deps.now(), t.probe.key) : undefined;
    // Every other object is added from its values: no creation read.
    const rids = propertyDefinitionRids(s.inputs);
    if (rids.length) {
      t.creation = { status: 'reading', rids };
      await this.readCreation(t);
      return;
    }
    this.rebuildPatch();
    this.emit({ kind: 'patch' });
    void this.readFacts();
  }

  /** Read what this workspace has under the listing start (a comparison
   *  with a listing only), in the target part's form. A failure leaves
   *  `sourceIds` unset and says why. */
  private async readSourceListing(t: TargetState): Promise<void> {
    t.sourceIds = undefined;
    t.sourceError = undefined;
    if (!t.listing) return;
    const conn = await this.ensureConnection();
    if (!conn) { t.sourceError = NOT_CONNECTED; return; }
    try {
      const res = await this.deps.request({ type: 'TRANSPORT_SOURCE_LISTING', requestId: this.nextId(), environment: conn.environment, start: t.listing.start }, SCAN_WAIT_MS, new AbortController().signal);
      if (res?.type === 'TRANSPORT_SOURCE_LISTING_RESULT' && res.ok && Array.isArray(res.ids)) t.sourceIds = res.ids;
      else t.sourceError = (res && 'error' in res && typeof res.error === 'string' && res.error) || NO_ANSWER;
    } catch (e) {
      t.sourceError = requestFailureLine(e);
    }
  }

  /** Read the creation texts not read yet (after Stop or a failure). */
  async continueCreation(): Promise<void> {
    const t = this.targetState?.t;
    const c = t?.creation;
    if (!t || !c || this.busy || c.status === 'done') return;
    this.error = null;
    c.status = 'reading';
    await this.readCreation(t);
  }

  /** Creation texts of the current answer read so far. */
  creationDone(t: TargetState): number {
    return t.creation ? t.creation.rids.filter(rid => t.texts.has(rid)).length : 0;
  }

  private async readCreation(t: TargetState): Promise<void> {
    const c = t.creation;
    if (!c) return;
    c.error = undefined;
    this.emit({ kind: 'patch' });
    const conn = await this.ensureConnection();
    if (!conn) { this.creationFailed(c, NOT_CONNECTED); return; }
    const todo = c.rids.filter(rid => !t.texts.has(rid));
    for (let i = 0; i < todo.length; i += TRANSPORT_READ_BATCH) {
      if (t.creation !== c || c.status !== 'reading' || this.disposed) return;
      const end = await this.readCreationBatch(t, c, todo.slice(i, i + TRANSPORT_READ_BATCH), conn);
      if (t.creation !== c) return;
      this.emit({ kind: 'patch' });
      if (end !== 'next') return;
    }
    if (c.status !== 'reading') return;
    c.status = 'done';
    c.requestId = undefined;
    c.abort = undefined;
    this.rebuildPatch();
    this.emit({ kind: 'patch' });
    this.settleDirect(t);
    void this.readFacts();
  }

  private async readCreationBatch(t: TargetState, c: CreationState, rids: string[], conn: TransportConnection): Promise<'next' | 'stopped' | 'fatal'> {
    const requestId = this.nextId();
    c.requestId = requestId;
    c.abort = new AbortController();
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request({ type: 'TRANSPORT_READ_CREATION', requestId, environment: conn.environment, rids }, READ_WAIT_MS, c.abort.signal);
    } catch (e) {
      if (c.status !== 'reading' || this.disposed) return 'stopped';
      return this.creationFailed(c, requestFailureLine(e));
    }
    if (c.status !== 'reading' || this.disposed) return 'stopped';
    if (res?.type === 'REQUEST_FAILED' || res?.type !== 'TRANSPORT_CREATION_RESULT') {
      return this.creationFailed(c, res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER);
    }
    const r = res as Msg<'TRANSPORT_CREATION_RESULT'>;
    if (r.cancelled) { c.status = 'stopped'; return 'stopped'; }
    if (!r.ok) {
      if (!isLocalFailure(r)) return this.creationFailed(c, r.error || 'The links of the property definitions could not be read.');
      for (const rid of rids) t.texts.set(rid, { rid, ok: false, error: r.error || 'The links of the property definitions could not be read.' });
      return 'next';
    }
    const byRid = new Map((r.texts ?? []).map(x => [x.rid, x]));
    for (const rid of rids) t.texts.set(rid, byRid.get(rid) ?? { rid, ok: false, error: 'The server did not answer for this object.' });
    return 'next';
  }

  private creationFailed(c: CreationState, line: string): 'fatal' {
    c.status = 'failed';
    c.error = line;
    this.error = line;
    this.emit({ kind: 'patch' });
    return 'fatal';
  }

  /** Stop reading creation texts: the batch being read is cancelled. */
  stopCreation(): void {
    const c = this.bundle?.target?.creation;
    if (!c || c.status !== 'reading') return;
    c.status = 'stopped';
    if (c.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: c.requestId });
    c.abort?.abort();
    this.emit({ kind: 'patch' });
  }

  /** The inputs with the creation texts read for the target. */
  private patchInputs(inputs: readonly BundleInput[], t: TargetState): BundleInput[] {
    return inputs.map(i => {
      const x = t.texts.get(i.rid);
      if (!x) return i;
      const { generate: _old, instances: _was, ...rest } = i;
      if (x.ok) return { ...rest, generate: x.generate, ...(x.instances != null ? { instances: x.instances } : {}) };
      return { ...rest, creationError: x.error };
    });
  }

  /** Build the scripts again from the same answer with the current options
   *  (not while creation texts are still missing). */
  private rebuildPatch(): void {
    const s = this.targetState;
    if (!s?.t.answer) return;
    const { t, inputs } = s;
    if (t.creation && t.creation.status !== 'done') return;
    const unread = inputs.filter(i => i.readError != null).length;
    t.unreadHere = unread || undefined;
    try {
      t.patch = assemblePatch(this.patchInputs(inputs, t), t.answer!, {
        clearExtra: t.clearExtra,
        // Only from what this workspace has now: without it, or when an object
        // of the transport could not be read here, nothing is only on the target.
        ...(t.listing && t.sourceIds && !unread ? { sourceIds: t.sourceIds } : {}), deleteExtra: t.deleteExtra && !unread, renamesOff: t.renamesOff,
        targetName: t.direct?.target.label ?? 'the target',
        ...(t.record && t.recordEntryId ? { record: { entryId: t.recordEntryId, title: t.recordTitle } } : {}),
      });
      t.answerError = undefined;
    } catch (e) {
      t.patch = undefined;
      t.answerError = { kind: 'patch', error: errorText(e) };
    }
  }

  /** Clear values only the target has (on) or keep them (off). */
  setClearExtra(on: boolean): void {
    const s = this.targetState;
    if (!s || s.t.clearExtra === on || this.optionsLocked(s.t)) return;
    s.t.clearExtra = on;
    this.rebuildPatch();
    this.optionsChanged(s.t);
    this.emit({ kind: 'patch' });
  }

  /** Delete the objects only the target has (on) or keep them (off). */
  setDeleteExtra(on: boolean): void {
    const s = this.targetState;
    if (!s || s.t.deleteExtra === on || this.optionsLocked(s.t)) return;
    s.t.deleteExtra = on;
    this.rebuildPatch();
    this.optionsChanged(s.t);
    this.emit({ kind: 'patch' });
  }

  /** Apply an ID change (on) or add the object and keep the old one (off). */
  setRename(key: string, on: boolean): void {
    const s = this.targetState;
    if (!s || s.t.renamesOff.has(key) === !on || this.optionsLocked(s.t)) return;
    if (on) s.t.renamesOff.delete(key); else s.t.renamesOff.add(key);
    this.rebuildPatch();
    this.optionsChanged(s.t);
    this.emit({ kind: 'patch' });
  }

  /** Add (or leave out) the transport log entry. Its ID is fixed per answer,
   *  when the option is first turned on. */
  setRecord(on: boolean): void {
    const s = this.targetState;
    if (!s || s.t.record === on || this.optionsLocked(s.t)) return;
    s.t.record = on;
    if (on && !s.t.recordEntryId) s.t.recordEntryId = transportEntryId(this.deps.now(), s.t.probe.key);
    this.rebuildPatch();
    this.optionsChanged(s.t);
    this.emit({ kind: 'patch', partsOnly: true });
  }

  setRecordTitle(title: string): void {
    const s = this.targetState;
    if (!s || s.t.recordTitle === title || this.optionsLocked(s.t)) return;
    s.t.recordTitle = title;
    if (!s.t.record) return;
    this.rebuildPatch();
    this.emit({ kind: 'patch', partsOnly: true });
  }

  /** Stop reading: the batch being read is cancelled. */
  stopReading(): void {
    this.stopCreation();
    const b = this.bundle;
    if (!b || b.status !== 'reading') return;
    b.status = 'stopped';
    if (b.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: b.requestId });
    b.abort?.abort();
    this.emit({ kind: 'bundle' });
  }

  // ── what was built, per object ──────────────────────────────────

  /** The state of each object after a comparison (or the left-out objects
   *  of scripts without one). */
  states(): Map<string, ItemStateInfo> {
    const b = this.bundle;
    if (!b || b.status !== 'done') return new Map();
    if (b.result) return itemStates([], b.result.leftOut);
    const p = b.target?.patch;
    if (p) return itemStates(p.review, p.leftOut);
    // Before the answer: what the comparison leaves out already.
    return b.target ? itemStates([], b.target.probe.leftOut) : new Map();
  }

  /** The objects' addresses as read (lower case → RID). */
  private addressRids(): Map<string, string> {
    const out = new Map<string, string>();
    for (const i of this.bundle?.inputs ?? []) {
      const a = i.genedit ? i.genedit.trim().split('.change(')[0] : '';
      if (a) out.set(addressKey(a), i.rid);
    }
    return out;
  }

  /** What the target holds at an address (lower case), from the comparison. */
  private targetHas(key: string): 'present' | 'missing' | undefined {
    const states = this.bundle?.target?.answer?.states;
    if (!states) return undefined;
    for (const [a, s] of Object.entries(states)) if (addressKey(a) === key) return s.state;
    return undefined;
  }

  /** Not on this workspace: looked up in vain ("Add them") or by the facts read. */
  /** Is the used object (lower-case address) known on this workspace: found
   *  by "Add them" or read with the facts? */
  private hereKnown(key: string): boolean {
    const f = this.facts.get(key);
    return this.looked.has(key) || (!!f && !('missing' in f));
  }

  /** The used objects the target lacks that could not be checked: this
   *  workspace does not have them either, or they could not be looked up
   *  here. Never counted as missing, never offered for "Add them". */
  uncheckedUses(): string[] {
    const b = this.bundle;
    const u = this.uses();
    if (!b?.target?.answer || !u) return [];
    const states = new Map(Object.entries(b.target.answer.states).map(([a, st]) => [addressKey(a), st.state]));
    return u.outside.filter(o => !o.missing && states.get(o.key) === 'missing').map(o => o.address);
  }

  private notHere(key: string): boolean {
    const f = this.facts.get(key);
    return this.notFound.has(key) || (!!f && 'missing' in f);
  }

  /** The state of a used object (lower-case address): on the target first,
   *  then not found here, then missing on the target. */
  useState(key: string): UseState {
    if (this.addressRids().has(key)) return 'transport';
    const t = this.targetHas(key);
    if (t === 'present') return 'target';
    if (this.notHere(key)) return 'not-found';
    return t === 'missing' ? 'missing' : 'unknown';
  }

  private usesMemo: { b: BundleState | null; answer: unknown; nf: number; looked: number; facts: number; index: UsesIndex | null } | null = null;

  /** What the objects use (null before anything was read). */
  uses(): UsesIndex | null {
    const b = this.bundle;
    if (!b || b.status !== 'done' || !b.inputs) return null;
    const answer = b.target?.answer;
    const m = this.usesMemo;
    if (m && m.b === b && m.answer === answer && m.nf === this.notFound.size && m.looked === this.looked.size && m.facts === this.facts.size) return m.index;
    const inside = new Set(this.addressRids().keys());
    const target = new Map<string, { state: 'present' | 'missing'; className?: string }>();
    for (const [a, s] of Object.entries(answer?.states ?? {})) target.set(addressKey(a), s.state === 'present' ? { state: 'present', className: s.className } : { state: 'missing' });
    const index = usesIndex(
      b.inputs.filter(i => i.genedit).map(i => ({ rid: i.rid, genedit: i.genedit! })),
      inside,
      k => {
        const row = this.looked.get(k);
        if (row) return { name: row.name, className: row.className, ...(rootOfId(row.parentId) ? { area: rootOfId(row.parentId)! } : {}) };
        const f = this.facts.get(k);
        if (f && !('missing' in f)) return { name: f.name, className: f.className, ...(rootOfId(f.parentId) ? { area: rootOfId(f.parentId)! } : {}) };
        const t = target.get(k);
        return t?.className ? { className: t.className } : {};
      },
      k => {
        const t = target.get(k);
        if (t?.state === 'present') return 'target';
        if (this.notHere(k)) return 'not-found';
        return t ? 'missing' : 'unknown';
      },
      // Missing on the target only when this workspace has it: an address
      // this workspace does not have either (code that adds it, a variable
      // in code) or could not look up cannot be checked.
      k => target.get(k)?.state === 'missing' && this.hereKnown(k),
    );
    this.usesMemo = { b, answer, nf: this.notFound.size, looked: this.looked.size, facts: this.facts.size, index };
    return index;
  }

  /** The addresses one object uses, each with its name (when known) and state. */
  usesOf(rid: string): Array<{ address: string; name: string; state: UseState; rid?: string }> | null {
    const u = this.uses();
    const list = u?.perObject.get(rid);
    if (!u || !list) return null;
    const inside = this.addressRids();
    const outside = new Map(u.outside.map(o => [o.key, o]));
    return list.map(a => {
      const k = addressKey(a);
      const own = inside.get(k);
      if (own) return { address: a, name: this.collection.get(own)?.row.name ?? '', state: 'transport' as const, rid: own };
      const o = outside.get(k);
      return { address: a, name: o?.name ?? '', state: o?.state ?? 'unknown' };
    });
  }

  /** The objects of the transport that use the object `rid` (from what was
   *  read with the build), in the transport's order. */
  usersInside(rid: string): CollectionItem[] {
    const u = this.uses();
    if (!u) return [];
    let own = '';
    for (const [k, r] of this.addressRids()) if (r === rid) own = k;
    if (!own) return [];
    const out: CollectionItem[] = [];
    for (const [r, list] of u.perObject) {
      if (r === rid || !list.some(a => addressKey(a) === own)) continue;
      const item = this.collection.get(r);
      if (item) out.push(item);
    }
    return out;
  }

  /** Used objects outside the transport whose class is not known yet. */
  private factsWanted(): string[] {
    const u = this.uses();
    if (!u) return [];
    return u.outside.filter(o => (o.kind === 'other' || !o.name) && !this.facts.has(o.key) && !this.looked.has(o.key) && !this.notFound.has(o.key) && isFactAddress(o.address))
      .map(o => o.address).slice(0, TRANSPORT_FACTS_CAP);
  }

  /**
   * Look up on this workspace the used objects outside the transport that
   * have no class yet (TRANSPORT_FACTS_BATCH per request, at most
   * TRANSPORT_FACTS_CAP, stoppable). Runs by itself after a build or a
   * comparison; nothing waits for it: the map and the chips fill in.
   */
  async readFacts(): Promise<void> {
    if (this.factsRead?.status === 'reading' || this.disposed) return;
    const wanted = this.factsWanted();
    if (!wanted.length) return;
    const conn = await this.ensureConnection();
    if (!conn || this.disposed) return;
    const st: NonNullable<TransportController['factsRead']> = { status: 'reading', done: 0, total: wanted.length };
    this.factsRead = st;
    for (let i = 0; i < wanted.length; i += TRANSPORT_FACTS_BATCH) {
      if (st.status !== 'reading' || this.disposed) return;
      const batch = wanted.slice(i, i + TRANSPORT_FACTS_BATCH);
      st.requestId = this.nextId();
      st.abort = new AbortController();
      let res: InspectorMessage | undefined;
      try {
        res = await this.deps.request({ type: 'TRANSPORT_FACTS', requestId: st.requestId, environment: conn.environment, addresses: batch }, READ_WAIT_MS, st.abort.signal);
      } catch (e) {
        if (st.status === 'reading') { st.status = 'failed'; st.error = requestFailureLine(e); }
        break;
      }
      if (st.status !== 'reading' || this.disposed) return;
      if (res?.type !== 'TRANSPORT_FACTS_RESULT' || !res.ok || res.cancelled) {
        st.status = res?.type === 'TRANSPORT_FACTS_RESULT' && res.cancelled ? 'stopped' : 'failed';
        st.error = res?.type === 'REQUEST_FAILED' ? res.error : res?.type === 'TRANSPORT_FACTS_RESULT' ? res.error : NO_ANSWER;
        break;
      }
      for (const f of res.facts ?? []) this.facts.set(addressKey(f.address), f);
      st.done = Math.min(wanted.length, i + batch.length);
      this.emit({ kind: 'facts' });
    }
    if (st.status === 'reading') st.status = 'done';
    st.requestId = undefined;
    st.abort = undefined;
    this.emit({ kind: 'facts' });
  }

  stopFacts(): void {
    const st = this.factsRead;
    if (!st || st.status !== 'reading') return;
    st.status = 'stopped';
    if (st.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: st.requestId });
    st.abort?.abort();
    this.emit({ kind: 'facts' });
  }

  /** The map of the transport. */
  mapModel(): TransportMapModel {
    return mapModel(this.placeGroups(), this.states(), this.uses(), this.uploads());
  }

  /** Turn "Carry the content of files" on or off. What was built goes. */
  setFileContent(on: boolean): void {
    if (on === this.fileContent || this.locked) return;
    this.fileContent = on;
    this.dropBuild();
    this.emit({ kind: 'fileLimit' });
    this.scheduleSave();
  }

  /** Change "Carry the content of files up to n KB" (1 to 19). What was
   *  built goes: it was read with the old limit. Kept with the draft. */
  setFileLimit(kb: number): void {
    const v = fileLimitKb(kb);
    if (v === this.fileLimitKb || this.locked) return;
    this.fileLimitKb = v;
    this.dropBuild();
    this.emit({ kind: 'fileLimit' });
    this.scheduleSave();
  }

  /** The files added without their content (upload them on the target). */
  uploads(): UploadFile[] {
    const b = this.bundle;
    if (!b || b.status !== 'done') return [];
    return b.result?.uploads ?? b.target?.patch?.uploads ?? [];
  }

  /** What a file of the transport does with its content, once read: its
   *  size, whether it is carried, and when not, whether only a script part
   *  stops it (within the limit). */
  fileOf(rid: string): { size?: number; carried: boolean; part: boolean; limitKb: number; contentOn: boolean } | null {
    const b = this.bundle;
    const f = b?.inputs?.find(i => i.rid === rid)?.file;
    if (!b || !f) return null;
    return {
      ...(f.size != null ? { size: f.size } : {}), carried: f.carried, part: !f.carried && f.size != null && fileContent(f.size, b.fileLimitKb).part,
      limitKb: b.fileLimitKb, contentOn: b.fileContent,
    };
  }

  /** The objects under Templates in the transport. */
  templates(): CollectionItem[] {
    return this.transportItems().filter(i => this.isTemplate(i));
  }

  // ── compare with and apply to a connected target ────────────────

  /** The direct state of the comparison shown now. */
  get direct(): DirectState | undefined {
    return this.bundle?.target?.direct;
  }

  /** Options may not change while the apply is confirmed or anything runs. */
  private optionsLocked(t: TargetState): boolean {
    const k = t.direct?.phase.kind;
    return k === 'confirming' || k === 'comparing' || k === 'applying' || k === 'verifying';
  }

  /** The scripts changed with an option: an outcome shown is no longer theirs. */
  private optionsChanged(t: TargetState): void {
    const d = t.direct;
    if (d?.phase.kind === 'done' && t.patch) this.setPhase(d, { kind: 'reviewed' });
  }

  private setPhase(d: DirectState, phase: DirectPhase): void {
    d.phase = phase;
    this.emit({ kind: 'apply' });
  }

  /** Can the scripts be applied now: compared on their target, something to
   *  do, the transport unchanged since, nothing running? */
  canApply(): boolean {
    const t = this.targetState?.t;
    const d = t?.direct;
    return !!d && !!t.patch && !t.patch.nothingToDo && !this.busy && !this.stale && d.answerFrom === d.target.environment
      && (d.phase.kind === 'reviewed' || d.phase.kind === 'done');
  }

  /** Can Compare (again) run now? */
  canCompare(): boolean {
    return !!this.targetState?.t.direct && !this.busy && this.direct?.phase.kind !== 'confirming';
  }

  /**
   * Run the comparison script on the target, part after part as previews
   * (stoppable, between parts or by cancelling the part that runs), read the
   * answers as a pasted answer is read, read the links of the property
   * definitions on this workspace and build the scripts.
   */
  async compare(): Promise<void> {
    const s = this.targetState;
    const d = s?.t.direct;
    // Nothing can be compared: the reasons are shown, nothing runs.
    if (!s || !d || !this.canCompare() || !s.t.probe.parts.length) return;
    await this.runProbe(s.inputs, s.t, d, 'comparing');
  }

  private async runProbe(inputs: readonly BundleInput[], t: TargetState, d: DirectState, kind: 'comparing' | 'verifying'): Promise<void> {
    const stage: ApplyStage = kind === 'verifying' ? 'verify' : 'compare';
    const parts = t.probe.parts;
    d.stopping = false;
    d.answerFrom = undefined;
    this.notice = null;
    this.setPhase(d, { kind, part: parts.length ? 1 : 0, total: parts.length });
    const conn = await this.ensureConnection();
    if (!conn) { this.setPhase(d, { kind: 'failed', stage, error: NOT_CONNECTED }); return; }
    const logs: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (this.disposed || t.direct !== d || this.bundle?.target !== t) return;
      if (d.stopping) { this.setPhase(d, { kind: 'stopped', stage: 'compare', after: i, total: parts.length, applied: 0 }); return; }
      this.setPhase(d, { kind, part: i + 1, total: parts.length });
      const r = await this.runPart(d, conn, parts[i].text, false);
      if (this.disposed || this.bundle?.target !== t) return;
      if (r.kind === 'stopped') { this.setPhase(d, { kind: 'stopped', stage: 'compare', after: i, total: parts.length, applied: 0 }); return; }
      if (r.kind === 'failed') { this.setPhase(d, { kind: 'failed', stage, part: i + 1, total: parts.length, error: r.error }); return; }
      logs.push(r.log);
    }
    d.answerFrom = d.target.environment;
    d.then = kind === 'verifying' ? 'done' : 'reviewed';
    await this.useAnswer(inputs, t, logs.join('\n'));
    if (this.disposed || this.bundle?.target !== t) return;
    if (t.answerError) {
      d.answerFrom = undefined;
      this.setPhase(d, { kind: 'failed', stage, error: t.answerError.error });
      return;
    }
    if (t.patch) { this.settleDirect(t); return; }
    // The creation texts were not all read (stopped or failed): the status
    // line offers to go on; the outcome follows when they are.
    this.setPhase(d, { kind: 'idle' });
  }

  /** Scripts were built from a comparison: reviewed, or done after an apply. */
  private settleDirect(t: TargetState): void {
    const d = t.direct;
    if (!d || !t.patch || d.answerFrom !== d.target.environment || !d.then) return;
    const then = d.then;
    d.then = undefined;
    this.setPhase(d, then === 'done' ? { kind: 'done', remaining: remainingOf(t.patch.counts) } : { kind: 'reviewed' });
  }

  /** Stop comparing: the part that runs is cancelled (a preview). */
  stopCompare(): void {
    const d = this.direct;
    if (!d || (d.phase.kind !== 'comparing' && d.phase.kind !== 'verifying')) return;
    d.stopping = true;
    if (d.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: d.requestId });
    d.abort?.abort();
    this.emit({ kind: 'apply' });
  }

  /** Ask to apply: shows the confirmation. Nothing is sent. */
  requestApply(): void {
    const d = this.direct;
    if (!d || !this.canApply()) return;
    this.setPhase(d, { kind: 'confirming' });
  }

  /** Close the confirmation without applying. */
  cancelApply(): void {
    const d = this.direct;
    if (d?.phase.kind === 'confirming') this.setPhase(d, { kind: 'reviewed' });
  }

  /**
   * Apply the confirmed scripts to their target: the Check parts as previews,
   * each of which must say Ready (CHECK_READY_LINE), then each committed part
   * in order, one at a time, as a committed run. A part fails when its result
   * is not ok, its log says that nothing was stored (NO_CHANGES_LINE) or the
   * request failed or timed out (then its outcome is unknown and nothing is
   * tried again); later parts do not run. Stop takes effect between parts.
   * After the last part the comparison runs again and gives the outcome.
   */
  async apply(): Promise<void> {
    const s = this.targetState;
    const t = s?.t;
    const d = t?.direct;
    const patch = t?.patch;
    if (!s || !t || !d || !patch || d.phase.kind !== 'confirming' || patch.nothingToDo || d.answerFrom !== d.target.environment) return;
    const parts = applyParts(patch);
    // The files the person uploads afterwards, kept for the outcome.
    d.uploads = t.undoOf ? [] : patch.uploads;
    const total = parts.length;
    d.stopping = false;
    const startedAt = this.deps.now().getTime();
    const conn = await this.ensureConnection();
    if (!conn) { this.setPhase(d, { kind: 'failed', stage: 'check', error: NOT_CONNECTED, applied: 0 }); return; }
    const gone = () => this.disposed || this.bundle?.target !== t || t.patch !== patch;
    // 1. The Check parts as previews: each must say Ready.
    for (let i = 0; i < total; i++) {
      const part = parts[i];
      if (part.run === 'committed') continue;
      if (gone()) return;
      if (d.stopping) { this.setPhase(d, { kind: 'stopped', stage: 'apply', after: i, total, applied: 0 }); return; }
      this.setPhase(d, { kind: 'applying', part: i + 1, total, step: part.step, stepIndex: part.stepIndex, stepTotal: part.stepTotal, startedAt });
      const r = await this.runPart(d, conn, part.text, false);
      if (gone()) return;
      const where = { part: i + 1, total, step: part.step, applied: 0 };
      if (r.kind === 'stopped') { this.setPhase(d, { kind: 'stopped', stage: 'apply', after: i, total, applied: 0 }); return; }
      if (r.kind === 'failed') { this.setPhase(d, { kind: 'failed', stage: 'check', error: r.error, ...where }); return; }
      if (!checkSaysReady(r.log)) {
        const lines = r.log.split(/\r\n?|\n/).map(l => l.trim()).filter(Boolean).slice(0, CHECK_LINES_SHOWN);
        const error = t.undoOf ? `${d.target.label} changed since the apply. Nothing was changed.` : `${d.target.label} changed since the comparison. Nothing was changed.`;
        this.setPhase(d, { kind: 'failed', stage: 'check', error, lines, ...where });
        return;
      }
    }
    // 2. The dry run: each committed part once as a preview, in order, the
    // same text (the target keeps scripts by their text). Nothing is written.
    const writes = parts.map((part, i) => ({ part, i })).filter(x => x.part.run === 'committed');
    const problems: string[] = [];
    const named: string[] = [];
    // The IDs of the objects this apply writes, to name them in a line.
    const ids = new Map((t.patch?.review ?? []).flatMap(x => {
      const id = splitAddress(x.address)?.id;
      return id && /^[A-Za-z0-9_]+$/.test(id) ? [[id.toLowerCase(), x.address] as [string, string]] : [];
    }));
    for (let k = 0; k < writes.length; k++) {
      const { part } = writes[k];
      if (gone()) return;
      if (d.stopping) { this.setPhase(d, { kind: 'stopped', stage: 'apply', after: 0, total, applied: 0 }); return; }
      this.setPhase(d, { kind: 'trying', part: k + 1, total: writes.length });
      const r = await this.runPart(d, conn, part.text, false);
      if (gone()) return;
      if (r.kind === 'stopped') { this.setPhase(d, { kind: 'stopped', stage: 'apply', after: 0, total, applied: 0 }); return; }
      for (const l of r.kind === 'failed' ? [r.error] : dryRunProblems(r.log)) {
        const x = namedProblem(part, l, ids);
        problems.push(x.text);
        if (x.address && !named.some(a => addressKey(a) === addressKey(x.address!))) named.push(x.address);
      }
    }
    if (problems.length) {
      this.setPhase(d, {
        kind: 'failed', stage: 'dryrun', error: `The scripts would fail on ${d.target.label}. Nothing was changed.`, lines: problems.slice(0, DRY_RUN_LINES), applied: 0,
        ...(named.length && !t.undoOf ? { objects: named } : {}),
      });
      return;
    }
    // 3. What undoes this apply, kept before the first write (not for an undo).
    let record = t.undoOf || !t.answer || !s.inputs ? null : buildUndoRecord(patch, t.answer, s.inputs, {
      source: conn.environment, target: d.target.environment, targetLabel: d.target.label, at: this.deps.now().toISOString(),
    });
    if (record) await this.saveUndo(record);
    // 4. The committed parts.
    let applied = 0;
    const kept: string[] = [];
    const halt = async (phase: DirectPhase) => {
      this.setPhase(d, phase);
      // A half-finished apply can be undone too: what the target has now.
      if (record && applied) {
        record = { ...record, stoppedAfter: { part: applied, total: writes.length } };
        record = await this.readAfter(t, d, conn, record);
        await this.saveUndo(record);
      }
    };
    for (const { part, i } of writes) {
      if (gone()) return;
      if (d.stopping) { await halt({ kind: 'stopped', stage: 'apply', after: i, total, applied }); return; }
      this.setPhase(d, { kind: 'applying', part: i + 1, total, step: part.step, stepIndex: part.stepIndex, stepTotal: part.stepTotal, startedAt });
      const r = await this.runPart(d, conn, part.text, true);
      if (gone()) return;
      const where = { part: i + 1, total, step: part.step, applied };
      if (r.kind === 'stopped') { await halt({ kind: 'stopped', stage: 'apply', after: i, total, applied }); return; }
      if (r.kind === 'failed') {
        if (r.unknown) applied++;
        await halt({ kind: 'failed', stage: 'apply', error: r.error, ...where, ...(r.unknown ? { unknown: true } : {}) });
        return;
      }
      kept.push(...keptLines(r.log));
      applied++;
    }
    if (gone()) return;
    if (t.undoOf) {
      // Undone: the record goes; the window shows the outcome.
      await this.removeUndo();
      this.setPhase(d, { kind: 'done', remaining: 0, undone: true, kept: kept.length });
      return;
    }
    // The comparison afterwards is the proof: BMP can print success and
    // still have stored nothing. It also reads when the added objects were
    // added, for the undo.
    this.pendingUndo = record;
    this.pendingConn = conn;
    await this.runProbe(s.inputs, t, d, 'verifying');
  }

  private pendingConn: TransportConnection | null = null;

  /** When the objects of `record` that the apply added were added
   *  (createdTimesText, one preview); none when it cannot be read. */
  private async readCreated(d: DirectState, conn: TransportConnection, record: UndoRecord): Promise<Map<string, string>> {
    if (!record.added.length) return new Map();
    const r = await this.runPart(d, conn, createdTimesText(record.added.map(a => a.address)), false);
    return r.kind === 'ok' ? parseCreatedTimes(r.log) : new Map();
  }

  /** The record of the apply being compared afterwards (finished with that
   *  comparison's answer). */
  private pendingUndo: UndoRecord | null = null;

  /** The comparison read again after a stopped or failed apply, for the
   *  record only (the scripts and the state stay). */
  private async readAfter(t: TargetState, d: DirectState, conn: TransportConnection, record: UndoRecord): Promise<UndoRecord> {
    const logs: string[] = [];
    for (const part of t.probe.parts) {
      const r = await this.runPart(d, conn, part.text, false);
      if (r.kind !== 'ok') return record;
      logs.push(r.log);
    }
    const parsed = parseProbeAnswer(logs.join('\n'), t.probe);
    return parsed.ok ? finishUndoRecord(record, parsed.answer, await this.readCreated(d, conn, record)) : record;
  }

  // ── undo of the last apply ─────────────────────────────────────

  /** The last apply to the chosen target, when it was kept here. */
  lastApply: UndoRecord | null = null;
  private lastApplyFor = '';

  /** Read the record of the chosen target (a dated copy: nothing refreshes it). */
  async loadLastApply(): Promise<void> {
    const t = this.chosenTarget;
    const store = this.deps.store;
    const conn = t && store ? await this.ensureConnection() : null;
    if (!t || !store || !conn) { this.lastApply = null; this.lastApplyFor = ''; this.emit({ kind: 'targets' }); return; }
    const k = undoKey(conn.environment, t.environment);
    let value: unknown;
    try { value = await store.get(k); } catch { value = null; }
    if (this.disposed) return;
    this.lastApply = readUndoRecord(value, conn.environment, t.environment);
    this.lastApplyFor = k;
    this.emit({ kind: 'targets' });
  }

  private async saveUndo(r: UndoRecord): Promise<void> {
    const store = this.deps.store;
    this.lastApply = r;
    this.lastApplyFor = undoKey(r.source, r.target);
    this.emit({ kind: 'targets' });
    if (!store) return;
    try { await store.set(this.lastApplyFor, r); } catch { /* kept in this window only */ }
  }

  /** "Remove": the record of the last apply goes. */
  async removeUndo(): Promise<void> {
    const store = this.deps.store;
    const k = this.lastApplyFor;
    this.lastApply = null;
    this.emit({ kind: 'targets' });
    if (!store || !k) return;
    try { await store.remove(k); } catch { /* none */ }
  }

  /**
   * "Undo": the scripts that bring the target back as it was before the
   * last apply, shown like a comparison's (summary, list states, scripts,
   * confirmation); Apply runs them with their Check and dry run.
   */
  startUndo(): void {
    const r = this.lastApply;
    const target = this.chosenTarget;
    if (!r || !target || r.target !== target.environment || this.busy || this.locked) return;
    const plan = buildUndoPlan(r);
    let b = this.bundle;
    if (!b?.target?.undoOf) {
      const t0 = b?.target;
      this.beforeUndo = b && b.mode === 'target' && t0?.direct && t0.direct.target.environment === target.environment
        ? { bundle: b, patch: t0.patch, phase: t0.direct.phase, answerFrom: t0.direct.answerFrom }
        : { bundle: null };
    }
    if (!b || b.mode !== 'target' || !b.target?.direct || b.target.direct.target.environment !== target.environment) {
      b = {
        mode: 'target', direct: target, status: 'done', rids: this.transportItems().map(i => i.rid), items: new Map(this.transportItems().map(i => [i.rid, i])), reads: new Map(),
        fileLimitKb: this.fileLimitKb, fileContent: this.fileContent, inputs: [],
        target: {
          probe: buildProbe([]), texts: new Map(), answerText: '', clearExtra: false, record: false, recordTitle: '', deleteExtra: false, renamesOff: new Set(),
          direct: { target, phase: { kind: 'idle' }, stopping: false },
        },
      };
      this.bundle = b;
    }
    const t = b.target!;
    t.patch = plan.patch;
    t.undoOf = r;
    t.undoPlan = plan;
    t.direct!.answerFrom = target.environment;
    t.direct!.phase = { kind: 'reviewed' };
    this.emit({ kind: 'bundle' });
    this.emit({ kind: 'patch' });
    this.emit({ kind: 'apply' });
  }

  /** What the window showed before Undo (backToTransport). */
  private beforeUndo: { bundle: BundleState | null; patch?: TransportPatch; phase?: DirectPhase; answerFrom?: string } | null = null;

  /** Is an undo shown (its review, refusal, failure or outcome)? */
  get showingUndo(): boolean {
    return !!this.bundle?.target?.undoOf;
  }

  /** "Back to the transport": leave the undo; the comparison shown before it
   *  comes back (or none, when there was none). */
  backToTransport(): void {
    const t = this.bundle?.target;
    if (!t?.undoOf || this.busy || this.locked) return;
    const before = this.beforeUndo;
    this.beforeUndo = null;
    if (before?.bundle === this.bundle && t.direct) {
      t.patch = before.patch;
      t.direct.answerFrom = before.answerFrom;
      const k = before.phase?.kind;
      t.direct.phase = before.patch ? (k === 'done' ? before.phase! : { kind: 'reviewed' }) : { kind: 'idle' };
      delete t.undoOf;
      delete t.undoPlan;
    } else {
      this.bundle = null;
    }
    this.emit({ kind: 'bundle' });
    this.emit({ kind: 'patch' });
    this.emit({ kind: 'apply' });
  }

/** Is the object at `address` (as the comparison wrote it) in the transport? */
  addressInTransport(address: string): boolean {
    const rid = this.bundle?.target?.patch?.review.find(x => addressKey(x.address) === addressKey(address))?.rid;
    return !!rid && this.collection.has(rid);
  }

  /** The addresses of the transport, in its order, as the ID list takes
   *  them: as read with the last build, else by the object's kind (`k`
   *  properties, `r` files, `o` organisations, else `t`). */
  transportAddresses(): string[] {
    const read = new Map([...this.addressRids()].map(([k, rid]) => [rid, k]));
    const shown = new Map<string, string>();
    for (const x of this.bundle?.target?.patch?.review ?? []) shown.set(x.rid, x.address);
    for (const x of this.bundle?.result?.objects ?? []) shown.set(x.rid, x.address);
    return this.transportItems().map(i => {
      const a = shown.get(i.rid) ?? read.get(i.rid);
      if (a) return a;
      const kind = useKind('', i.row.className, i.area);
      const space = kind === 'properties' ? 'k' : kind === 'files' ? 'r' : kind === 'organisations' ? 'o' : 't';
      return addressOf(space, i.row.id) || addressOf('t', i.row.id);
    }).filter(Boolean);
  }

  /** Remove the object at `address` from the transport (the dry run named it). */
  removeAddress(address: string): void {
    const rid = this.bundle?.target?.patch?.review.find(x => addressKey(x.address) === addressKey(address))?.rid;
    if (rid) this.remove(rid);
  }

  /** Stop applying after the part that runs (it is never cancelled). */
  stopApply(): void {
    const d = this.direct;
    if (!d || (d.phase.kind !== 'applying' && d.phase.kind !== 'trying') || d.stopping) return;
    d.stopping = true;
    this.emit({ kind: 'apply' });
  }

  /** Run one part on the target and read its answer. */
  private async runPart(d: DirectState, conn: TransportConnection, code: string, committed: boolean): Promise<PartRun> {
    const requestId = this.nextId();
    d.requestId = requestId;
    d.abort = new AbortController();
    const msg: InspectorMessage = {
      type: 'TRANSPORT_RUN_PART', requestId, environment: conn.environment, target: d.target.environment, code, transactional: committed,
      ...(committed ? { confirmed: true } : {}),
    };
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request(msg, PART_WAIT_MS, d.abort.signal);
    } catch (e) {
      if (!committed && (d.stopping || this.disposed)) return { kind: 'stopped' };
      // A committed part whose answer did not come may have been applied.
      return { kind: 'failed', error: requestFailureLine(e), ...(committed ? { unknown: true } : {}) };
    } finally {
      if (d.requestId === requestId) { d.requestId = undefined; d.abort = undefined; }
    }
    if (res?.type === 'REQUEST_FAILED') return { kind: 'failed', error: shownMessage(res.error) || NO_ANSWER, ...(committed ? { unknown: true } : {}) };
    if (res?.type !== 'TRANSPORT_PART_RESULT') return { kind: 'failed', error: NO_ANSWER, ...(committed ? { unknown: true } : {}) };
    if (res.cancelled) return { kind: 'stopped' };
    const log = res.log ?? '';
    if (!res.ok) {
      const unknown = committed && (!!res.outcomeUnknown || res.errorKind === 'timeout');
      return { kind: 'failed', error: shownMessage(res.error || log) || 'The server gave no reason.', ...(unknown ? { unknown: true } : {}) };
    }
    if (committed && storedNothing(log)) return { kind: 'failed', error: shownMessage(log) || NO_CHANGES_LINE };
    return { kind: 'ok', log };
  }

  // ── used objects that are not coming along ─────────────────────

  /** The used objects the scripts need and do not carry (lower case →
   *  address as written): after a comparison those the target lacks, in
   *  scripts without comparison every one outside the transport; none
   *  before the answer of a pasted comparison. The same objects as the map's
   *  right column (its missing ones after a comparison). */
  neededAddresses(): Map<string, string> {
    const out = new Map<string, string>();
    const b = this.bundle;
    const u = this.uses();
    if (!b || !u || (b.target && !b.target.answer)) return out;
    for (const o of u.outside) if (!b.target || o.missing) out.set(o.key, o.address);
    return out;
  }

  /** The parents the scripts need and do not carry (lower case → address),
   *  and how many objects are under them: in scripts without comparison the
   *  parents of objects to add that are not in the transport; after a
   *  comparison the parents of objects left out because the target lacks
   *  their parent. */
  neededParents(): { parents: Map<string, string>; objects: number } {
    const parents = new Map<string, string>();
    const under = new Set<string>();
    const b = this.bundle;
    if (!b || b.status !== 'done') return { parents, objects: 0 };
    if (b.result) {
      for (const w of b.result.warnings) {
        if (w.kind !== 'outside-parent' || !w.address) continue;
        parents.set(w.address.toLowerCase(), w.address);
        for (const x of w.by ?? []) under.add(x.toLowerCase());
      }
      return { parents, objects: under.size };
    }
    const p = b.target?.patch;
    if (!p) return { parents, objects: 0 };
    const inside = this.addressRids();
    const inputs = new Map((b.inputs ?? []).map(i => [i.rid, i]));
    for (const o of p.leftOut) {
      if (o.reason !== 'parent-missing') continue;
      const parent = (inputs.get(o.rid)?.parentAddress ?? '').trim();
      if (!parent || /^root\./i.test(parent) || inside.has(addressKey(parent))) continue;
      parents.set(addressKey(parent), parent);
      under.add(o.rid);
    }
    return { parents, objects: under.size };
  }

  /** The steps of flow projects of the transport that the scripts need and
   *  do not carry (lower case → address): in scripts without comparison
   *  every one outside the transport; after a comparison those the target
   *  lacks or has with other values; none before the answer. */
  neededSteps(): Map<string, string> {
    const out = new Map<string, string>();
    const b = this.bundle;
    if (!b || b.status !== 'done') return out;
    const list = b.result?.flowSteps ?? b.target?.patch?.flowSteps ?? [];
    for (const a of list) out.set(addressKey(a), a);
    return out;
  }

  /** The schedules in the transport: they run on the target as they are set. */
  schedules(): number {
    return this.transportItems().filter(i => i.row.className === SCHEDULE_CLASS).length;
  }

  /** The needed used objects (`uses`), parents (`parents`) or steps of flow
   *  projects (`steps`) that can be looked up here (spaces t, k, r, d),
   *  without those looked up in vain. */
  referencedAddresses(which: NeedKind = 'uses'): string[] {
    const out = new Map<string, string>();
    const from = which === 'uses' ? this.neededAddresses() : which === 'steps' ? this.neededSteps() : this.neededParents().parents;
    for (const [k, a] of from) {
      const c = checkAddress(a);
      if (!c.ok || !isStartSpace(c.space) || !START_ID.test(c.id) || this.notFound.has(k) || out.has(k)) continue;
      out.set(k, addressOf(c.space, c.id));
    }
    return [...out.values()];
  }

  /**
   * "Add them": look the needed used objects up on this workspace, one at a
   * time (stoppable), add the ones found to the transport (a
   * numeric ID too: they were asked for), and build again what was built,
   * reading only the new objects (with a connected target: compare again).
   * An address not found stays needed and is said so.
   */
  async addReferenced(which: NeedKind = 'uses'): Promise<void> {
    const b = this.bundle;
    if (!b || b.status !== 'done' || this.busy || this.locked) return;
    const addresses = this.referencedAddresses(which);
    if (!addresses.length) return;
    this.error = null;
    this.notice = null;
    const conn = await this.ensureConnection();
    if (!conn) { this.error = NOT_CONNECTED; this.emit({ kind: 'bundle' }); return; }
    if (this.bundle !== b || this.busy || this.disposed) return;
    const refs: RefsState = { status: 'reading', addresses, done: 0, found: [] };
    this.refs = refs;
    this.emit({ kind: 'bundle' });
    for (const address of addresses) {
      if (refs.status !== 'reading' || this.disposed) break;
      const end = await this.findOne(refs, address, conn);
      if (end === 'stopped' || end === 'fatal') break;
      refs.done++;
      this.emit({ kind: 'bundle' });
    }
    this.refs = null;
    if (this.bundle !== b || this.disposed) return;
    if (!refs.found.length) {
      if (!this.error) this.notice = NONE_FOUND;
      this.emit({ kind: 'bundle' });
      return;
    }
    const now = this.deps.now().toISOString();
    let added = 0;
    for (const row of refs.found) {
      const root = rootOfId(row.parentId);
      const item: CollectionItem = { rid: row.rid, row, ...(root ? { area: root } : {}), trail: root || !row.parentId ? [] : [{ id: row.parentId, name: row.parentName }], readAt: now };
      if (this.collection.add(item)) added++;
    }
    if (!added) { this.notice = 'They are in the transport already.'; this.emit({ kind: 'bundle' }); return; }
    this.collectionChanged();
    const items = this.transportItems();
    const hadAnswer = !!b.target?.answerText.trim();
    this.bundle = { mode: b.mode, status: 'reading', rids: items.map(i => i.rid), items: new Map(items.map(i => [i.rid, i])), reads: b.reads, fileLimitKb: b.fileLimitKb, fileContent: b.fileContent, ...(b.direct ? { direct: b.direct } : {}) };
    if (b.mode === 'target' && hadAnswer && !b.direct) this.notice = PROBE_CHANGED;
    this.emit({ kind: 'bundle' });
    await this.readMissing();
  }

  /**
   * "Add what is missing and compare again": with a connected target, run
   * "Add them" for each kind still needed (uses, parents, steps), each of
   * which compares again. Adding can show more needs (a parent's parent, the
   * uses of an added object), so it repeats while needs remain and the
   * transport grew, at most MISSING_ROUNDS times. A failure, Stop, or nothing
   * added ends it. It only reads here and compares; nothing is written to the
   * target.
   */
  async addMissing(): Promise<void> {
    if (this.busy || this.locked || this.missing || !this.bundle?.target?.direct) return;
    this.missingStopped = false;
    try {
      for (let round = 1; round <= MISSING_ROUNDS; round++) {
        const b = this.bundle;
        if (!b || b.status !== 'done') break;
        const kinds = NEED_KINDS.filter(k => this.referencedAddresses(k).length);
        if (!kinds.length) break;
        this.missing = { round, of: MISSING_ROUNDS };
        const before = this.transportItems().length;
        for (const kind of kinds) {
          await this.addReferenced(kind);
          if (this.missingStopped || this.error || this.disposed || this.bundle?.status !== 'done') break;
        }
        if (this.missingStopped || this.error || this.disposed || this.transportItems().length <= before) break;
      }
    } finally {
      this.missing = null;
      this.emit({ kind: 'bundle' });
    }
  }

  /** Look up one address for addReferenced. */
  private async findOne(refs: RefsState, address: string, conn: TransportConnection): Promise<'next' | 'stopped' | 'fatal'> {
    const requestId = this.nextId();
    refs.requestId = requestId;
    refs.abort = new AbortController();
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request({ type: 'TRANSPORT_FIND', requestId, environment: conn.environment, address }, SCAN_WAIT_MS, refs.abort.signal);
    } catch (e) {
      if (refs.status !== 'reading' || this.disposed) return 'stopped';
      this.error = requestFailureLine(e);
      return 'fatal';
    }
    if (refs.status !== 'reading' || this.disposed) return 'stopped';
    if (res?.type === 'REQUEST_FAILED' || res?.type !== 'TRANSPORT_FIND_RESULT') {
      this.error = res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER;
      return 'fatal';
    }
    const r = res as Msg<'TRANSPORT_FIND_RESULT'>;
    if (r.cancelled) return 'stopped';
    if (!r.ok) {
      // A failure of this address only leaves it needed.
      if (isLocalFailure(r)) return 'next';
      this.error = r.error || 'The object could not be looked up.';
      return 'fatal';
    }
    if (r.row) { refs.found.push(r.row); this.looked.set(address.toLowerCase(), r.row); }
    else this.notFound.add(address.toLowerCase());
    return 'next';
  }

  /** Stop looking up used objects; those found so far are added. */
  stopRefs(): void {
    const refs = this.refs;
    if (!refs || refs.status !== 'reading') return;
    refs.status = 'stopped';
    this.missingStopped = true;
    if (refs.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: refs.requestId });
    refs.abort?.abort();
    this.emit({ kind: 'bundle' });
  }

  // ── used by, linked copies ──────────────────────────────────────

  /** "Find what uses this": one read of what uses one object, at most
   *  TRANSPORT_USED_BY_CAP, stoppable. Never run by itself. */
  async readUsedBy(rid: string): Promise<void> {
    if (this.busy || !this.collection.has(rid)) return;
    const conn = await this.ensureConnection();
    if (!conn) { this.usedBy.set(rid, { status: 'failed', users: [], more: false, error: NOT_CONNECTED }); this.emit({ kind: 'usedby', rid }); return; }
    const st: UsedByState = { status: 'reading', users: [], more: false, requestId: this.nextId(), abort: new AbortController() };
    this.usedBy.set(rid, st);
    this.emit({ kind: 'usedby', rid });
    const end = (patch: Partial<UsedByState>) => {
      Object.assign(st, { requestId: undefined, abort: undefined }, patch);
      this.emit({ kind: 'usedby', rid });
    };
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request({ type: 'TRANSPORT_USED_BY', requestId: st.requestId!, environment: conn.environment, rid }, SCAN_WAIT_MS, st.abort!.signal);
    } catch (e) {
      if (st.status !== 'reading' || this.disposed) return;
      end({ status: 'failed', error: requestFailureLine(e) });
      return;
    }
    if (st.status !== 'reading' || this.disposed) return;
    if (res?.type !== 'TRANSPORT_USED_BY_RESULT') { end({ status: 'failed', error: res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER }); return; }
    if (res.cancelled) { end({ status: 'stopped' }); return; }
    if (!res.ok) { end({ status: 'failed', error: res.error || 'What uses it could not be read.' }); return; }
    end({ status: 'done', users: res.users ?? [], more: !!res.more });
  }

  stopUsedBy(rid: string): void {
    const st = this.usedBy.get(rid);
    if (!st || st.status !== 'reading') return;
    st.status = 'stopped';
    if (st.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: st.requestId });
    st.abort?.abort();
    this.emit({ kind: 'usedby', rid });
  }

  /** Compatibility: back to Find. Not while an apply runs. */
  backToList(): void {
    if (this.bundle?.target?.direct?.phase.kind === 'applying') return;
    this.showTab('find');
  }

  // ── the transport log ───────────────────────────────────────────

  /** Show the transport log and read it. */
  async openLog(): Promise<void> {
    if (this.busy) return;
    this.logOpen = true;
    this.emit({ kind: 'view' });
    await this.readLog();
  }

  /** Read the transport log of the window's workspace (Refresh). */
  async readLog(): Promise<void> {
    if (this.busy || !this.logOpen) return;
    const prev = this.log;
    const log: LogState = { status: 'reading', entries: prev?.entries ?? [], more: prev?.more ?? false, missingLog: prev?.missingLog ?? false, read: prev?.read ?? false };
    this.log = log;
    this.emit({ kind: 'log' });
    const conn = await this.ensureConnection();
    if (this.log !== log || log.status !== 'reading') return;
    if (!conn) { this.logDone(log, { status: 'failed', error: NOT_CONNECTED }); return; }
    const requestId = this.nextId();
    log.requestId = requestId;
    log.abort = new AbortController();
    let res: InspectorMessage | undefined;
    try {
      res = await this.deps.request({ type: 'TRANSPORT_LOG', requestId, environment: conn.environment }, SCAN_WAIT_MS, log.abort.signal);
    } catch (e) {
      if (this.log !== log || log.status !== 'reading' || this.disposed) return;
      this.logDone(log, { status: 'failed', error: requestFailureLine(e) });
      return;
    }
    if (this.log !== log || log.status !== 'reading' || this.disposed) return;
    if (res?.type === 'REQUEST_FAILED' || res?.type !== 'TRANSPORT_LOG_RESULT') {
      this.logDone(log, { status: 'failed', error: res?.type === 'REQUEST_FAILED' ? res.error : NO_ANSWER });
      return;
    }
    const r = res as Msg<'TRANSPORT_LOG_RESULT'>;
    if (r.cancelled) { this.logDone(log, { status: 'stopped' }); return; }
    if (!r.ok) { this.logDone(log, { status: 'failed', error: r.error || 'The transport log could not be read.' }); return; }
    this.logDone(log, { status: 'done', read: true, entries: r.entries ?? [], more: !!r.more, missingLog: !!r.missingLog });
  }

  private logDone(log: LogState, patch: Partial<LogState>): void {
    Object.assign(log, { requestId: undefined, abort: undefined, error: undefined }, patch);
    this.emit({ kind: 'log' });
    this.emit({ kind: 'scan' });
  }

  /** Stop reading the log; what was shown before stays. */
  stopLog(): void {
    const log = this.log;
    if (!log || log.status !== 'reading') return;
    if (log.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: log.requestId });
    log.abort?.abort();
    this.logDone(log, { status: 'stopped' });
  }

  /** Back from the log to the tab it was opened over. */
  closeLog(): void {
    if (!this.logOpen) return;
    this.stopLog();
    this.logOpen = false;
    this.emit({ kind: 'view' });
  }

  /** The window closes: cancel what runs. A committed part that runs is
   *  finished by the worker; nothing after it runs. */
  dispose(): void {
    const d = this.bundle?.target?.direct;
    if (d) {
      d.stopping = true;
      if (d.requestId) this.deps.post({ type: 'TRANSPORT_CANCEL', requestId: d.requestId });
    }
    this.clearBoxTimer();
    for (const h of this.browseHolders.values()) this.stopHolder(h);
    for (const h of this.countHolders) this.stopHolder(h);
    if (this.taking) this.stopHolder(this.taking.holder);
    this.stopRefs();
    this.stopScan();
    this.stopReading();
    this.stopLog();
    this.stopRefresh();
    this.stopFacts();
    for (const rid of this.usedBy.keys()) this.stopUsedBy(rid);
    this.disposed = true;
  }
}
