/**
 * Transport (beta), undo of the last apply to a connected target. Pure: no
 * chrome.*, no DOM, no I/O.
 *
 * At Apply, before the first write, an UndoRecord keeps what is needed to
 * bring the target back as it was before, from the comparison that was
 * confirmed: the whole text of each object to change, the place of each
 * object to move, the old ID of each ID change, the objects to add (in Add
 * order), the class links and links between steps to add or remove, the own
 * values per class as they were. Deletes and removed class links cannot be
 * undone: they are only listed. After the apply's own comparison the record
 * gets, per changed object, the size and date the target then has, and per
 * added object when it was added (`str(createdTime)`).
 *
 * Measured on 5.6.17: `t.x.clear(description)` removes a value;
 * `change(description := MISSING)` does not; a `change(…)` with fewer values
 * leaves the others as they are. `_d := t.x.descendants().first(1)` then
 * `_d.size() = 0` tells an object with nothing under it. `str(t.x.createdTime)`
 * prints with seconds and two reads compare equal as text.
 */

import { ecString } from './ec-guards';
import {
  addressKey, addressOf, argumentPairs, BUNDLE_PART_LIMIT, classInstances, comparableText, ecSingleQuoted, exactTextEc, flowLinkStatement,
  instanceChangeStatement, parseFlowText, parseObjectText, renderParts, rootAddressOf, splitAddress, splitArguments, stripLikeServer, withoutNeverCarried,
  type BundleInput, type BundledObject, type IdentityGuard, type PartFrame, type PartUnit, type StepInput, type StepSpec,
} from './transport-bundle';
import {
  flowUnlinkStatement, moveStatement, PATCH_STEP_ORDER, PATCH_STEPS, renameStatement, UNDO_READY_LINE, unlinkStatement,
  type PatchPart, type PatchReviewObject, type PatchStep, type ProbeAnswer, type TransportPatch,
} from './transport-patch';

/** What each undo part does (its script's comment). */
const UNDO_STEPS: Partial<Record<PatchStep, StepSpec>> = {
  check: { ...PATCH_STEPS.check, does: 'Confirms that the target is still as the apply left it: the texts, places and IDs it wrote.' },
  rename: { ...PATCH_STEPS.rename, does: 'Changes the IDs the apply changed back to what they were.', again: 'it changes only objects that still have the new ID' },
  set: { ...PATCH_STEPS.set, does: 'Changes the values back to what they were before the apply, and clears the values the apply added.' },
  link: { ...PATCH_STEPS.link, does: 'Removes the class links and the links between steps the apply added, and links again the steps whose link it removed.', again: 'it removes only links that are there' },
  own: { ...PATCH_STEPS.own, does: 'Changes the own values per class back to what they were before the apply.' },
  order: { ...PATCH_STEPS.order, does: 'Moves the objects the apply moved back to their parent and their place.' },
  delete: { ...PATCH_STEPS.delete, does: 'Deletes the objects the apply added, children first: only an object that still has its class, was added by that apply and has nothing under it. Any other stays and a line says so.', again: 'it deletes only what is still there' },
};

const INDENT = '     ';
const key = addressKey;

/** One value: `name := value`. */
type Value = { name: string; value: string };

export interface UndoRecord {
  v: 1;
  /** The workspace the apply came from, and the target (environments). */
  source: string;
  target: string;
  targetLabel: string;
  /** When the apply started (ISO). */
  at: string;
  /** The apply stopped or failed: after this many of its parts. */
  stoppedAfter?: { part: number; total: number };
  changed: Array<{ rid: string; address: string; className: string; before: string; written: string; after?: { size: number; date: string } }>;
  moved: Array<{ rid: string; address: string; className: string; parentId: string; previousId: string; nextId: string; afterParentId: string }>;
  renamed: Array<{ rid: string; from: string; to: string; className: string }>;
  /** In Add order (parents before children). `created`: when it was added;
   *  empty when the target does not have it (the apply stopped before it). */
  added: Array<{ rid: string; address: string; className: string; created?: string }>;
  /** Property definitions and the classes the apply linked them to. */
  classLinks: Array<{ rid: string; address: string; className: string }>;
  /** Links between steps the apply added or removed. */
  stepLinks: Array<{ rid: string; project: string; pair: string; from: string; to: string; removed?: true }>;
  /** Own values per class as they were, and as the apply wrote them. */
  own: Array<{ rid: string; address: string; className: string; before: Value[]; written: Value[] }>;
  /** What cannot be undone: deleted objects, removed class links. */
  cannot: Array<{ address: string; className: string; what: 'deleted' | 'unlinked' }>;
}

/** Values of a text, without NEVER_CARRIED; null for another form. */
const valuesOf = (text: string): Value[] | null => {
  const l = parseObjectText(text);
  return l ? argumentPairs(splitArguments(withoutNeverCarried(l.args))) : null;
};

/**
 * The record of an apply, from the confirmed comparison: `patch` built from
 * `answer` for `inputs` (the source's objects).
 */
export function buildUndoRecord(patch: TransportPatch, answer: ProbeAnswer, inputs: readonly BundleInput[], meta: { source: string; target: string; targetLabel: string; at: string }): UndoRecord {
  const states = new Map(Object.entries(answer.states).map(([a, s]) => [key(a), s]));
  const byRid = new Map(inputs.map(i => [i.rid, i]));
  const r: UndoRecord = { v: 1, ...meta, changed: [], moved: [], renamed: [], added: [], classLinks: [], stepLinks: [], own: [], cannot: [] };
  const added: Array<{ rid: string; address: string; className: string; parent: string }> = [];
  for (const x of patch.review) {
    const input = byRid.get(x.rid);
    const s = states.get(key(x.address));
    if (x.outcome === 'create') { added.push({ rid: x.rid, address: x.address, className: x.className, parent: input?.parentAddress ?? '' }); continue; }
    if (x.renamedFrom) { r.renamed.push({ rid: x.rid, from: x.renamedFrom, to: x.address, className: x.className }); continue; }
    if (s?.state !== 'present' || !input?.genedit) continue;
    const before = stripLikeServer(s.genedit ?? ''), written = stripLikeServer(input.genedit);
    if (before && comparableText(before) !== comparableText(written)) r.changed.push({ rid: x.rid, address: x.address, className: x.className, before, written });
    if (x.place) r.moved.push({ rid: x.rid, address: x.address, className: x.className, parentId: s.parentId ?? '', previousId: s.previousId ?? '', nextId: s.nextId ?? '', afterParentId: input.parentId ?? '' });
    for (const c of x.links?.add ?? []) r.classLinks.push({ rid: x.rid, address: x.address, className: c });
    // Links between steps: those added are removed, those removed are added back.
    const flow = parseFlowText(input.genedit);
    const space = splitAddress(x.address)?.space ?? 't';
    for (const pair of x.flowLinks?.add ?? []) {
      const l = flow?.links.find(k => pairOf(k.from, k.to) === pair);
      if (l) r.stepLinks.push({ rid: x.rid, project: x.address, pair, from: l.from, to: l.to });
    }
    if (!x.flowLinks?.unknown) {
      for (const pair of x.flowLinks?.targetOnly ?? []) {
        const [a, b] = pair.split('>');
        r.stepLinks.push({ rid: x.rid, project: x.address, pair, from: addressOf(space, a), to: addressOf(space, b), removed: true });
      }
    }
    // Own values per class as they were.
    if (x.own?.length) {
      const id = splitAddress(x.address)?.id ?? '';
      const there = classInstances(s.instancesText ?? '', id);
      const here = classInstances(input.instances ?? '', id);
      for (const o of x.own) {
        r.own.push({
          rid: x.rid, address: x.address, className: o.className,
          before: there.find(c => c.className.toLowerCase() === o.className.toLowerCase())?.values ?? [],
          written: here.find(c => c.className.toLowerCase() === o.className.toLowerCase())?.values ?? [],
        });
      }
    }
  }
  // Add order: parents before children.
  const depth = (a: { parent: string }, seen = new Set<string>()): number => {
    const p = added.find(o => key(o.address) === key(a.parent));
    if (!p || seen.has(key(p.address))) return 0;
    seen.add(key(p.address));
    return 1 + depth(p, seen);
  };
  r.added = added.map(a => ({ a, d: depth(a) })).sort((x, y) => x.d - y.d).map(({ a }) => ({ rid: a.rid, address: a.address, className: a.className }));
  for (const d of patch.deletes) r.cannot.push({ address: d.address, className: d.className, what: 'deleted' });
  for (const u of patch.unlinks) r.cannot.push({ address: u.address, className: u.className, what: 'unlinked' });
  return r;
}

/** The pair of a link as the comparison writes it. */
const pairOf = (from: string, to: string) => `${splitAddress(from)?.id ?? ''}>${splitAddress(to)?.id ?? ''}`;

/** The record with what the comparison after the apply read: per changed
 *  object its size and date; per added object when it was added
 *  (createdTimesText, by lower-case address). */
export function finishUndoRecord(r: UndoRecord, answer: ProbeAnswer, created: ReadonlyMap<string, string> = new Map()): UndoRecord {
  const states = new Map(Object.entries(answer.states).map(([a, s]) => [key(a), s]));
  return {
    ...r,
    changed: r.changed.map(c => {
      const s = states.get(key(c.address));
      return s?.state === 'present' && s.genedit != null ? { ...c, after: { size: s.genedit.length, date: s.modified ?? '' } } : c;
    }),
    added: r.added.map(a => {
      const c = created.get(key(a.address));
      return c !== undefined ? { ...a, created: c } : a;
    }),
  };
}

/** The line of an object an undo keeps. */
export const KEPT_LINE = 'kept: it was changed or has objects under it';

/** What the undo of a record does, in counts. */
export const undoCounts = (r: UndoRecord) => ({ added: r.added.length, changed: r.changed.length, moved: r.moved.length });

/** Read a stored record; null for anything else. */
export function readUndoRecord(value: unknown, source: string, target: string): UndoRecord | null {
  const r = value as UndoRecord | null;
  if (!r || typeof r !== 'object' || r.v !== 1 || r.source !== source || r.target !== target || typeof r.at !== 'string') return null;
  for (const k of ['changed', 'moved', 'renamed', 'added', 'classLinks', 'stepLinks', 'own', 'cannot'] as const) if (!Array.isArray(r[k])) return null;
  return r;
}

/** The key of the record of a source and target, in the draft's family. */
export const undoKey = (source: string, target: string): string => `crev_transport_undo:${source}|${target}`;

/** The deviation lines of the undo's Check. */
const deviation = (text: string) => [`_r := _r + ${ecString(text)}`, '_dv := _dv + "."'];

/** The undo's Check part: Ready, or Stop with "changed since the apply". */
function undoCheckFrame(objects: number): PartFrame {
  return {
    before: [`_r := ${ecString(`Undo check (${objects} check${objects === 1 ? '' : 's'} in this part)`)}`, '_ok := ""', '_dv := ""'],
    after: [
      'IF _dv.size() = 0 THEN',
      `${INDENT}_r := _r + ${ecString(`\n${UNDO_READY_LINE}`)}`,
      'ELSE',
      `${INDENT}_r := _r + ${ecString('\nStop: the target changed since the apply. Do not run the next parts.')}`,
      'ENDIF',
      '_r',
    ],
  };
}

/** The frame of the undo's Delete part: the objects it keeps, printed. */
const keptFrame = (): PartFrame => ({ before: ['_r := ""'], after: ['_r'] });

/**
 * The Check of a changed object: the size and date the apply left (from its
 * comparison), or, without them (the apply stopped before it), its text as
 * the apply wrote it or as it was before.
 */
function changedCheck(c: UndoRecord['changed'][number]): string {
  const a = c.address, i1 = INDENT, i2 = INDENT.repeat(2);
  const lines = [`IF ${a} = MISSING THEN`, ...deviation(`\nMISSING now ${a}`).map(l => i1 + l), 'ELSE'];
  if (c.after) {
    lines.push(
      `${i1}_g := str(${a}.genedit())`,
      `${i1}_d := str(${a}.lastModifiedDate.whenMissing(""))`,
      `${i1}IF _g.size() = ${c.after.size} AND _d = ${ecString(c.after.date)} THEN`,
      `${i2}_ok := _ok + "."`,
      `${i1}ELSE`,
      ...deviation(`\nCHANGED since the apply ${a}`).map(l => i2 + l),
      `${i1}ENDIF`,
    );
  } else {
    lines.push(...exactTextEc(a, c.written, ['_ok := _ok + "."'], exactTextEc(a, c.before, ['_ok := _ok + "."'], deviation(`\nCHANGED since the apply ${a}`), ''), INDENT));
  }
  lines.push('ENDIF');
  return lines.join('\n');
}

/** The Check of a moved object: under the parent the apply moved it to. */
const movedCheck = (m: UndoRecord['moved'][number]) => [
  `IF ${m.address} != MISSING AND str(${m.address}.parent.id) = ${ecString(m.afterParentId)} THEN`,
  `${INDENT}_ok := _ok + "."`,
  'ELSE',
  ...deviation(`\nMOVED since the apply ${m.address}`).map(l => INDENT + l),
  'ENDIF',
].join('\n');

/** The Check of an ID change: the object has the new ID. */
const renamedCheck = (n: UndoRecord['renamed'][number]) => [
  `IF ${n.to} != MISSING THEN`,
  `${INDENT}_ok := _ok + "."`,
  'ELSE',
  ...deviation(`\nMISSING now ${n.to}`).map(l => INDENT + l),
  'ENDIF',
].join('\n');

/** The values to write back and the values to clear (the apply added them). */
function restore(before: readonly Value[], written: readonly Value[]): { set: string; clear: string[] } {
  const had = new Set(before.map(v => v.name.toLowerCase()));
  return {
    set: before.map(v => `${v.name} := ${v.value}`).join(', '),
    clear: [...new Set(written.filter(v => !had.has(v.name.toLowerCase()) && v.name.toLowerCase() !== 'id').map(v => v.name))],
  };
}

/** The guarded delete of an object the apply added: it exists, has the
 *  class, was added when the apply's comparison read, and has nothing under
 *  it; else it stays and a line says so. */
function addedDelete(a: UndoRecord['added'][number] & { created: string }): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  const kept = `${i2}_r := _r + ${ecString(`\n${a.address} ${KEPT_LINE}`)}`;
  return [
    `IF ${a.address} != MISSING AND ${a.address}.className = ${ecSingleQuoted(a.className)} AND str(${a.address}.createdTime.whenMissing("")) = ${ecString(a.created)} THEN`,
    `${i1}_d := ${a.address}.descendants().first(1)`,
    `${i1}IF _d.size() = 0 THEN`,
    `${i2}${a.address}.delete()`,
    `${i1}ELSE`,
    kept,
    `${i1}ENDIF`,
    'ELSE',
    `${i1}IF ${a.address} != MISSING THEN`,
    kept,
    `${i1}ELSE ""`,
    `${i1}ENDIF`,
    'ENDIF',
  ].join('\n');
}

/** The address of a parent by its ID, in the object's own space (a root
 *  by its name). */
const parentAddress = (address: string, id: string) => rootAddressOf(id) || addressOf(splitAddress(address)?.space ?? 't', id);

export interface UndoPlan {
  patch: TransportPatch;
  /** Added objects that stay: when they were added was not read. */
  kept: Array<{ address: string; reason: string }>;
  cannot: Array<{ address: string; reason: string }>;
}

/** Why an added object without its creation time stays. */
export const NO_CREATED_TIME = 'kept: when it was added was not read';

/**
 * The scripts that undo `r`, as a TransportPatch the window shows like a
 * comparison's: a Check (preview), then committed parts: ID changes back,
 * values back (change plus clear of the values the apply added), class
 * links and links between steps back, own values per class back, objects
 * moved back, and the added objects deleted, children before parents, each
 * guarded (addedDelete).
 */
export function buildUndoPlan(r: UndoRecord, opts: { partLimit?: number } = {}): UndoPlan {
  const limit = opts.partLimit ?? BUNDLE_PART_LIMIT;
  const guard = (address: string, className: string): IdentityGuard => ({ address, className });
  const unit = (text: string, g: IdentityGuard | null): PartUnit => ({ text, objects: 1, guards: g ? [g] : [] });
  const check: PartUnit[] = [
    ...r.changed.map(c => unit(changedCheck(c), null)),
    ...r.moved.map(m => unit(movedCheck(m), null)),
    ...r.renamed.map(n => unit(renamedCheck(n), null)),
  ];
  const rename = r.renamed.map(n => unit(renameStatement({ from: n.to, to: n.from, className: n.className }), guard(n.to, n.className)));
  const set = r.changed.flatMap(c => {
    const before = valuesOf(c.before), written = valuesOf(c.written);
    if (!before || !written) return [];
    const x = restore(before, written);
    return [unit([...(x.set ? [`${c.address}.change(${x.set})`] : []), ...x.clear.map(n => `${c.address}.clear(${n})`)].join('\n'), guard(c.address, c.className))];
  });
  const link = [
    ...r.classLinks.map(l => unit(unlinkStatement(l.address, l.className), null)),
    ...r.stepLinks.map(l => unit(l.removed ? flowLinkStatement(l.project, { from: l.from, to: l.to }) : flowUnlinkStatement(l.project, l.pair), null)),
  ];
  const own = r.own.map(o => {
    const x = restore(o.before, o.written);
    return unit(instanceChangeStatement(o.address, o.className, x.set, x.clear), null);
  });
  const order = r.moved.flatMap(m => {
    const parent = parentAddress(m.address, m.parentId);
    const space = splitAddress(m.address)?.space ?? 't';
    const prev = m.previousId ? addressOf(space, m.previousId) : '', next = m.nextId ? addressOf(space, m.nextId) : '';
    const anchor = prev ? `IF ${m.address} != MISSING AND ${prev} != MISSING THEN ${m.address}.moveAfter(${prev}) ELSE "" ENDIF`
      : next ? `IF ${m.address} != MISSING AND ${next} != MISSING THEN ${m.address}.moveBefore(${next}) ELSE "" ENDIF` : '';
    return [unit([...(parent ? [moveStatement(m.address, parent)] : []), ...(anchor ? [anchor] : [])].join('\n'), guard(m.address, m.className))];
  }).filter(u => u.text);
  const kept: UndoPlan['kept'] = [];
  const deletes: PartUnit[] = [];
  for (const a of [...r.added].reverse()) {
    if (a.created === '') continue; // not on the target: nothing to delete
    if (!a.created) { kept.push({ address: a.address, reason: NO_CREATED_TIME }); continue; }
    deletes.push(unit(addedDelete({ ...a, created: a.created }), null));
  }
  const units: Partial<Record<PatchStep, PartUnit[]>> = { check, rename, set, link, own, order, delete: deletes };
  const frames: Partial<Record<PatchStep, StepInput<PatchStep>['frame']>> = { check: undoCheckFrame, delete: keptFrame };
  const steps = PATCH_STEP_ORDER.filter(s => units[s]?.length).map(step => ({ step, spec: UNDO_STEPS[step] ?? PATCH_STEPS[step], units: units[step]!, frame: frames[step] }));
  const rendered = renderParts<PatchStep>('Undo scripts', steps, limit);
  const parts = rendered.parts as PatchPart[];
  const cannot = r.cannot.map(c => ({ address: c.address, reason: c.what === 'deleted' ? `${c.address} (${c.className}) was deleted: it cannot be undone.` : `The link of ${c.address} to ${c.className} was removed: it cannot be undone.` }));
  // The list's states: what each object gets.
  const review: PatchReviewObject[] = [
    ...r.changed.map(c => ({ rid: c.rid, address: c.address, className: c.className, isNew: false, outcome: 'change' as const, values: [] })),
    ...r.renamed.filter(n => !r.changed.some(c => c.rid === n.rid)).map(n => ({ rid: n.rid, address: n.from, className: n.className, isNew: false, outcome: 'change' as const, values: [], renamedFrom: n.to })),
    ...r.moved.filter(m => !r.changed.some(c => c.rid === m.rid)).map(m => ({ rid: m.rid, address: m.address, className: m.className, isNew: false, outcome: 'move' as const, values: [], place: { labels: [`moved back under ${m.parentId}`] } })),
  ];
  const objects: BundledObject[] = review.map(x => ({ rid: x.rid, address: x.address, className: x.className, isNew: false }));
  const n = deletes.length;
  const counts = { create: 0, change: review.filter(x => x.outcome === 'change').length, move: review.filter(x => x.outcome === 'move').length, same: 0, rename: r.renamed.length, delete: n, targetOnly: 0, leftOut: 0 };
  const nothingToDo = !rename.length && !set.length && !link.length && !own.length && !order.length && !deletes.length;
  const preamble = [
    `// Undo scripts (beta): back to how ${r.targetLabel} was before the apply of ${r.at.slice(0, 16).replace('T', ' ')} (UTC). ${parts.length} part${parts.length === 1 ? '' : 's'}.`,
    '// Run part 1 with Preview first; when it says Ready, run the next parts in order with Execute.',
    ...cannot.map(c => `// Cannot be undone: ${c.reason}`),
    ...kept.map(k => `// ${k.address} ${k.reason}`),
  ].join('\n') + '\n';
  const patch: TransportPatch = {
    parts, objects, leftOut: [], warnings: rendered.warnings, notes: [], preamble, text: [preamble, ...parts.map(p => p.text)].join('\n'),
    review, counts, key: '', nothingToDo, renames: [], uploads: [], targetOnly: [], deletes: [], flowSteps: [], unlinks: [], linksOnlyOnTarget: 0, typesOff: [],
  };
  return { patch, kept, cannot };
}

/** The lines of a committed Delete part that kept objects. */
export const keptLines = (log: string): string[] => log.split(/\r\n?|\n/).map(l => l.trim()).filter(l => l.endsWith(KEPT_LINE));
