/**
 * Transport (beta), the patch: a probe the receiver runs on the target as a
 * preview, the parse of the answer pasted back, and a patch computed against
 * what the target holds. Pure: no chrome.*, no DOM, no I/O. The plain bundle,
 * the shared building blocks and the reading of generated text are in
 * transport-bundle.ts.
 *
 * Measured on BMP 5.6.17 and 5.6.10:
 *  - A probe of this form ran in a preview and printed one line per address:
 *    `IF t.a = MISSING THEN … ELSE _g := str(t.a.genedit()) … ENDIF` with
 *    `str(t.a.className)` and `str(_g.size())`. The genedit text as BMP
 *    returns it starts and ends with a line break; `_g.size()` counts them.
 *  - `x.clear(prop)` unsets a text, list item and reference value.
 *    `x.change(prop := MISSING)` silently does nothing; `x.change(text :=
 *    '')` fails for numbers. So a value only the target has is cleared with
 *    `clear`.
 *  - In a committed run an object added earlier in that run may not resolve
 *    by address later in it, so the transport log folder is held in a
 *    variable. `root.portal.add(Category, id := …, name := …)` and, inside
 *    it, `.add(Category, …, description := '<6,000 characters>')` worked;
 *    `description`, `createdTime` and `children` read back.
 *  - A property definition's links to classes are only in its
 *    `generate(true)` text (`c.get(<Class>.name).link(_v)` lines, in no
 *    fixed order). `c.get(<Class>.name).link(k.<ID>)` links one the target
 *    has; linking the same class twice fails the run ("Duplicate Object
 *    ID"). In a preview, a linked class's ClassConfig has a child with the ID
 *    `<its ID>.<property ID>` (`children.filter(id = …)`); one not linked has
 *    none.
 */

import { EC_CHUNK } from './ec-parser';
import { ecString } from './ec-guards';
import {
  addressKey, argumentPairs, BUNDLE_PART_LIMIT, checkAddress, createSetsValues, createStatement, creationErrorDetail, ecSingleQuoted, exactTextEc, guardOf, idOfAddress, leftOutAndWarningLines,
  parseGenedit as parseLine,
  noOrderWarning, oneLine, orderAnchors, orderForAdd, orderParentsFirst, orderStatements,
  argumentReferences, outsideReferences, plainAddress, prepareTransportInputs, referrersText, refersToAny, refersToLaterAdded, renderParts, reportFrame,
  reportStatement, rootAddressOf, sortLeftOut, splitArguments, stripLikeServer, TRANSPORT_SCAN_TOTAL, unitParts, valueStatement,
  comparableText, FILE_VALUES, isShort, uploadComment, uploadLines, uploadOf, uploadText, withoutNeverCarried, type UploadFile,
  classLinkLine, isPropertyDefinition, linkedClasses, NO_PARENT_DETAIL, SYSTEM_OBJECT_DETAIL,
  addressOf, splitAddress, isLoopId, isPlainId, shownAddressEc, classInstances, flowLinkStatement, flowLinksEc, flowPair, flowPairsOf, instanceChangeStatement, instancesEc, neverMoved, OWN_STEP, parseObjectText, sizedTexts,
  type ClassInstance, type FlowLink,
  type BundledObject, type BundleInput, type BundlePart, type BundleWarning, type GeneditLine, type IdentityGuard, type LeftOutObject,
  type PartFrame, type PartUnit, type PreparedObject, type SiblingAvailable, type StepInput, type StepSpec,
} from './transport-bundle';

const INDENT = '     ';
const key = addressKey;

/** `root.<name>` receivers are roots: always there, never probed. */
const isRootAddress = (address: string) => /^root\./i.test(address);

/** FNV-1a over UTF-16 code units, as 8 hex digits. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── the probe ───────────────────────────────────────────────────────

/** The probe's answer format; a pasted answer of another version is refused.
 *  2: places (parent, previous and next sibling) and parents of existing
 *  addresses. 3: the listing of what the target has under one object.
 *  4: the answer marker `#cc-compare`. 5: what the target has, without
 *  description text. 6: the `L` line of a property definition. 7: the `I`,
 *  `F` and `T` lines. 8: addresses framed with their size, the places in
 *  `P` lines of one loop per part, the date an object last changed. 9: the
 *  types switched off on the target (`Y`). */
export const PROBE_VERSION = 9;

/** Objects the listing of a target returns at most; one more says "more". */
export const LISTING_CAP = TRANSPORT_SCAN_TOTAL;

/** Starts the first and the last line of every probe part's answer. */
export const PROBE_MARKER = '#cc-compare';

/** What the probe asks about an address: the object with class and whole
 *  generated text, only whether something exists there (and its class), or
 *  a step of a flow project of the transport that is not in it (its class
 *  and text, `T` line). */
export type ProbeEntryKind = 'object' | 'exists' | 'step';

export interface ProbeEntry {
  address: string;
  kind: ProbeEntryKind;
  /** A file whose content is not carried: its text is read without the
   *  content (FILE_VALUES). */
  short?: true;
  /** A property definition: its `generate(true)` text is read too, for
   *  the classes it is linked to, and the texts of its instances. */
  links?: true;
  /** A flow project: the links between its steps are read too. */
  flow?: true;
}

/** What parseProbeAnswer checks an answer against (a TransportProbe is one). */
export interface ProbeExpectation {
  /** Derived from the probed addresses; printed in every part's answer. */
  key: string;
  /** Parts of the probe. */
  total: number;
  entries: readonly ProbeEntry[];
  /** The address whose descendants the probe lists (ProbeOptions.listing). */
  listing?: string;
}

export type ProbePart = BundlePart<'probe' | 'listing'>;

export interface TransportProbe extends ProbeExpectation {
  parts: ProbePart[];
  /** The bundle objects first (by address), then the other addresses. */
  entries: Array<ProbeEntry & { part: number }>;
  /** Objects not probed (the bundle's reasons). */
  leftOut: LeftOutObject[];
  warnings: BundleWarning[];
  /** Comment lines above the parts in the whole text. */
  preamble: string;
  /** The preamble and every part. */
  text: string;
}

export interface ProbeOptions {
  /** Characters per part (default BUNDLE_PART_LIMIT). */
  partLimit?: number;
  /** List everything the target has under this object (`<space>.<ID>`, an
   *  ID of letters, digits and underscore), in a part of its own. */
  listing?: { start: string };
}

/** The inputs read and checked, and the addresses a probe asks about. */
interface ProbePlan {
  prepared: PreparedObject[];
  leftOut: LeftOutObject[];
  warnings: BundleWarning[];
  entries: ProbeEntry[];
  key: string;
}

/** The addresses a patch needs besides its objects: each object's parent
 *  and its previous and next sibling. Roots are left out. */
function neededAddresses(p: PreparedObject): string[] {
  return [p.parent, p.previous, p.next].map(a => plainAddress(a)).filter(a => a && !isRootAddress(a));
}

/** The address and arguments of an object, as outsideReferences reads them. */
const refSource = (p: PreparedObject) => ({ address: p.address, args: p.line.args });

/** The probe of the inputs. Creation text plays no part: in a patch it is
 *  read after the answer, for the objects the target lacks only, and the
 *  probe (and its key) must not change with it. */
function probePlan(inputs: readonly BundleInput[], listing?: string): ProbePlan {
  const { prepared, leftOut, warnings } = prepareTransportInputs(inputs.map(withoutCreation), false);
  const objects = new Set(prepared.map(p => key(p.address)));
  const others = new Map<string, string>();
  const want = (a: string) => { if (!objects.has(key(a)) && !others.has(key(a))) others.set(key(a), a); };
  for (const p of prepared) for (const a of neededAddresses(p)) want(a);
  // The addresses the objects' values refer to: whether they exist.
  for (const r of outsideReferences(prepared.map(refSource))) want(r.address);
  // The steps of flow projects that are not in the transport: their text.
  const steps = new Map<string, string>();
  for (const a of stepsOutside(prepared)) { steps.set(key(a), a); others.delete(key(a)); }
  const entries: ProbeEntry[] = [
    ...prepared.map(p => ({
      address: p.address, kind: 'object' as const, ...(isShort(p) ? { short: true as const } : {}),
      ...(isPropertyDefinition(p.className, p.address) && !p.input.linkedTo ? { links: true as const } : {}),
      ...(p.flow ? { flow: true as const } : {}),
    })),
    ...[...others.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, address]) => ({ address, kind: 'exists' as const })),
    ...[...steps.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, address]) => ({ address, kind: 'step' as const })),
  ];
  const letter = (e: ProbeEntry) => (e.kind === 'exists' ? 'E' : e.kind === 'step' ? 'T' : e.short ? 'S' : e.links ? 'P' : e.flow ? 'F' : 'O');
  const k = fnv1a([...entries.map(e => `${letter(e)} ${key(e.address)}`), ...(listing ? [`L ${key(listing)}`] : [])].join('\n'));
  return { prepared, leftOut, warnings, entries, key: k };
}

/** The addresses of the steps of the flow projects among `prepared` that
 *  are not themselves among them (`t.<ID>`). */
function stepsOutside(prepared: readonly PreparedObject[]): string[] {
  const inside = new Set(prepared.map(p => key(p.address)));
  const out = new Map<string, string>();
  for (const p of prepared) for (const st of p.flow?.steps ?? []) {
    const a = addressOf('t', st.id);
    if (a && !inside.has(key(a))) out.set(key(a), a);
  }
  return [...out.values()];
}

/** An input without its creation text. */
function withoutCreation(input: BundleInput): BundleInput {
  const { generate: _generate, creationError: _error, instances: _instances, ...rest } = input;
  return rest;
}

/** `<size>:<text>` of a text variable, after a space. */
const framedEc = (v: string) => `" " + str(${v}.size()) + ":" + ${v}`;

/**
 * The links text of flow project `a` into `_f<i>`, at the top of the part
 * with the places, before any `genedit()`: measured on 5.6.10, after
 * `genedit()` of a FlowProject its `transLinks` hold one more link per link
 * for the rest of the run, without `from` and `to`.
 */
function flowHeadEc(a: string, i: number): string[] {
  return [
    `_f${i} := ""`,
    `IF ${a} != MISSING THEN`,
    ...flowLinksEc(a).map(l => INDENT + l),
    `${INDENT}_f${i} := _s`,
    'ELSE ""',
    'ENDIF',
  ];
}

/** `"\n<tag> <size>:<address> "`: the start of an answer line, its address
 *  framed by its size (an address may hold spaces and quotes). */
const lineStart = (tag: string, a: string, after = ' ') => ecString(`\n${tag} ${a.length}:${a}${after}`);

/**
 * The places of the objects of one part on the target, in one loop per ID
 * space over the list of their IDs (measured on 5.6.17 and 5.6.10:
 * `list("a", "b").forEach(_x:` with `_o := t.get(_x)` and nested IFs),
 * each a `P` line into `_pl`: `P <space> <size>:<ID> <size>:<parent ID>
 * <size>:<previous ID> <size>:<next ID>` ('' when there is none). At the top
 * of the part, before any `genedit()`: measured, `genedit()` of an object
 * adds a temporary sibling for the rest of the run. Siblings are found by
 * `sortIndex` below and above the object's (it can have gaps); `children`
 * come in `sortIndex` order. A missing object prints no line.
 */
function probePlacesEc(units: readonly PartUnit[]): string[] {
  const bySpace = new Map<string, string[]>();
  for (const u of units) if (u.place) bySpace.set(u.place.space, [...(bySpace.get(u.place.space) ?? []), u.place.id]);
  const i1 = INDENT, i2 = INDENT.repeat(2), i3 = INDENT.repeat(3), i4 = INDENT.repeat(4);
  const out = ['_pl := ""'];
  for (const [space, ids] of bySpace) {
    out.push(
      `list(${ids.map(id => ecString(id)).join(', ')}).forEach(_x:`,
      `${i1}_o := ${space}.get(_x)`,
      `${i1}IF _o != MISSING THEN`,
      `${i2}_q := ""`,
      `${i2}_v := ""`,
      `${i2}_n := ""`,
      `${i2}_p := _o.parent`,
      `${i2}IF _p != MISSING THEN`,
      `${i3}_q := str(_p.id)`,
      `${i3}_i := _o.sortIndex`,
      `${i3}_c := _p.children.filter(sortIndex < _i)`,
      `${i3}IF _c.size() > 0 THEN`,
      `${i4}_v := str(_c.last().id)`,
      `${i3}ELSE ""`,
      `${i3}ENDIF`,
      `${i3}_c := _p.children.filter(sortIndex > _i)`,
      `${i3}IF _c.size() > 0 THEN`,
      `${i4}_n := str(_c.first().id)`,
      `${i3}ELSE ""`,
      `${i3}ENDIF`,
      `${i2}ELSE ""`,
      `${i2}ENDIF`,
      `${i2}_pl := _pl + (${ecString(`\nP ${space} `)} + str(_x.size()) + ":" + _x + ${framedEc('_q')} + ${framedEc('_v')} + ${framedEc('_n')})`,
      `${i1}ELSE ""`,
      `${i1}ENDIF`,
      ')',
    );
  }
  return out;
}

/** The probe lines of one address (the `i`th of the probe). */
function probeStatement(e: ProbeEntry, i: number): string {
  const a = e.address;
  const lines = [`IF ${a} = MISSING THEN`, `${INDENT}_r := _r + ${lineStart('M', a, '')}`, 'ELSE'];
  if (e.kind === 'step') {
    lines.push(
      `${INDENT}_g := str(${a}.genedit())`,
      `${INDENT}_r := _r + (${lineStart('T', a)} + str(${a}.className) + " " + str(_g.size()) + ":" + _g)`,
    );
  } else if (e.kind === 'object') {
    // Its text and the date it last changed (the Check compares both).
    lines.push(
      `${INDENT}_g := str(${a}.${e.short ? FILE_VALUES : 'genedit()'})`,
      `${INDENT}_d := str(${a}.lastModifiedDate.whenMissing(""))`,
      `${INDENT}_r := _r + (${lineStart('O', a)} + str(${a}.className) + " " + str(_g.size()) + ":" + _g + ${framedEc('_d')})`,
    );
    // A property definition: its links are only in generate(true) (a leaf).
    if (e.links) {
      lines.push(
        `${INDENT}_t := str(${a}.generate(true))`,
        `${INDENT}_r := _r + (${lineStart('L', a, '')} + " " + str(_t.size()) + ":" + _t)`,
        // Its own values per class: the texts of its instances.
        ...instancesEc(a, INDENT),
        `${INDENT}_r := _r + (${lineStart('I', a, '')} + " " + str(_v.size()) + ":" + _v)`,
      );
    }
    // A flow project: the links between its steps, read at the top of the
    // part (flowHeadEc).
    if (e.flow) lines.push(`${INDENT}_r := _r + (${lineStart('F', a, '')} + " " + str(_f${i}.size()) + ":" + _f${i})`);
  } else {
    lines.push(
      `${INDENT}_q := ""`,
      `${INDENT}_p := ${a}.parent`,
      `${INDENT}IF _p != MISSING THEN`,
      `${INDENT.repeat(2)}_q := str(_p.id)`,
      `${INDENT}ELSE ""`,
      `${INDENT}ENDIF`,
      `${INDENT}_r := _r + (${lineStart('E', a)} + str(${a}.className) + ${framedEc('_q')})`,
    );
  }
  lines.push('ENDIF');
  return lines.join('\n');
}

/** A listing start: `<space>.<ID>`, an ID of letters, digits and underscore
 *  that does not start with a digit. */
function listingStart(address: string): string {
  const c = checkAddress(address);
  if (!c.ok || !/^[A-Za-z_]/.test(c.id)) throw new Error(`Not an address the comparison can list under: ${address}`);
  return addressOf(c.space, c.id);
}

/**
 * The listing of what the target has under `start` (one statement, a part
 * of its own: no `genedit()` runs before it, so no temporary object is
 * listed). Per descendant, at most LISTING_CAP + 1 (the measured
 * `descendants().first(n).forEach(…)`), one line
 *
 *     U <Class> <system> <size>:<ID> <size>:<parent ID> <size>:<name>
 *
 * then `K <count>`, or `K -1` when there is no object at `start`. Lines are gathered in a chunk flushed every 20,
 * so a long listing is not copied once per line.
 */
function listingStatement(start: string): string {
  const i1 = INDENT, i2 = INDENT.repeat(2), i3 = INDENT.repeat(3);
  const framed = (v: string) => `str(${v}.size()) + ":" + ${v}`;
  return [
    `${EC_CHUNK} := ""`,
    '_k := 0',
    '_j := 0',
    `IF ${start} = MISSING THEN`,
    `${i1}_r := _r + ${ecString('\nK -1')}`,
    'ELSE',
    `${i1}${start}.descendants().first(${LISTING_CAP + 1}).forEach(_i:`,
    `${i2}_a := str(_i.id.whenMissing(""))`,
    `${i2}_b := str(_i.parent.id.whenMissing(""))`,
    `${i2}_n := str(_i.name.whenMissing(""))`,
    `${i2}${EC_CHUNK} := ${EC_CHUNK} + (${ecString('\nU ')} + str(_i.className) + " " + str(_i.systemObject.whenMissing(false)) + " " + ${framed('_a')} + " " + ${framed('_b')} + " " + ${framed('_n')})`,
    `${i2}_k := _k + 1`,
    `${i2}_j := _j + 1`,
    `${i2}IF _j >= 20 THEN`,
    `${i3}_r := _r + ${EC_CHUNK}`,
    `${i3}${EC_CHUNK} := ""`,
    `${i3}_j := 0`,
    `${i2}ELSE ""`,
    `${i2}ENDIF`,
    `${i1})`,
    `${i1}_r := _r + ${EC_CHUNK}`,
    `${i1}${EC_CHUNK} := ""`,
    `${i1}_r := _r + ${ecString('\nK ')} + str(_k)`,
    'ENDIF',
  ].join('\n');
}

const LISTING_STEP: StepSpec = {
  title: 'What the target has',
  does: 'Lists what the target has under one object of this transport. Changes nothing.',
  run: 'preview',
  again: 'it changes nothing',
  runLine: 'Run with Preview on the target, then copy the whole answer back.',
};

/** The key of the listing of `start` on the source workspace. */
const sourceListingKey = (start: string) => fnv1a(`source ${key(start)}`);

/**
 * The listing of what this (the source) workspace has under `start`, in
 * the target part's form (listingStatement: `descendants().first(20001)`)
 * with a key of its own, so that "only on the target" is computed from what
 * the source has at the comparison, not from an older scan. Preview.
 */
export function sourceListingText(start: string): string {
  const s = listingStart(start);
  const k = sourceListingKey(s);
  return [`_r := ${ecString(headLine(1, 1, k))}`, `_g := ${s}`, listingStatement('_g'), `_r + ${ecString(`\n${endLine(1, 1, k)}`)}`].join('\n');
}

/** The IDs this workspace has under `start`, its own included, from the
 *  answer of sourceListingText; an error when the answer is damaged, the
 *  object is missing or the listing is cut (more than LISTING_CAP). */
export function parseSourceListing(log: string, start: string): { ok: true; ids: string[] } | { ok: false; error: string } {
  const s = listingStart(start);
  const r = parseProbeAnswer(log, { key: sourceListingKey(s), total: 1, entries: [], listing: s });
  if (!r.ok) return { ok: false, error: r.error };
  const l = r.answer.listing!;
  if (l.missing) return { ok: false, error: `This workspace has no ${s}.` };
  if (l.cut) return { ok: false, error: `This workspace has more than ${LISTING_CAP.toLocaleString('en-US')} objects under ${s}.` };
  return { ok: true, ids: [idOfAddress(s), ...l.objects.map(o => o.id)] };
}

const headLine = (part: number, total: number, k: string) => `${PROBE_MARKER} v${PROBE_VERSION} part ${part}/${total} key ${k}`;
const endLine = (part: number, total: number, k: string) => `${PROBE_MARKER} end part ${part}/${total} key ${k}`;

const PROBE_STEP: StepSpec = {
  title: 'Compare',
  does: 'Reads what the target holds for the objects of this transport. Changes nothing.',
  run: 'preview',
  again: 'it changes nothing',
  runLine: 'Run with Preview on the target, then copy the whole answer back.',
};

/**
 * The probe for `inputs` (the same inputs as the bundle; objects the bundle
 * leaves out are not probed): preview parts that print, per address, the
 * bundle objects with class and whole generated text, and whether every
 * other address the patch needs exists (parents, and the previous and next
 * siblings used for ordering; roots such as `root.property` are not
 * probed) and whether the addresses the objects' values refer to exist
 * (outsideReferences). Each part's answer is
 *
 *     #cc-probe v3 part <i>/<n> key <key>
 *     O <address> <Class> <size>:<genedit text> <size>:<parent ID> <size>:<previous ID> <size>:<next ID>
 *     L <address> <size>:<generate(true) text> (after the O line of a property definition)
 *     I <address> <size>:<its instances' texts> (after its L line)
 *     F <address> <size>:<links text>          (after the O line of a flow project)
 *     T <address> <Class> <size>:<genedit text> (a step of a flow project not in the transport)
 *     M <address>                              (nothing there)
 *     E <address> <Class> <size>:<parent ID>   (exists; existence-only addresses)
 *     #cc-probe end part <i>/<n> key <key>
 *
 * With `opts.listing`, a last part of its own lists what the target has
 * under that object (listingStatement): `U` lines, then one `K` line. The
 * key covers the listed address too.
 *
 * with every entry after a line break; each `<size>:` counts the characters
 * of the text after it ('' when there is none: `0:`). The places of a
 * part's objects are read at its top, before any generated text
 * (probePlaceEc). The key is derived from the probed addresses, so an
 * answer of another probe is recognised. Parts follow the bundle's limit
 * and header style. Deterministic.
 */
export function buildProbe(inputs: readonly BundleInput[], opts: ProbeOptions = {}): TransportProbe {
  const limit = opts.partLimit ?? BUNDLE_PART_LIMIT;
  const listing = opts.listing ? listingStart(opts.listing.start) : undefined;
  const plan = probePlan(inputs, listing);
  const k = plan.key;
  const units: PartUnit[] = plan.entries.map((e, i) => {
    const place = e.kind === 'object' ? splitAddress(e.address) : null;
    return { text: probeStatement(e, i), objects: 1, guards: [], ...(place ? { place } : {}), ...(e.flow ? { head: flowHeadEc(e.address, i) } : {}) };
  });
  const frame = (_objects: number, index: number, total: number): PartFrame => ({
    before: [`_r := ${ecString(headLine(index, total, k))}`],
    after: [`_r + ${ecString(`\n${endLine(index, total, k)}`)}`],
  });
  // The probe parts start with the places of their objects (probePlacesEc).
  // Each part also reads the types switched off on the target (measured on
  // 5.6.17 and 5.6.10: `CePolicy;true&CeProduct;false&…`; the answer keeps
  // the first).
  const probeFrame = (objects: number, index: number, total: number): PartFrame => {
    const f = frame(objects, index, total);
    return { ...f, before: [`${f.before[0]} + _pl`, '_ty := str(root.toggleableStateMap.whenMissing(""))', '_r := _r + ("\\nY " + str(_ty.size()) + ":" + _ty)'] };
  };
  const { parts, warnings: oversize } = renderParts<'probe' | 'listing'>('Comparison script', [
    { step: 'probe', spec: PROBE_STEP, units, frame: probeFrame, partHead: probePlacesEc },
    { step: 'listing', spec: LISTING_STEP, units: listing ? [{ text: listingStatement(listing), objects: 1, guards: [] }] : [], frame },
  ], limit);
  // Which part answers which address: units in order, `statements` per part.
  const entries: Array<ProbeEntry & { part: number }> = [];
  let at = 0;
  for (const part of parts) if (part.step === 'probe') for (let i = 0; i < part.statements; i++) entries.push({ ...plan.entries[at++], part: part.index });
  const warnings = [...plan.warnings, ...oversize];
  const objects = plan.entries.filter(e => e.kind === 'object').length;
  const preamble = [
    `// Comparison script (beta): ${objects} object${objects === 1 ? '' : 's'} and ${entries.length - objects} other address${entries.length - objects === 1 ? '' : 'es'}${listing ? `, and what the target has under ${listing},` : ''} in ${parts.length} part${parts.length === 1 ? '' : 's'} (key ${k}).`,
    '// Run each part with Preview on the target. Copy the whole answer of every part back into the Transport window in one paste.',
    ...leftOutAndWarningLines(plan.leftOut, warnings),
  ].join('\n') + '\n';
  return {
    key: k, total: parts.length, parts, entries, ...(listing ? { listing } : {}), leftOut: plan.leftOut, warnings, preamble,
    text: [preamble, ...parts.map(p => p.text)].join('\n'),
  };
}

// ── the answer ──────────────────────────────────────────────────────

/** What the target holds at an address. */
export type ProbeState =
  | { state: 'missing' }
  | {
    state: 'present'; className: string;
    /** The whole generated text as BMP returned it (bundle objects). */
    genedit?: string;
    /** When it last changed, as `str(lastModifiedDate)` prints it ('' when
     *  unknown; bundle objects). */
    modified?: string;
    /** Its parent's ID ('' for none). */
    parentId?: string;
    /** Its previous and next sibling's ID ('' for none; bundle objects). */
    previousId?: string;
    nextId?: string;
    /** A property definition: its `generate(true)` text as BMP returned
     *  it, and the classes it is linked to (sorted). */
    linksText?: string;
    links?: string[];
    /** A property definition: the `genedit()` texts of its instances
     *  (`<size>:<text>` each). */
    instancesText?: string;
    /** A flow project: its links text (`<from ID>><to ID>;` each). */
    flowText?: string;
  };

/** One object the target has under the listed object. */
export interface ListedObject {
  className: string;
  /** A system object: never deleted. */
  system: boolean;
  id: string;
  /** Its parent's ID as the target prints it. */
  parentId: string;
  name: string;
}

/** What the target has under one object (ProbeOptions.listing). */
export interface TargetListing {
  /** The listed object's address. */
  start: string;
  /** The target has no object at `start`. */
  missing: boolean;
  /** More than LISTING_CAP objects: `objects` is cut, and nothing is
   *  counted as only on the target. */
  cut: boolean;
  /** In the target's order (parents before their children). */
  objects: ListedObject[];
}

export interface ProbeAnswer {
  key: string;
  /** By the address as the probe wrote it (ProbeExpectation.entries). */
  states: Readonly<Record<string, ProbeState>>;
  /** With a listing probe. */
  listing?: TargetListing;
  /** The types the target can switch off, as it prints them
   *  (`<Class>;true&<Class>;false&…`); absent when not read. */
  types?: string;
}

export type ProbeAnswerErrorKind = 'not-found' | 'wrong-version' | 'wrong-key' | 'missing-part' | 'incomplete' | 'unanswered';

export type ProbeParse =
  | { ok: true; answer: ProbeAnswer }
  | { ok: false; kind: ProbeAnswerErrorKind; error: string; part?: number; address?: string };

const HEAD = new RegExp(`${PROBE_MARKER} v(\\d{1,4}) part (\\d{1,4})/(\\d{1,4}) key ([0-9a-z]{1,32})`, 'g');
/** `<size>:` of a framed address. */
const SIZE = /(\d{1,9}):/y;
/** ` <Class> <size>:` after the address of an O, E or T entry. */
const PRESENT_ENTRY = / (\S*) (\d{1,9}):/y;
/** ` <size>:` of a further text. */
const FRAMED = / (\d{1,9}):/y;
/** `<Class> <system> <size>:` of a listing line. */
const LISTED = /(\S+) (true|false)/y;
/** `<count> <size>:` of a listing's last line. */
const LISTED_END = /(-1|\d{1,9})/y;

/** What one part's answer holds. */
interface PartRead {
  end: number;
  states: Array<[string, ProbeState]>;
  /** The places of its objects (`P` lines), by address. */
  places: Array<[string, { parentId: string; previousId: string; nextId: string }]>;
  /** The types switched off (`Y`). */
  types?: string;
  /** The listing's objects, and its last line (the count) when the part
   *  ends one. */
  listed: ListedObject[];
  listedEnd?: { count: number };
}

/** The text of `size` characters from `start`, or null when cut off. */
function sized(text: string, start: number, size: number): { value: string; end: number } | null {
  return start + size > text.length ? null : { value: text.slice(start, start + size), end: start + size };
}

/** ` <size>:<text>` at `pos`, or null. */
function framedAt(text: string, pos: number): { value: string; end: number } | null {
  FRAMED.lastIndex = pos;
  const m = FRAMED.exec(text);
  return m ? sized(text, pos + m[0].length, Number(m[1])) : null;
}

/** `<size>:<address>` at `pos`, the address as the probe writes it, or null. */
function addressAt(text: string, pos: number): { value: string; end: number } | null {
  SIZE.lastIndex = pos;
  const m = SIZE.exec(text);
  const a = m ? sized(text, pos + m[0].length, Number(m[1])) : null;
  return a && a.value && plainAddress(a.value) === a.value ? a : null;
}

/** Read one part's entries from just after its head line; null when the
 *  text is cut off or does not have the form. Texts and addresses are read
 *  by their declared size, never by searching for a delimiter. */
function readPart(text: string, from: number, part: number, total: number, k: string): PartRead | null {
  const end = `\n${endLine(part, total, k)}`;
  const states: Array<[string, ProbeState]> = [];
  const places: PartRead['places'] = [];
  let types: string | undefined;
  const listed: ListedObject[] = [];
  let listedEnd: PartRead['listedEnd'];
  let pos = from;
  for (;;) {
    if (text.startsWith(end, pos)) return { end: pos + end.length, states, places, listed, ...(listedEnd ? { listedEnd } : {}), ...(types != null ? { types } : {}) };
    if (text[pos] !== '\n' || text[pos + 2] !== ' ') return null;
    const tag = text[pos + 1];
    pos += 3;
    if (tag === 'P') {
      // `P <space> <size>:<ID> <size>:<parent ID> <size>:<previous ID> <size>:<next ID>`
      const sp = /([A-Za-z_][A-Za-z0-9_]*) /y;
      sp.lastIndex = pos;
      const m = sp.exec(text);
      SIZE.lastIndex = m ? pos + m[0].length : pos;
      const n = m ? SIZE.exec(text) : null;
      const id = n ? sized(text, SIZE.lastIndex, Number(n[1])) : null;
      const parent = id && framedAt(text, id.end);
      const previous = parent && framedAt(text, parent.end);
      const next = previous && framedAt(text, previous.end);
      const address = m && id ? addressOf(m[1], id.value) : '';
      if (!next || !address) return null;
      places.push([address, { parentId: parent!.value, previousId: previous!.value, nextId: next.value }]);
      pos = next.end;
      continue;
    }
    if (tag === 'U') {
      LISTED.lastIndex = pos;
      const m = LISTED.exec(text);
      const id = m && framedAt(text, pos + m[0].length);
      const parentId = id && framedAt(text, id.end);
      const name = parentId && framedAt(text, parentId.end);
      if (!m || !id || !parentId || !name || listedEnd) return null;
      listed.push({ className: m[1], system: m[2] === 'true', id: id.value, parentId: parentId.value, name: name.value });
      pos = name.end;
      continue;
    }
    if (tag === 'K') {
      LISTED_END.lastIndex = pos;
      const m = LISTED_END.exec(text);
      if (!m || listedEnd) return null;
      listedEnd = { count: Number(m[1]) };
      pos += m[0].length;
      continue;
    }
    if (tag === 'Y') {
      // `Y <size>:<types>`
      SIZE.lastIndex = pos;
      const m = SIZE.exec(text);
      const body = m ? sized(text, pos + m[0].length, Number(m[1])) : null;
      if (!body || types != null) return null;
      types = body.value;
      pos = body.end;
      continue;
    }
    if (tag === 'L' || tag === 'I' || tag === 'F') {
      // `<tag> <size>:<address> <size>:<text>`, after the O line of that address.
      const a = addressAt(text, pos);
      const address = a?.value ?? '';
      const last = states.at(-1);
      const body = a ? framedAt(text, a.end) : null;
      if (!body || !last || last[0] !== address || last[1].state !== 'present') return null;
      const st = last[1];
      if (tag === 'L') {
        if (st.linksText != null) return null;
        last[1] = { ...st, linksText: body.value, links: linkedClasses(body.value) ?? [] };
      } else if (tag === 'I') {
        if (st.linksText == null || st.instancesText != null) return null;
        last[1] = { ...st, instancesText: body.value };
      } else {
        if (st.flowText != null) return null;
        last[1] = { ...st, flowText: body.value };
      }
      pos = body.end;
      continue;
    }
    if (tag === 'M') {
      const a = addressAt(text, pos);
      if (!a) return null;
      states.push([a.value, { state: 'missing' }]);
      pos = a.end;
      continue;
    }
    if (tag !== 'O' && tag !== 'E' && tag !== 'T') return null;
    const a = addressAt(text, pos);
    PRESENT_ENTRY.lastIndex = a ? a.end : pos;
    const m = a ? PRESENT_ENTRY.exec(text) : null;
    const first = m ? sized(text, PRESENT_ENTRY.lastIndex, Number(m[2])) : null;
    if (!a || !m || !first) return null;
    if (tag === 'T') {
      states.push([a.value, { state: 'present', className: m[1], genedit: first.value }]);
      pos = first.end;
      continue;
    }
    if (tag === 'E') {
      states.push([a.value, { state: 'present', className: m[1], parentId: first.value }]);
      pos = first.end;
      continue;
    }
    const date = framedAt(text, first.end);
    if (!date) return null;
    // Its place comes from its P line (parseProbeAnswer); none: no parent.
    states.push([a.value, { state: 'present', className: m[1], genedit: first.value, modified: date.value, parentId: '', previousId: '', nextId: '' }]);
    pos = date.end;
  }
}

/**
 * Read a probe answer as a person pastes it back: one or several parts in
 * any order, with any text before, between and after them (a script window
 * prints `Result : ` before the value and `Duration : 3ms` after it), with
 * CR LF or LF line breaks (made LF before any size is counted; the sizes in
 * the answer count LF). Each genedit text is read by its declared size, so
 * it may hold any characters, the answer markers included. A head line that does
 * not start a readable part (the probe script itself pasted along, say) is
 * passed over. Errors, in this order: no answer at all, an answer of
 * another probe version or key, a part missing or cut off, an expected
 * address not answered.
 */
export function parseProbeAnswer(pasted: string, expected: ProbeExpectation): ProbeParse {
  const text = pasted.replace(/\r\n?/g, '\n');
  const found = new Map<number, PartRead>();
  const broken = new Set<number>();
  let total: number | undefined;
  let otherKey: string | undefined;
  let otherVersion = false;
  let any = false;
  let consumed = 0;
  for (const m of text.matchAll(HEAD)) {
    any = true;
    if (m.index < consumed) continue;
    const [version, part, n, k] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
    if (version !== PROBE_VERSION) { otherVersion = true; continue; }
    if (k !== expected.key) { otherKey ??= k; continue; }
    if (part < 1 || part > n || found.has(part)) continue;
    total ??= n;
    const read = readPart(text, m.index + m[0].length, part, n, k);
    if (!read) { broken.add(part); continue; }
    found.set(part, read);
    consumed = read.end;
  }
  if (total == null) {
    if (otherKey) return { ok: false, kind: 'wrong-key', error: `This answer belongs to another comparison (key ${otherKey}; this one has key ${expected.key}). Run this comparison script on the target and paste its answer.` };
    if (otherVersion) return { ok: false, kind: 'wrong-version', error: 'This answer comes from another version of Companion. Run this comparison script on the target and paste its answer.' };
    return { ok: false, kind: any ? 'incomplete' : 'not-found', error: any ? 'The answer is incomplete: copy all of it.' : 'No answer found. Run the comparison script with Preview on the target and copy the whole answer.' };
  }
  for (let part = 1; part <= total; part++) {
    if (found.has(part)) continue;
    if (broken.has(part)) return { ok: false, kind: 'incomplete', part, error: 'The answer is incomplete: copy all of it.' };
    return { ok: false, kind: 'missing-part', part, error: `Part ${part} of ${total} is missing.` };
  }
  const byKey = new Map<string, ProbeState>();
  const placeOf = new Map<string, { parentId: string; previousId: string; nextId: string }>();
  for (const read of found.values()) for (const [address, place] of read.places) placeOf.set(key(address), place);
  for (const read of found.values()) {
    for (const [address, state] of read.states) {
      if (byKey.has(key(address))) continue;
      const place = state.state === 'present' && state.modified != null ? placeOf.get(key(address)) : undefined;
      byKey.set(key(address), place ? { ...state, ...place } : state);
    }
  }
  const states: Record<string, ProbeState> = {};
  for (const e of expected.entries) {
    const s = byKey.get(key(e.address));
    if (!s) return { ok: false, kind: 'unanswered', address: e.address, error: `The answer says nothing about ${e.address}. Run the comparison script again and copy all of it.` };
    states[e.address] = s;
  }
  const typesRead = [...found.values()].find(r => r.types != null)?.types;
  const withTypes = typesRead != null ? { types: typesRead } : {};
  if (!expected.listing) return { ok: true, answer: { key: expected.key, states, ...withTypes } };
  // The listing: its lines and its last line, in part order.
  const parts = [...found.entries()].sort(([a], [b]) => a - b).map(([, r]) => r);
  const ended = parts.find(r => r.listedEnd)?.listedEnd;
  const objects = parts.flatMap(r => r.listed);
  if (!ended) return { ok: false, kind: 'unanswered', address: expected.listing, error: `The answer says nothing about what the target has under ${expected.listing}. Run the comparison script again and copy all of it.` };
  if (ended.count < 0 ? objects.length > 0 : objects.length !== Math.min(ended.count, LISTING_CAP + 1)) return { ok: false, kind: 'incomplete', error: 'The answer is incomplete: copy all of it.' };
  const cut = ended.count > LISTING_CAP;
  const listing: TargetListing = {
    start: expected.listing, missing: ended.count < 0, cut, objects: cut ? objects.slice(0, LISTING_CAP) : objects,
  };
  return { ok: true, answer: { key: expected.key, states, listing, ...withTypes } };
}

// ── the patch ───────────────────────────────────────────────────────

export type PatchStep = 'check' | 'rename' | 'create' | 'set' | 'link' | 'own' | 'setAgain' | 'order' | 'delete' | 'record' | 'report';
export type PatchPart = BundlePart<PatchStep>;

/** What the patch does with an object it carries. Objects it does not carry
 *  are in `leftOut`. */
export type PatchOutcome =
  /** Missing on the target: created, then all its values set. */
  | 'create'
  /** On the target with the same class and another text: the values that
   *  differ are set, those only the target has cleared (or kept); moved or
   *  re-placed when its place differs too. An object whose ID changed here
   *  (`renamedFrom`) gets its ID changed first and its whole line set. A
   *  property definition linked here to a class the target does not link it
   *  to gets that link. */
  | 'change'
  /** The same text on the target, another place: moved to its parent or
   *  re-placed among its siblings. */
  | 'move'
  /** The same text and place on the target: no statement. */
  | 'same';

/** What happens to one value of an object. */
export type PatchValueAction =
  /** Only the source has it: set. */
  | 'set'
  /** Both have it, the texts differ: set to the source's. */
  | 'change'
  /** Only the target has it: cleared (`x.clear(name)`). */
  | 'clear'
  /** It stays as the target has it: `clearExtra` off, or the `id`. */
  | 'keep'
  /** Both have the same text. */
  | 'same';

/** Words for PatchValueAction, for the review. */
export const PATCH_VALUE_ACTION_LABELS: Readonly<Record<PatchValueAction, string>> = {
  set: 'added', change: 'changed', clear: 'removed', keep: 'kept', same: 'the same',
};

export interface PatchValue {
  /** The property name as the source writes it (the target's when only it has the value). */
  name: string;
  /** The value text on the target (raw Extended Code), absent when it has none. */
  target?: string;
  /** The value text on the source, absent when it has none. */
  source?: string;
  action: PatchValueAction;
}

export interface PatchReviewObject {
  rid: string;
  address: string;
  className: string;
  isNew: boolean;
  name?: string;
  outcome: PatchOutcome;
  /** Per value, in the source's order, then the target's own. For `create`,
   *  every source value as `set`; for `same`, every value as `same`. */
  values: PatchValue[];
  /** The values could not be compared one by one (a text of an unexpected
   *  form, or an object whose ID changes): the whole source line is set and
   *  nothing is cleared. */
  wholeLine?: true;
  /** Its place changes (an object the target has). */
  place?: PatchPlace;
  /** Its address on the target before the Rename part changes its ID. */
  renamedFrom?: string;
  /** A file added without its content: upload it on the target afterwards. */
  upload?: true;
  /** A file the target has whose content is not compared (over the limit). */
  contentNotCompared?: true;
  /** A property definition: the classes it gets linked to (all of them when
   *  it is added), those only the target links it to, and of those the ones
   *  it gets unlinked from ("Delete objects only the target has"). */
  links?: { add: string[]; targetOnly: string[]; remove?: string[] };
  /** A flow project: the links between steps it gets (`<from ID>><to ID>`),
   *  and those only the target has (left as they are). */
  flowLinks?: { add: string[]; targetOnly: string[]; unknown?: true };
  /** A property definition: per class, its own values that change. */
  own?: Array<{ className: string; values: PatchValue[] }>;
}

/** How the patch changes the place of an object the target has. */
export interface PatchPlace {
  /** Moved to another parent: the target's parent ID, and the parent it
   *  moves to (its address, or `root.<name>`). */
  from?: string;
  to?: string;
  /** Re-placed among its siblings: after or before this sibling. */
  method?: 'moveAfter' | 'moveBefore';
  anchor?: string;
  /** "moved from X to t.y", "re-placed after t.z". */
  labels: string[];
}

/** The transport log entry the Record part adds. */
export interface PatchRecord {
  /** A word-safe ID (transportEntryId). */
  entryId: string;
  /** The entry's name. */
  title: string;
  /** Its description; default transportSummary of this patch. Cut at
   *  TRANSPORT_SUMMARY_LIMIT characters. */
  summary?: string;
}

export interface PatchOptions {
  /** Characters per part (default BUNDLE_PART_LIMIT). */
  partLimit?: number;
  /** Clear values only the target has (default true). Off: they are kept
   *  and listed in the review as `keep`. */
  clearExtra?: boolean;
  /** Add the Record part. */
  record?: PatchRecord;
  /** With a listing: the IDs of every object of the source scan under the
   *  listed object (ticked or not), its own included. A listed object whose
   *  ID is none of them is only on the target. Without it nothing counts as
   *  only on the target. */
  sourceIds?: readonly string[];
  /** Delete the objects only the target has (default off). */
  deleteExtra?: boolean;
  /** ID changes (RenameHint.key) not to apply. */
  renamesOff?: ReadonlySet<string>;
  /** The target's name in sentences (default "the target"). */
  targetName?: string;
}

/** Objects per outcome (`move`: only the place differs), ID changes,
 *  deletes, objects only on the target, and those left out. */
export interface PatchCounts {
  create: number; change: number; move: number; same: number;
  rename: number; delete: number; targetOnly: number; leftOut: number;
}

/** An object the target lacks that matches one only the target has: the
 *  same class, the same parent ID (or both parents are such a pair) and the
 *  same name, one to one. */
export interface RenameHint {
  /** `<old ID>><new ID>`, lower case. */
  key: string;
  className: string;
  name: string;
  /** The object's address on the target now, and the source's. */
  from: string;
  to: string;
  /** The source object's RID. */
  rid: string;
  /** Applied: not in PatchOptions.renamesOff and, when it hangs on the ID
   *  change of its parent (`after`), that one is applied. */
  on: boolean;
  after?: string;
}

/** An object only the target has, in the tree of those objects. */
export interface TargetOnlyObject {
  id: string;
  name: string;
  className: string;
  /** Its address on the target ('' when it cannot be addressed). */
  address: string;
  /** 0 for one whose parent is not only on the target. */
  depth: number;
  /** Objects only the target has under it. */
  under: number;
  /** What a patch that deletes does: deletes it (and everything under it),
   *  deletes it with the object above it, or keeps it. */
  fate: 'delete' | 'with' | 'keep';
  /** Why it is kept. */
  reason?: string;
}

/** One delete of the Delete part. */
export interface PatchDelete {
  address: string;
  className: string;
  name: string;
  /** Its parent's ID once the patch ran (the guard checks it). */
  parentId: string;
  /** Objects under it on the target, deleted with it. */
  under: number;
}

export interface TransportPatch {
  parts: PatchPart[];
  /** The objects it carries (create, change, same, keep), by address. */
  objects: BundledObject[];
  leftOut: LeftOutObject[];
  warnings: BundleWarning[];
  notes: readonly string[];
  preamble: string;
  text: string;
  /** Per carried object, by address: what happens to it and its values. */
  review: PatchReviewObject[];
  counts: PatchCounts;
  /** The probe's key. */
  key: string;
  /** No object to create, rename, delete, no value to set or clear, no
   *  object to move or re-place: only the report. */
  nothingToDo: boolean;
  /** The ID changes found (on and off). */
  renames: RenameHint[];
  /** Steps of flow projects of the transport that are not in it and that the
   *  target lacks or has with other values (`t.<ID>`). */
  flowSteps: string[];
  /** Class links of property definitions the target has and this workspace
   *  does not, removed ("Delete objects only the target has"). */
  unlinks: Array<{ address: string; className: string }>;
  /** Class links only the target has, removed or not: the delete switch is
   *  offered for them. */
  linksOnlyOnTarget: number;
  /** Objects to add whose type is switched off on the target (left out). */
  typesOff: Array<{ rid: string; address: string; className: string }>;
  /** Files added without their content: upload them on the target afterwards. */
  uploads: UploadFile[];
  /** The objects only the target has under the listed object, as a tree
   *  (pre-order); empty without a complete listing. */
  targetOnly: TargetOnlyObject[];
  /** What the Delete part deletes (PatchOptions.deleteExtra). */
  deletes: PatchDelete[];
  /** The listing the patch was made with: complete, the object missing on
   *  the target, or cut. */
  listing?: { start: string; state: 'ok' | 'missing' | 'cut' };
}

/** Said above every patch. */
export const PATCH_NOTES: readonly string[] = Object.freeze([
  'Deletes are not part of these scripts: an object deleted here stays on the target.',
  'Secrets and files are not part of these scripts.',
  'Run the Check part first. It confirms that the target still holds what the comparison saw; when it does not, compare again.',
  'Every committed part first checks the class of each object it addresses. When one differs, the run fails and nothing of that part is stored.',
  'References to objects that are neither in this transport nor on the target do not resolve. The report compares the whole generated text, so such an object shows as DIFFERENT.',
]);

/** Why a linked copy the target lacks is left out. */
export const linkedCopyDetail = (template: string): string => `A linked copy is not added: link ${oneLine(template) || 'its template'} under its parent on the target.`;

/** The first note of a patch made with a listing: deletes off, and on. */
export const DELETE_NOTE_OFF = 'Objects only the target has stay. Turn on "Delete objects only the target has" to delete them.';
export const DELETE_NOTE_ON = 'Deleting cannot be undone and removes everything under each object. System objects stay.';

/** Characters of a transport log entry's description at most. */
export const TRANSPORT_SUMMARY_LIMIT = 4_000;

/** The transport log folder: under the shared web root (`root.portal`). */
export const TRANSPORT_LOG_ID = 'cc_transport_log';
export const TRANSPORT_LOG_NAME = 'Transport log';

export const PATCH_STEPS: Readonly<Record<PatchStep, StepSpec>> = {
  check: { title: 'Check', does: 'Confirms that the target still holds what the comparison saw: the same texts, what is missing, and the parents and siblings these scripts rely on.', run: 'preview', again: 'it changes nothing' },
  rename: { title: 'Change ID', does: 'Changes the ID of objects whose ID changed on the source, so that they are changed instead of added again.', run: 'committed', again: 'it changes only objects that still have the old ID' },
  create: { title: 'Add', does: 'Adds the objects the target lacks with their values, parents before children.', run: 'committed', again: 'it adds only what is missing' },
  set: { title: 'Change', does: 'Changes the values that differ on objects the target has, and the values of added objects that their Add does not give.', run: 'committed', again: 'it changes to the same values' },
  link: { title: 'Link', does: 'Links property definitions to the classes they are linked to here, and the steps of flow projects as they are linked here. A link the target has already is not added again.', run: 'committed', again: 'it adds only links not there yet' },
  own: OWN_STEP,
  setAgain: { title: 'Change (uses added objects)', does: 'Changes again the added objects that use one added with or after them, and the objects that use an added one, so that these values resolve.', run: 'committed', again: 'it changes to the same values' },
  order: { title: 'Move', does: 'Moves objects to another parent first, then into their place among their siblings.', run: 'committed', again: 'it moves only objects that exist' },
  delete: { title: 'Delete', does: 'Deletes the objects only the target has, and removes class links only the target has. Deleting cannot be undone and removes everything under each object; removing a class link loses the values of the property on objects of that class.', run: 'committed', again: 'it deletes only what is still there' },
  record: { title: 'Log entry', does: `Adds an entry for this transport to the ${TRANSPORT_LOG_NAME} of this workspace.`, run: 'committed', again: 'it adds the entry only once' },
  report: { title: 'Report', does: 'Prints one line per object: ok, MISSING, or DIFFERENT (its whole generated text compared with the source\'s), then the counts.', run: 'preview', again: 'it changes nothing' },
};

export const PATCH_STEP_ORDER: readonly PatchStep[] = ['check', 'rename', 'create', 'set', 'link', 'own', 'setAgain', 'order', 'delete', 'record', 'report'];

/** `name := value` pairs of an argument list, in order; null when a piece
 *  has another form. */
function pairsOf(args: string): Array<{ name: string; value: string }> | null {
  return argumentPairs(splitArguments(args));
}

/** The values of a source line against a target text; null when either
 *  cannot be read value by value. Names are matched without regard to case. */
function diffValues(source: GeneditLine, targetText: string, clearExtra: boolean): PatchValue[] | null {
  const target = parseObjectText(targetText);
  const sp = pairsOf(source.args);
  const tp = target ? pairsOf(withoutNeverCarried(target.args)) : null;
  if (!sp || !tp) return null;
  return diffPairs(sp, tp, clearExtra);
}

/** The values of source pairs against target pairs (diffValues). */
function diffPairs(sp: ReadonlyArray<{ name: string; value: string }>, tp: ReadonlyArray<{ name: string; value: string }>, clearExtra: boolean): PatchValue[] {
  const onTarget = new Map<string, { name: string; value: string }>();
  for (const t of tp) if (!onTarget.has(t.name.toLowerCase())) onTarget.set(t.name.toLowerCase(), t);
  const inSource = new Set<string>();
  const out: PatchValue[] = [];
  for (const s of sp) {
    const n = s.name.toLowerCase();
    if (inSource.has(n)) continue;
    inSource.add(n);
    const t = onTarget.get(n);
    if (!t) out.push({ name: s.name, source: s.value, action: 'set' });
    else out.push({ name: s.name, target: t.value, source: s.value, action: t.value === s.value ? 'same' : 'change' });
  }
  for (const [n, t] of onTarget) {
    if (inSource.has(n)) continue;
    out.push({ name: t.name, target: t.value, action: clearExtra && n !== 'id' ? 'clear' : 'keep' });
  }
  return out;
}

/** The statements of a changed object: one change of the set and changed
 *  values, one clear per cleared value. */
function changeStatements(address: string, values: readonly PatchValue[]): string[] {
  const set = values.filter(v => v.action === 'set' || v.action === 'change');
  return [
    ...(set.length ? [`${address}.change(${set.map(v => `${v.name} := ${v.source}`).join(', ')})`] : []),
    ...values.filter(v => v.action === 'clear').map(v => `${address}.clear(${v.name})`),
  ];
}

interface Planned {
  p: PreparedObject;
  outcome: PatchOutcome;
  values: PatchValue[];
  /** The probed text, stripped (change, same, keep). */
  target?: string;
  /** The probed text's size as BMP returned it, and when the object last
   *  changed there (the Check compares both). */
  targetSize?: number;
  targetDate?: string;
  /** Change: its value statements. */
  statements: string[];
  wholeLine?: true;
  /** Its ID changes first (an applied RenameHint). */
  renamed?: RenameHint;
  /** A property definition: the classes to link it to, those only the
   *  target links it to, and of those the ones to unlink (the delete switch). */
  links?: { add: string[]; targetOnly: string[]; remove?: string[] };
  /** A property definition the target has: its generate(true) text there. */
  linksText?: string;
  targetLinks?: string[];
  /** A property definition the target has: its instances' texts there. */
  instancesText?: string;
  /** A flow project: the links between steps to add, and those only the
   *  target has; `unknown` when the target's could not be read. */
  flowLinks?: { add: FlowLink[]; targetOnly: string[]; unknown?: true };
  /** A flow project the target has: its links text there (the Check). */
  flowText?: string;
  /** A property definition: per class, its own values that change. */
  own?: Array<{ className: string; values: PatchValue[] }>;
}

/** The receiver a created object is added to (its create statement's), else
 *  the parent read. */
const receiverOf = (p: PreparedObject) => p.create?.parentAddress ?? p.parent;

/** The check lines of one address; `delete`: it exists with `count`
 *  objects under it. The walk stops after LISTING_CAP + 1 objects: deletes
 *  come only from a complete listing, so `count` is at most LISTING_CAP, and
 *  an object that has more than that under it now reads as CHANGED. */
function checkStatement(kind: 'text' | 'missing' | 'exists' | 'delete', address: string, expected = '', count = 0, short = false): string {
  const add = (text: string) => `_r := _r + ${ecString(text)}`;
  const deviation = (text: string) => [add(text), '_dv := _dv + "."'];
  if (kind === 'missing') {
    return [`IF ${address} != MISSING THEN`, ...deviation(`\nEXISTS now ${address}`).map(l => INDENT + l), 'ELSE', `${INDENT}_ok := _ok + "."`, 'ENDIF'].join('\n');
  }
  if (kind === 'exists') {
    return [`IF ${address} = MISSING THEN`, ...deviation(`\nMISSING now ${address}`).map(l => INDENT + l), 'ELSE', `${INDENT}_ok := _ok + "."`, 'ENDIF'].join('\n');
  }
  if (kind === 'delete') {
    const i2 = INDENT.repeat(2);
    return [
      `IF ${address} = MISSING THEN`,
      ...deviation(`\nMISSING now ${address}`).map(l => INDENT + l),
      'ELSE',
      `${INDENT}_c := ${address}.descendants().first(${LISTING_CAP + 1})`,
      `${INDENT}IF _c.size() = ${count} THEN`,
      `${i2}_ok := _ok + "."`,
      `${INDENT}ELSE`,
      ...deviation(`\nCHANGED under ${address}`).map(l => i2 + l),
      `${INDENT}ENDIF`,
      'ENDIF',
    ].join('\n');
  }
  return [
    `IF ${address} = MISSING THEN`,
    ...deviation(`\nMISSING now ${address}`).map(l => INDENT + l),
    'ELSE',
    ...exactTextEc(address, expected, ['_ok := _ok + "."'], deviation(`\nCHANGED since the comparison ${address}`), INDENT, short),
    'ENDIF',
  ].join('\n');
}

/**
 * The link of a property definition the target has to one class, guarded:
 * the class exists and the object is there, and the class's ClassConfig has
 * no child with the ID `<its ID>.<the property's ID>` (the class does not
 * link it yet; linking it twice fails the run).
 */
function linkStatement(address: string, className: string): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `_lc := c.get(${className}.name)`,
    `IF _lc != MISSING AND ${address} != MISSING THEN`,
    `${i1}_lx := str(_lc.id) + "." + str(${address}.id)`,
    `${i1}_lf := _lc.children.filter(id = _lx)`,
    `${i1}IF _lf.size() = 0 THEN`,
    `${i2}${classLinkLine(className, address)}`,
    `${i1}ELSE ""`,
    `${i1}ENDIF`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

/**
 * The Check lines of a property definition's links: its `generate(true)`
 * text on the target has the size it had at the comparison and a link line
 * for each class it had then. The link lines come in no fixed order, so the
 * text is not compared as a whole; its size does not depend on that order.
 */
function linksCheckStatement(address: string, text: string, classes: readonly string[]): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `IF ${address} != MISSING THEN`,
    `${i1}_t := str(${address}.generate(true))`,
    `${i1}_lk := ""`,
    ...classes.flatMap(c => [
      `${i1}IF _t.indexOf(${ecString(`c.get(${c}.name).link(`)}).whenMissing(-1) > -1 THEN`,
      `${i2}_lk := _lk + "."`,
      `${i1}ELSE ""`,
      `${i1}ENDIF`,
    ]),
    `${i1}IF _t.size() = ${text.length} AND _lk.size() = ${classes.length} THEN`,
    `${i2}_ok := _ok + "."`,
    `${i1}ELSE`,
    `${i2}_r := _r + ${ecString(`\nCHANGED links since the comparison ${address}`)}`,
    `${i2}_dv := _dv + "."`,
    `${i1}ENDIF`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

/**
 * The Check lines of a property definition's own values per class: the
 * texts of its instances on the target have the size they had at the
 * comparison, and each text it had then is there (they come in no fixed
 * order).
 */
function instancesCheckStatement(address: string, text: string): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  const texts = sizedTexts(text);
  return [
    `IF ${address} != MISSING THEN`,
    ...instancesEc(address, i1),
    `${i1}_lk := ""`,
    ...texts.flatMap(t => [
      `${i1}IF _v.indexOf(${ecString(t)}).whenMissing(-1) > -1 THEN`,
      `${i2}_lk := _lk + "."`,
      `${i1}ELSE ""`,
      `${i1}ENDIF`,
    ]),
    `${i1}IF _v.size() = ${text.length} AND _lk.size() = ${texts.length} THEN`,
    `${i2}_ok := _ok + "."`,
    `${i1}ELSE`,
    `${i2}_r := _r + ${ecString(`\nCHANGED own values per class since the comparison ${address}`)}`,
    `${i2}_dv := _dv + "."`,
    `${i1}ENDIF`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

/** The per-class changes of a property definition: its own values here
 *  against the target's (none on the target for a class not linked there
 *  yet). Only the classes it is linked to here; only those that change. */
function ownChanges(here: readonly ClassInstance[], there: readonly ClassInstance[], classes: readonly string[], clearExtra: boolean): Array<{ className: string; values: PatchValue[] }> {
  const by = (list: readonly ClassInstance[]) => new Map(list.map(x => [x.className.toLowerCase(), x.values]));
  const h = by(here), t = by(there);
  const out: Array<{ className: string; values: PatchValue[] }> = [];
  for (const c of classes) {
    const values = diffPairs(h.get(c.toLowerCase()) ?? [], t.get(c.toLowerCase()) ?? [], clearExtra);
    if (values.some(v => v.action === 'set' || v.action === 'change' || v.action === 'clear')) out.push({ className: c, values });
  }
  return out;
}

/** The pairs of a links text; null when any pair has an empty side (a
 *  link read without its steps, or a warning text where a pair should be). */
function readFlowPairs(text: string): string[] | null {
  const pairs = text.split(';').filter(x => x.length);
  const ok = pairs.every(x => /^[^>;]+>[^>;]+$/.test(x) && !/Missing value/.test(x));
  return ok ? flowPairsOf(text) : null;
}

/** The head line of the read of when objects were added. */
export const CREATED_MARKER = '#cc-created';

/**
 * When the objects at `addresses` were added (`str(createdTime)`, with
 * seconds; measured on 5.6.17: two reads compare equal as text), one loop
 * per ID space over their IDs: lines `<space> <size>:<ID> <size>:<time>`
 * (`0:` when it is not there). A
 * preview, after the comparison that follows an apply.
 */
export function createdTimesText(addresses: readonly string[]): string {
  const bySpace = new Map<string, string[]>();
  for (const a of addresses) {
    const x = splitAddress(a);
    if (x) bySpace.set(x.space, [...(bySpace.get(x.space) ?? []), x.id]);
  }
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `_r := ${ecString(CREATED_MARKER)}`,
    ...[...bySpace].flatMap(([space, ids]) => [
      `list(${ids.map(id => ecString(id)).join(', ')}).forEach(_x:`,
      `${i1}_o := ${space}.get(_x)`,
      `${i1}IF _o != MISSING THEN`,
      `${i2}_c := str(_o.createdTime.whenMissing(""))`,
      `${i2}_r := _r + (${ecString(`\n${space} `)} + str(_x.size()) + ":" + _x + " " + str(_c.size()) + ":" + _c)`,
      // Not there: an empty time (the apply stopped before adding it).
      `${i1}ELSE`,
      `${i2}_r := _r + (${ecString(`\n${space} `)} + str(_x.size()) + ":" + _x + " 0:")`,
      `${i1}ENDIF`,
      ')',
    ]),
    `_r + ${ecString(`\n${CREATED_MARKER} end`)}`,
  ].join('\n');
}

/** The answer of createdTimesText: by lower-case address; empty for any
 *  other text. */
export function parseCreatedTimes(log: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = log.replace(/\r\n?/g, '\n');
  const at = text.indexOf(CREATED_MARKER);
  const end = text.indexOf(`\n${CREATED_MARKER} end`, at);
  if (at < 0 || end < 0) return out;
  let pos = at + CREATED_MARKER.length;
  while (pos < end && text[pos] === '\n') {
    const m = /([A-Za-z_][A-Za-z0-9_]*) (\d{1,9}):/y;
    m.lastIndex = pos + 1;
    const h = m.exec(text);
    const id = h ? sized(text, m.lastIndex, Number(h[2])) : null;
    const t = id ? framedAt(text, id.end) : null;
    if (!h || !id || !t) break;
    const a = addressOf(h[1], id.value);
    if (a) out.set(key(a), t.value);
    pos = t.end;
  }
  return out;
}

/** The types switched off in a types text (`<Class>;true&<Class>;false&…`). */
export function typesSwitchedOff(text: string | undefined): Set<string> {
  const off = new Set<string>();
  for (const item of (text ?? '').split('&')) {
    const [cls, on] = item.split(';').map(x => x.trim());
    if (cls && on?.toLowerCase() === 'false') off.add(cls);
  }
  return off;
}

/** A step's values in its project's text against a step's own text on the
 *  target: the same values, in any order. */
function sameArgs(args: string, targetText: string): boolean {
  const t = parseLine(targetText);
  const a = pairsOf(args), b = t ? pairsOf(withoutNeverCarried(t.args)) : null;
  if (!a || !b || a.length !== b.length) return false;
  const norm = (list: ReadonlyArray<{ name: string; value: string }>) => list.map(v => `${v.name.toLowerCase()}:=${v.value}`).sort().join('\n');
  return norm(a) === norm(b);
}

/** The per-class change statement of one class's values. */
const ownStatement = (address: string, o: { className: string; values: PatchValue[] }) => instanceChangeStatement(
  address, o.className,
  o.values.filter(v => v.action === 'set' || v.action === 'change').map(v => `${v.name} := ${v.source}`).join(', '),
  o.values.filter(v => v.action === 'clear').map(v => v.name),
);

/**
 * The Check of an object the target has, without its text: the size of its
 * generated text and the date it last changed (`str(lastModifiedDate)`, with
 * seconds) are those the comparison read. Measured: the date moves on every
 * write of a value of the object itself, not when a child is added or
 * deleted, nor when it is moved or its ID changes (its place is checked
 * apart). It does not notice a write in the same second as the write before
 * it that keeps the size of the text.
 */
function stateCheckStatement(address: string, size: number, date: string, short = false): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `IF ${address} = MISSING THEN`,
    `${i1}_r := _r + ${ecString(`\nMISSING now ${address}`)}`,
    `${i1}_dv := _dv + "."`,
    'ELSE',
    `${i1}_g := str(${address}.${short ? FILE_VALUES : 'genedit()'})`,
    `${i1}_d := str(${address}.lastModifiedDate.whenMissing(""))`,
    `${i1}IF _g.size() = ${size} AND _d = ${ecString(date)} THEN`,
    `${i2}_ok := _ok + "."`,
    `${i1}ELSE`,
    `${i2}_r := _r + ${ecString(`\nCHANGED since the comparison ${address}`)}`,
    `${i2}_dv := _dv + "."`,
    `${i1}ENDIF`,
    'ENDIF',
  ].join('\n');
}

/**
 * The Check of a flow project's links: its links text on the target is the
 * one the comparison read. Before any `genedit()` of the part (measured:
 * after `genedit()` of a FlowProject its `transLinks` hold one more link per
 * link without steps for the rest of the run).
 */
function flowCheckStatement(address: string, text: string): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `IF ${address} != MISSING THEN`,
    ...flowLinksEc(address).map(l => i1 + l),
    `${i1}IF _s = ${ecString(text)} THEN`,
    `${i2}_ok := _ok + "."`,
    `${i1}ELSE`,
    `${i2}_r := _r + ${ecString(`\nCHANGED links between steps since the comparison ${address}`)}`,
    `${i2}_dv := _dv + "."`,
    `${i1}ENDIF`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

/**
 * The removal of a property definition's link to one class (measured on
 * 5.6.17, committed: deleting the instance under the ClassConfig removes the
 * link; the property stays; `unlink` does not exist): only when the class,
 * the property and an instance linked to it are there. It removes what the
 * objects of that class hold in the property.
 */
export function unlinkStatement(address: string, className: string): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `_lc := c.get(${className}.name)`,
    `IF _lc != MISSING AND ${address} != MISSING THEN`,
    `${i1}_lx := str(_lc.id) + "." + str(${address}.id)`,
    `${i1}_li := k.get(_lx)`,
    `${i1}IF _li != MISSING AND _li.linkedTo != MISSING AND str(_li.linkedTo.id) = str(${address}.id) THEN`,
    `${i2}k.get(_lx).delete()`,
    `${i1}ELSE ""`,
    `${i1}ENDIF`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

/**
 * The removal of one link between steps that only the target has (measured
 * on 5.6.17, committed: `_i.delete()` inside `transLinks.forEach` deletes that
 * link, the steps and the other links stay). Never after `genedit()` of the
 * project in the same run (committed parts do not call it).
 */
export function flowUnlinkStatement(project: string, pair: string): string {
  const i1 = INDENT, i2 = INDENT.repeat(2);
  return [
    `IF ${project} != MISSING THEN`,
    `${i1}${project}.transLinks.forEach(_i:`,
    `${i2}_k := str(_i.from.id.whenMissing("")) + ">" + str(_i.to.id.whenMissing(""))`,
    `${i2}IF _k = ${ecString(pair)} THEN _i.delete() ELSE "" ENDIF`,
    `${i1})`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

/** Objects one Check loop holds at most (the part limit cuts between loops). */
const CHECK_LOOP = 50;

/** An ID that can stand in the keyed text of a Check loop. */
const LOOP_ID = { test: isLoopId };

/**
 * The Check of several objects of one ID space that the target has, in one
 * loop over their IDs (stateCheckStatement, without a block per object):
 * `_e` holds `|<ID>=<size>=<date>|` for each as the comparison read them,
 * and each object's own `|<ID>=<size>=<date>|` must be in it (measured
 * forms: `list("a", …).forEach(_x:`, `<space>.get(_x)`, `indexOf(…)
 * .whenMissing(-1)`). `short`: files whose content is not compared.
 */
function stateCheckLoop(space: string, items: ReadonlyArray<{ id: string; size: number; date: string }>, short: boolean, plain: boolean): string {
  const i1 = INDENT, i2 = INDENT.repeat(2), i3 = INDENT.repeat(3);
  return [
    `_e := ${ecString(`|${items.map(x => `${x.id}=${x.size}=${x.date}`).join('|')}|`)}`,
    `list(${items.map(x => ecString(x.id)).join(', ')}).forEach(_x:`,
    `${i1}_o := ${space}.get(_x)`,
    `${i1}IF _o = MISSING THEN`,
    `${i2}_r := _r + ${ecString('\nMISSING now ')} + ${shownAddressEc(space, plain)}`,
    `${i2}_dv := _dv + "."`,
    `${i1}ELSE`,
    `${i2}_g := str(_o.${short ? FILE_VALUES : 'genedit()'})`,
    `${i2}_k := "|" + _x + "=" + str(_g.size()) + "=" + str(_o.lastModifiedDate.whenMissing("")) + "|"`,
    `${i2}IF _e.indexOf(_k).whenMissing(-1) > -1 THEN`,
    `${i3}_ok := _ok + "."`,
    `${i2}ELSE`,
    `${i3}_r := _r + ${ecString('\nCHANGED since the comparison ')} + ${shownAddressEc(space, plain)}`,
    `${i3}_dv := _dv + "."`,
    `${i2}ENDIF`,
    `${i1}ENDIF`,
    ')',
  ].join('\n');
}

/** The line a Check part prints when the target still holds what the probe
 *  saw (and only then). */
export const CHECK_READY_LINE = 'Ready: nothing changed since the comparison. Continue with the next part.';
/** The Ready line of the Check of an undo. */
export const UNDO_READY_LINE = 'Ready: nothing changed since the apply. Continue with the next part.';

/** Does the answer of a Check part say Ready: one of its lines, trimmed, is
 *  exactly CHECK_READY_LINE (or UNDO_READY_LINE)? */
export function checkSaysReady(log: string): boolean {
  return log.split(/\r\n?|\n/).some(l => l.trim() === CHECK_READY_LINE || l.trim() === UNDO_READY_LINE);
}

/** The line BMP prints for a committed run that stored nothing (measured:
 *  a run that hits `error()` or a refused write). */
export const NO_CHANGES_LINE = 'No changes done due to errors';

/** Does the log of a committed run say that it stored nothing? */
export const storedNothing = (log: string): boolean => log.includes(NO_CHANGES_LINE);

function checkFrame(objects: number): PartFrame {
  return {
    before: [`_r := ${ecString(`Transport check (${objects} check${objects === 1 ? '' : 's'} in this part)`)}`, '_ok := ""', '_dv := ""'],
    after: [
      'IF _dv.size() = 0 THEN',
      `${INDENT}_r := _r + ${ecString(`\n${CHECK_READY_LINE}`)}`,
      'ELSE',
      `${INDENT}_r := _r + ${ecString('\nStop: the target changed since the comparison. Do not run the next parts; compare again.')}`,
      'ENDIF',
      '_r',
    ],
  };
}

/** The Record part's statements. */
function recordStatement(entryId: string, title: string, summary: string): string {
  const log = `t.${TRANSPORT_LOG_ID}`;
  const entry = `t.${entryId}`;
  return [
    `_l := ${log}`,
    'IF _l = MISSING THEN',
    `${INDENT}_l := root.portal.add(Category, id := ${ecSingleQuoted(TRANSPORT_LOG_ID)}, name := ${ecSingleQuoted(TRANSPORT_LOG_NAME)})`,
    'ELSE ""',
    'ENDIF',
    `IF ${entry} = MISSING THEN`,
    `${INDENT}_l.add(Category, id := ${ecSingleQuoted(entryId)}, name := ${ecSingleQuoted(title)}, description := ${ecSingleQuoted(summary)})`,
    'ELSE ""',
    'ENDIF',
  ].join('\n');
}

const WORD_ID = /^[A-Za-z0-9_]+$/;
/** A class name that may be written into a guard. */
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An enterprise record class (`CeRisk…`): never moved. */
const ENTERPRISE_CLASS = /^Ce[A-Z]/;

/** May the patch change the place of `p` (an object the target has)? Never
 *  for system objects (BMP refuses), property definitions (children of
 *  `root.property`) and enterprise records, nor without its parent read. */
function placeable(p: PreparedObject): boolean {
  return !p.input.systemObject && !neverMoved(p) && p.input.neighboursError == null && !!p.parentId
    && !(p.parentIsRoot && key(p.parentId) === 'property') && !ENTERPRISE_CLASS.test(p.className);
}

/** The guarded move of `address` to `parent`. */
export const moveStatement = (address: string, parent: string) => `IF ${address} != MISSING AND ${parent} != MISSING THEN ${address}.move(${parent}) ELSE "" ENDIF`;

/** The guarded ID change of a rename hint. */
export const renameStatement = (h: Pick<RenameHint, 'from' | 'to' | 'className'>) => `IF ${h.from} != MISSING AND ${h.to} = MISSING AND ${h.from}.className = ${ecSingleQuoted(h.className)} THEN ${h.from}.change(id := ${ecSingleQuoted(idOfAddress(h.to))}) ELSE "" ENDIF`;

/** The guarded delete of one object: of its class, not a system object
 *  (deleting one fails the whole run), under the parent the listing showed. */
const deleteStatement = (d: PatchDelete) => {
  const a = d.address;
  return `IF ${a} != MISSING AND ${a}.className = ${ecSingleQuoted(d.className)} AND ${a}.systemObject.whenMissing(false) = false AND ${a}.parent.id = ${ecSingleQuoted(d.parentId)} THEN ${a}.delete() ELSE "" ENDIF`;
};

/** The values of a changed object that the patch sets, as argument text
 *  (what references they hold). */
const setText = (x: Planned) => (x.wholeLine ? x.p.line.args : x.values.filter(v => v.action === 'set' || v.action === 'change').map(v => `${v.name} := ${v.source}`).join(', '));

// ── the listing: objects only the target has ────────────────────────

/** A listed object in the tree of the listing. */
interface ListedNode {
  o: ListedObject;
  /** Its ID, lower case. */
  key: string;
  /** Another listed object has the same ID. */
  dup: boolean;
  parent?: ListedNode;
  children: ListedNode[];
}

/** The listing as a tree by parent ID (without regard to case); objects
 *  directly under the listed object, or whose parent is not listed, have no
 *  parent. A repeated ID keeps its first object as the parent of the others'
 *  children; a cycle is cut. */
function listingTree(objects: readonly ListedObject[]): ListedNode[] {
  const nodes: ListedNode[] = objects.map(o => ({ o, key: key(o.id), dup: false, children: [] }));
  const byKey = new Map<string, ListedNode>();
  for (const n of nodes) {
    if (!n.key) continue;
    const first = byKey.get(n.key);
    if (first) { first.dup = true; n.dup = true; } else byKey.set(n.key, n);
  }
  for (const n of nodes) {
    const p = n.o.parentId ? byKey.get(key(n.o.parentId)) : undefined;
    if (p && p !== n) n.parent = p;
  }
  for (const n of nodes) {
    const seen = new Set<ListedNode>([n]);
    for (let a = n.parent; a; a = a.parent) {
      if (seen.has(a)) { n.parent = undefined; break; }
      seen.add(a);
    }
  }
  for (const n of nodes) n.parent?.children.push(n);
  return nodes;
}

/**
 * ID changes: a source object the target lacks (`missing`) and an object only
 * the target has (`only`) with the same class, the same parent ID (without
 * regard to case; or the target's parent is the old object of a pair whose
 * new ID is the source's parent) and the same name, one to one. Found in
 * rounds, so a pair under a pair is found after its parents. Both IDs must be
 * addressable, the name not empty; system objects and repeated IDs are not
 * paired. Deterministic: sources in address order, targets in listing order.
 */
function renameHints(missing: readonly PreparedObject[], only: readonly ListedNode[], off: ReadonlySet<string>): Array<RenameHint & { p: PreparedObject }> {
  const src = missing.filter(p => checkAddress(p.address).ok && !!p.name && CLASS_NAME.test(p.className) && !!p.parentId);
  const tgt = only.filter(n => !n.dup && !!addressOf('t', n.o.id) && !n.o.system && !!n.o.name && CLASS_NAME.test(n.o.className));
  const out: Array<RenameHint & { p: PreparedObject }> = [];
  const pairedS = new Set<PreparedObject>(), pairedT = new Set<ListedNode>();
  /** Old ID (lower case) → its hint. */
  const byOld = new Map<string, RenameHint>();
  for (;;) {
    const groups = new Map<string, { s: PreparedObject[]; t: ListedNode[] }>();
    const group = (k: string) => { let g = groups.get(k); if (!g) { g = { s: [], t: [] }; groups.set(k, g); } return g; };
    for (const p of src) if (!pairedS.has(p)) group(`${p.className.toLowerCase()}\u0000${key(p.parentId)}\u0000${p.name}`).s.push(p);
    for (const n of tgt) {
      if (pairedT.has(n)) continue;
      const via = byOld.get(key(n.o.parentId));
      group(`${n.o.className.toLowerCase()}\u0000${via ? key(idOfAddress(via.to)) : key(n.o.parentId)}\u0000${n.o.name}`).t.push(n);
    }
    let found = false;
    for (const g of groups.values()) {
      if (g.s.length !== 1 || g.t.length !== 1) continue;
      const [p] = g.s, [n] = g.t;
      const space = (checkAddress(p.address) as { space: string }).space;
      const hintKey = `${n.key}>${key(idOfAddress(p.address))}`;
      const via = byOld.get(key(n.o.parentId));
      const hint: RenameHint & { p: PreparedObject } = {
        key: hintKey, className: p.className, name: p.name!, from: addressOf(space, n.o.id), to: p.address, rid: p.input.rid,
        on: !off.has(hintKey) && (!via || via.on), ...(via ? { after: via.key } : {}), p,
      };
      out.push(hint);
      byOld.set(n.key, hint);
      pairedS.add(p);
      pairedT.add(n);
      found = true;
    }
    if (!found) return out;
  }
}

/**
 * The objects only the target has (`only`) as a tree, and what a patch that
 * deletes does with each: a top-most one (its parent is not only on the
 * target) is deleted with everything under it unless it must stay or
 * something under it must stay; then its own such children are looked at in
 * the same way. Must stay: a system object (deleting one fails the whole
 * run); an ID that cannot be addressed, is repeated
 * in the listing, or whose parent's ID cannot be written; and, below an
 * object to delete, any object that is not only on the target. `renamed`:
 * old ID (lower case) → new ID, for the parent ID a delete checks.
 */
function targetOnlyPlan(nodes: readonly ListedNode[], only: ReadonlySet<ListedNode>, listing: TargetListing, renamed: ReadonlyMap<string, string>, space: string): { list: TargetOnlyObject[]; deletes: PatchDelete[] } {
  const own = (n: ListedNode) => (n.o.system ? 'A system object' : '');
  const parentAfter = (n: ListedNode) => renamed.get(key(n.o.parentId)) ?? n.o.parentId;
  const addressable = (n: ListedNode) => !n.dup && !!addressOf(space, n.o.id) && CLASS_NAME.test(n.o.className) && !!addressOf(space, parentAfter(n));
  const stays = (n: ListedNode) => !only.has(n) || !!own(n);
  const staysBelowMemo = new Map<ListedNode, boolean>();
  const staysBelow = (n: ListedNode): boolean => {
    let v = staysBelowMemo.get(n);
    if (v == null) { v = n.children.some(c => stays(c) || staysBelow(c)); staysBelowMemo.set(n, v); }
    return v;
  };
  const sizeMemo = new Map<ListedNode, number>();
  const size = (n: ListedNode): number => {
    let v = sizeMemo.get(n);
    if (v == null) { v = n.children.reduce((s, c) => s + 1 + size(c), 0); sizeMemo.set(n, v); }
    return v;
  };
  const onlyMemo = new Map<ListedNode, number>();
  const onlyUnder = (n: ListedNode): number => {
    let v = onlyMemo.get(n);
    if (v == null) { v = n.children.reduce((s, c) => s + (only.has(c) ? 1 + onlyUnder(c) : 0), 0); onlyMemo.set(n, v); }
    return v;
  };
  const list: TargetOnlyObject[] = [];
  const deletes: PatchDelete[] = [];
  const entry = (n: ListedNode, depth: number, fate: TargetOnlyObject['fate'], reason?: string): TargetOnlyObject => ({
    id: n.o.id, name: n.o.name, className: n.o.className, address: !n.dup ? addressOf(space, n.o.id) : '',
    depth, under: onlyUnder(n), fate, ...(reason ? { reason } : {}),
  });
  const withIt = (n: ListedNode, depth: number) => {
    for (const c of n.children) { list.push(entry(c, depth, 'with')); withIt(c, depth + 1); }
  };
  const visit = (n: ListedNode, depth: number) => {
    const why = own(n) || (!addressable(n) ? (n.dup ? 'Its ID is not unique on the target' : 'Its ID cannot be addressed') : '')
      || (staysBelow(n) ? 'Something under it stays' : '');
    if (!why) {
      list.push(entry(n, depth, 'delete'));
      deletes.push({ address: addressOf(space, n.o.id), className: n.o.className, name: n.o.name, parentId: parentAfter(n), under: size(n) });
      withIt(n, depth + 1);
      return;
    }
    list.push(entry(n, depth, 'keep', why));
    for (const c of n.children) if (only.has(c)) visit(c, depth + 1);
  };
  for (const n of nodes) if (only.has(n) && !(n.parent && only.has(n.parent))) visit(n, 0);
  return { list, deletes };
}

/**
 * The patch for `inputs` against `probe` (parseProbeAnswer of buildProbe of
 * the same inputs; throws when the probe's key is another). Per object one
 * outcome: `create` when the target lacks it (new on the source or not),
 * `change` when the target has it with the same class and another text,
 * `move` when only its place differs, `same` when text and place are
 * identical; left out when the target holds another class there, when its
 * parent is neither on the target nor created by this patch, or for the
 * bundle's reasons. An address the carried objects refer to that the patch
 * does not carry and the target lacks is a warning (`outside-reference`).
 *
 * Places, for an object the target has (not a system object, a property
 * definition or an enterprise record): under another parent there (IDs
 * compared without regard to case), it is moved to its parent here (its
 * address, or `root.<name>`), when that is on the target or created by the
 * patch; otherwise it stays and a warning says so. Under the same parent,
 * it is re-placed when its neighbour differs: with a usable previous
 * sibling, when the target's previous sibling is another; else, with a
 * usable following sibling, when the target's next sibling is another. A
 * moved or created object is always placed. A sibling is usable when it is
 * created by the patch or is on the target under the parent the object will
 * have. So a target that already matches gives no move and no re-place.
 *
 * With a complete listing and `opts.sourceIds`: a listed object whose ID is
 * none of the source's is only on the target (targetOnly, a tree). One that
 * matches an object the target lacks is an ID change (renameHints); an
 * applied one is renamed in the Rename part, then treated as on the target
 * (its whole line set, placed as a created one), and is not only on the
 * target any more. With `opts.deleteExtra`, the Delete part deletes the
 * top-most objects only the target has that may go (targetOnlyPlan), each
 * guarded by class, system flag and parent ID; the Check part confirms the
 * number of objects under each.
 *
 * Parts, in order: Check (preview), Change ID, Add (parents first, and where
 * possible what is referred to before what refers to it: orderForAdd),
 * Change (objects the target has whose values differ, and added objects
 * whose create statement does not set all their values: createSetsValues),
 * Change again (added objects that refer to one added with or after them, or
 * in the same Add part when they are not changed, and objects whose changed
 * values refer to an added one), Move
 * (every `move` before any `moveAfter`/`moveBefore`, parents first), Delete,
 * Record (only with `opts.record`), Report (preview); committed parts start
 * with identity guards as in the bundle. With nothing to do, only the
 * Report. Objects are sorted by address: the same inputs, probe and options
 * give the same text.
 */
export function assemblePatch(inputs: readonly BundleInput[], probe: ProbeAnswer, opts: PatchOptions = {}): TransportPatch {
  const limit = opts.partLimit ?? BUNDLE_PART_LIMIT;
  const clearExtra = opts.clearExtra ?? true;
  const listing = probe.listing;
  const plan = probePlan(inputs, listing?.start);
  if (probe.key !== plan.key) throw new Error(`The answer (key ${probe.key}) is for another set of objects (key ${plan.key}): compare again.`);
  // The probed objects with their creation text: the same objects, in the same order.
  const prepared = prepareTransportInputs(inputs, false).prepared;
  const leftOut = [...plan.leftOut];
  const warnings = [...plan.warnings];
  const states = new Map(Object.entries(probe.states).map(([a, s]) => [key(a), s]));
  const stateOf = (a: string) => states.get(key(a));
  const present = (a: string) => stateOf(a)?.state === 'present';
  const leave = (p: PreparedObject, reason: LeftOutObject['reason'], detail: string) => leftOut.push({ rid: p.input.rid, id: p.input.id, className: p.input.className, address: p.address, reason, detail });

  // The listing: what only the target has.
  if (listing?.cut) warnings.push({ kind: 'listing', address: listing.start, detail: `The target has more than ${LISTING_CAP.toLocaleString('en-US')} objects under ${listing.start}, so objects only the target has are not looked at.` });
  const nodes = listing && !listing.missing && !listing.cut && opts.sourceIds ? listingTree(listing.objects) : [];
  // An object of the transport is never only on the target, whatever the listing says.
  const sourceIds = new Set([...(opts.sourceIds ?? []), ...inputs.map(i => i.id)].map(id => key(id)));
  const onlyAll = nodes.filter(n => !sourceIds.has(n.key));

  let planned: Planned[] = [];
  const missing: PreparedObject[] = [];
  const off = typesSwitchedOff(probe.types);
  const typesOff: Array<{ rid: string; address: string; className: string }> = [];
  for (const p of prepared) {
    const s = stateOf(p.address);
    if (!s) { leave(p, 'unreadable', 'The answer of the target says nothing about it.'); continue; }
    if (s.state === 'missing') { missing.push(p); continue; }
    if (s.className !== p.className) { leave(p, 'class-mismatch', `On the target ${p.address} is of class ${oneLine(s.className) || 'unknown'}.`); continue; }
    if (s.genedit == null) { leave(p, 'unreadable', 'The answer of the target has no text for it.'); continue; }
    // A property definition: its links here and on the target, as sets.
    let linked: Pick<Planned, 'links' | 'linksText' | 'targetLinks' | 'instancesText' | 'own' | 'flowLinks' | 'flowText' | 'targetSize' | 'targetDate'> = {};
    if (isLinkable(p)) {
      if (s.links == null || s.linksText == null) { leave(p, 'unreadable', 'The answer of the target has no links for it.'); continue; }
      if (!p.links) { leave(p, 'unreadable', p.input.creationError != null ? creationErrorDetail(p.input.creationError) : 'The text with its links could not be read.'); continue; }
      const here = new Set(p.links), there = new Set(s.links);
      // Its own values per class: compared without the `id`.
      const own = ownChanges(p.instances ?? [], classInstances(s.instancesText ?? '', idOfAddress(p.address)), p.links, clearExtra);
      linked = {
        links: { add: p.links.filter(c => !there.has(c)), targetOnly: s.links.filter(c => !here.has(c)), ...(opts.deleteExtra ? { remove: s.links.filter(c => !here.has(c)) } : {}) },
        linksText: s.linksText, targetLinks: s.links,
        ...(s.instancesText != null ? { instancesText: s.instancesText } : {}), ...(own.length ? { own } : {}),
      };
    }
    // A flow project: the links between its steps, as sets of pairs.
    if (p.flow) {
      if (s.flowText == null) { leave(p, 'unreadable', 'The answer of the target has no links between steps for it.'); continue; }
      const read = readFlowPairs(s.flowText);
      if (!read) {
        // A pair with an empty side: the target's links are unknown, nothing is added.
        linked = { ...linked, flowLinks: { add: [], targetOnly: [], unknown: true } };
      }
      const there = read ?? [];
      const thereKeys = new Set(there.map(x => x.toLowerCase()));
      const hereKeys = new Set(p.flow.links.map(l => flowPair(l).toLowerCase()));
      const add = p.flow.links.filter((l, i, all) => !thereKeys.has(flowPair(l).toLowerCase()) && all.findIndex(m => flowPair(m).toLowerCase() === flowPair(l).toLowerCase()) === i);
      if (read) linked = { ...linked, flowLinks: { add, targetOnly: there.filter(x => !hereKeys.has(x.toLowerCase())) }, flowText: s.flowText };
    }
    // Links to add or remove, own values per class, links between steps to add or remove.
    const toLink = !!linked.links?.add.length || !!linked.links?.remove?.length || !!linked.own?.length
      || !!linked.flowLinks?.add.length || (!linked.flowLinks?.unknown && !!linked.flowLinks?.targetOnly.length);
    const target = stripLikeServer(s.genedit);
    linked = { ...linked, targetSize: s.genedit.length, ...(s.modified != null ? { targetDate: s.modified } : {}) };
    if (target === p.text || comparableText(target) === comparableText(p.text)) {
      // The same values; a link to add makes it a change.
      planned.push({ p, outcome: toLink ? 'change' : 'same', target, values: (pairsOf(p.line.args) ?? []).map(v => ({ name: v.name, target: v.value, source: v.value, action: 'same' as const })), statements: [], ...linked });
      continue;
    }
    const values = diffValues(p.line, target, clearExtra);
    if (!values) {
      warnings.push({ kind: 'whole-line', rid: p.input.rid, address: p.address, detail: `${p.address}: its values could not be compared one by one, so all of them are changed and none is removed.` });
      planned.push({ p, outcome: 'change', target, values: (pairsOf(p.line.args) ?? []).map(v => ({ name: v.name, source: v.value, action: 'set' as const })), statements: [valueStatement(p)], wholeLine: true, ...linked });
      continue;
    }
    if (values.some(v => v.action === 'keep' && v.name.toLowerCase() !== 'id')) {
      warnings.push({ kind: 'kept-values', rid: p.input.rid, address: p.address, detail: `${p.address}: values only the target has are kept, so the report shows it as DIFFERENT.` });
    }
    planned.push({ p, outcome: 'change', target, values, statements: changeStatements(p.address, values), ...linked });
  }
  // ID changes: an object the target lacks that matches one only it has.
  const renames = renameHints(missing, onlyAll, opts.renamesOff ?? new Set());
  const renameOf = new Map(renames.filter(h => h.on).map(h => [h.p, h]));
  for (const p of missing) {
    const h = renameOf.get(p);
    const all = (pairsOf(p.line.args) ?? []).map(v => ({ name: v.name, source: v.value, action: 'set' as const }));
    if (h) {
      const { p: _p, ...hint } = h;
      planned.push({ p, outcome: 'change', values: all, statements: [valueStatement(p)], wholeLine: true, renamed: hint });
      continue;
    }
    if (p.input.linkedTo) { leave(p, 'linked-copy', linkedCopyDetail(p.input.linkedTo)); continue; }
    // A type switched off on the target: never added (objects under it
    // follow by the parent rule).
    if (off.has(p.className)) { leave(p, 'type-off', `Its type ${p.className} is switched off on ${opts.targetName ?? 'the target'}.`); typesOff.push({ rid: p.input.rid, address: p.address, className: p.className }); continue; }
    if (!p.create) {
      if (p.input.systemObject) leave(p, 'no-text', SYSTEM_OBJECT_DETAIL);
      else if (!isLinkable(p)) leave(p, 'unreadable', NO_PARENT_DETAIL);
      else if (p.input.creationError != null) leave(p, 'unreadable', creationErrorDetail(p.input.creationError));
      else leave(p, 'no-text', `BMP generates no text that adds an object of its class (${p.input.className}).`);
      continue;
    }
    // Added with its class links and its links between steps; its own values
    // per class follow in their own step.
    const own = p.links ? ownChanges(p.instances ?? [], [], p.links, false) : [];
    planned.push({
      p, outcome: 'create', values: all, statements: [], ...(p.links ? { links: { add: [...p.links], targetOnly: [] } } : {}),
      ...(own.length ? { own } : {}), ...(p.flow ? { flowLinks: { add: [...p.flow.links], targetOnly: [] } } : {}),
    });
  }
  // In address order, as the objects were prepared.
  const at = new Map(prepared.map((p, i) => [p, i]));
  planned.sort((a, b) => at.get(a.p)! - at.get(b.p)!);
  const renamedKeys = new Set(planned.filter(x => x.renamed).map(x => key(x.p.address)));
  // A created object whose parent is neither on the target nor created is
  // left out, and so in turn are its children.
  for (let again = true; again;) {
    again = false;
    const created = new Set(planned.filter(x => x.outcome === 'create').map(x => key(x.p.address)));
    planned = planned.filter(x => {
      if (x.outcome !== 'create') return true;
      const r = receiverOf(x.p);
      if (!r || isRootAddress(r) || present(r) || created.has(key(r)) || renamedKeys.has(key(r))) return true;
      leave(x.p, 'parent-missing', `Its parent ${r} is neither on the target nor added with this transport.`);
      again = true;
      return false;
    });
  }
  sortLeftOut(leftOut);
  // References to objects the patch does not carry that the target lacks.
  for (const r of outsideReferences(planned.map(x => refSource(x.p)))) {
    if (stateOf(r.address)?.state !== 'missing') continue;
    warnings.push({ kind: 'outside-reference', address: r.address, detail: `${r.address} is missing on the target and used by ${referrersText(r.by)}.` });
  }

  const byObject = new Map(planned.map(x => [x.p, x]));
  const isCreated = (p: PreparedObject) => byObject.get(p)?.outcome === 'create';
  const isRenamed = (p: PreparedObject) => !!byObject.get(p)?.renamed;
  /** Not where it will be on the target before the patch: created, or
   *  renamed (its place there is not known). */
  const appears = (p: PreparedObject) => isCreated(p) || isRenamed(p);
  const all = planned.map(x => x.p);
  const carried = new Map(all.map(p => [key(p.address), p]));
  const createdKeys = new Set(all.filter(isCreated).map(p => key(p.address)));
  const mismatched = new Set(leftOut.filter(o => o.reason === 'class-mismatch' && o.address).map(o => key(o.address!)));
  // Parents first, and where possible what is referred to before what refers to it.
  const creates = orderForAdd(all.filter(isCreated), p => p.address, receiverOf, p => p.line.args);
  for (const p of creates) if (p.input.neighboursError != null) warnings.push(noOrderWarning(p));
  const applied = planned.flatMap(x => (x.renamed ? [x.renamed] : []));

  // ── places ──
  /** Its place on the target, when the patch may change it. */
  const targetPlace = (x: Planned) => {
    if (x.outcome === 'create' || x.renamed || !placeable(x.p)) return undefined;
    const s = stateOf(x.p.address);
    return s?.state === 'present' && s.parentId != null && key(s.parentId) !== 'property' ? s : undefined;
  };
  /** Where `p` moves to: its parent here, when the target has it or the patch creates it. */
  const moveTarget = (p: PreparedObject): string | null => {
    if (p.parentIsRoot) {
      const root = rootAddressOf(p.parentId);
      if (!root) warnings.push({ kind: 'no-move', rid: p.input.rid, address: p.address, detail: `${p.address}: its parent here is the root ${oneLine(p.parentId)}, which these scripts do not address, so it stays where it is on the target.` });
      return root || null;
    }
    const a = p.parent;
    if (a && (createdKeys.has(key(a)) || renamedKeys.has(key(a)) || (present(a) && !mismatched.has(key(a))))) return a;
    warnings.push({ kind: 'no-move', rid: p.input.rid, address: p.address, detail: `${p.address}: its parent ${a || oneLine(p.parentId)} is neither on the target nor added with this transport, so it stays where it is on the target.` });
    return null;
  };
  const moves = new Map<PreparedObject, { from: string; to: string }>();
  for (const x of planned) {
    const s = targetPlace(x);
    if (!s || key(s.parentId!) === key(x.p.parentId)) continue;
    const to = moveTarget(x.p);
    if (to) moves.set(x.p, { from: s.parentId!, to });
  }
  /** The parent ID (lower case) the object at `address` has once the patch
   *  ran; undefined when it is not on the target then. */
  const parentAfter = (address: string): string | undefined => {
    const p = carried.get(key(address));
    if (p && (appears(p) || moves.has(p))) return key(p.parentId);
    const s = stateOf(address);
    return s?.state === 'present' && s.parentId != null ? key(s.parentId) : undefined;
  };
  /** A sibling `p` can be placed next to: on the target under the parent `p` will have. */
  const available: SiblingAvailable = (address, p) => (p.parentId ? parentAfter(address) === key(p.parentId) : present(address));
  const anchorOf = orderAnchors(all, appears, available);
  const replaced = new Set<PreparedObject>();
  for (const x of planned) {
    const s = targetPlace(x);
    if (!s || moves.has(x.p) || key(s.parentId!) !== key(x.p.parentId)) continue;
    const a = anchorOf(x.p);
    if (!a) continue;
    const have = a.method === 'moveAfter' ? s.previousId : s.nextId;
    if (key(have ?? '') !== key(idOfAddress(a.anchor))) replaced.add(x.p);
  }
  // Steps of flow projects and visibility rules are never moved.
  const order = orderStatements(all, appears, available, p => (appears(p) || moves.has(p) || replaced.has(p)) && !neverMoved(p));
  const moved = orderParentsFirst(all.filter(p => moves.has(p)), p => p.address, p => moves.get(p)!.to);

  const places = new Map<PreparedObject, PatchPlace>();
  const placeEntry = (p: PreparedObject) => { const e = places.get(p) ?? { labels: [] }; places.set(p, e); return e; };
  for (const p of moved) {
    const m = moves.get(p)!;
    Object.assign(placeEntry(p), { from: m.from, to: m.to }).labels.push(`moved from ${oneLine(m.from) || 'no parent'} to ${m.to}`);
  }
  for (const o of order) {
    if (isCreated(o.moved)) continue;
    Object.assign(placeEntry(o.moved), { method: o.method, anchor: o.anchor }).labels.push(`moved ${o.method === 'moveAfter' ? 'after' : 'before'} ${o.anchor}`);
  }
  for (const x of planned) if (x.outcome === 'same' && places.has(x.p)) x.outcome = 'move';

  // ── only on the target, and deletes ──
  const renamedOld = new Map(applied.map(h => [key(idOfAddress(h.from)), idOfAddress(h.to)]));
  const only = new Set(onlyAll.filter(n => !renamedOld.has(n.key)));
  const space = listing ? listing.start.slice(0, listing.start.indexOf('.')) : 't';
  const tree = listing && nodes.length ? targetOnlyPlan(nodes, only, listing, renamedOld, space) : { list: [], deletes: [] };
  const deletes = opts.deleteExtra ? tree.deletes : [];

  const changes = planned.filter(x => x.outcome === 'change' && x.statements.length);
  // Links to add to property definitions the target has, one per class.
  const toLink = planned.filter(x => x.outcome !== 'create' && x.links?.add.length);
  const guarded = (text: string, p: PreparedObject): PartUnit => ({ text, objects: 1, guards: [guardOf(p)] });
  // The links of property definitions the target has to their classes; then
  // the links between the steps of flow projects (a new project's too: its
  // steps are added in the Add part before, and an object added earlier in
  // a committed run may not resolve by address later in it).
  // Links between steps only the target has: removed first (no data in them).
  const flowRemovals = planned.filter(x => x.outcome !== 'create' && x.flowLinks && !x.flowLinks.unknown && x.flowLinks.targetOnly.length)
    .flatMap(x => x.flowLinks!.targetOnly.map(pair => guarded(flowUnlinkStatement(x.p.address, pair), x.p)));
  // Class links only on the target: removed with the delete switch, after the object deletes.
  const unlinks = planned.flatMap(x => (x.links?.remove ?? []).map(c => ({ x, className: c })));
  const links = [
    ...flowRemovals,
    ...toLink.flatMap(x => x.links!.add.map(c => guarded(linkStatement(x.p.address, c), x.p))),
    ...planned.flatMap(x => (x.flowLinks?.add ?? []).map(l => guarded(flowLinkStatement(x.p.address, l), x.p))),
  ];
  // The own values of linked properties per class, after the links.
  const own = planned.flatMap(x => (x.own ?? []).map(o => guarded(ownStatement(x.p.address, o), x.p)));
  const nothingToDo = !creates.length && !changes.length && !links.length && !own.length && !moved.length && !order.length && !applied.length && !deletes.length && !unlinks.length;
  const valueUnit = (x: Planned) => guarded(x.outcome === 'create' ? valueStatement(x.p) : x.statements.join('\n'), x.p);
  const createUnits = creates.map(p => ({ ...guarded(createStatement(p), p), ...uploadComment(p) }));
  // One write per object: an added object whose create statement sets
  // exactly its genedit() values (compared argument by argument) needs no
  // Change. Any other added object is changed after the Add, as before.
  const addOnly = new Set(creates.filter(p => createSetsValues(p.create!.statements[0], p.line.args)));
  const values = planned.filter(x => (x.outcome === 'create' ? !addOnly.has(x.p) : x.statements.length > 0)).map(valueUnit);
  // Again: added objects that refer to one added with or after them; an
  // added object that is not changed and refers to another one added in the
  // same Add part (one run: an object added earlier in a committed run may
  // not resolve by address later in it); and the objects whose changed
  // values refer to an added one.
  const later = refersToLaterAdded(creates, p => p.address, p => p.line.args);
  const addPart = new Map<string, number>();
  unitParts('Transport scripts', { step: 'create', spec: PATCH_STEPS.create, units: createUnits }, limit).forEach((part, i) => addPart.set(key(creates[i].address), part));
  const sameRun = (p: PreparedObject) => addOnly.has(p) && argumentReferences(p.line.args, p.address).some(a => addPart.has(key(a)) && addPart.get(key(a)) === addPart.get(key(p.address)));
  const again = planned.filter(x => (x.outcome === 'create' ? later.has(x.p) || sameRun(x.p) : x.statements.length > 0 && refersToAny(setText(x), x.p.address, createdKeys))).map(valueUnit);
  // What the committed parts rely on: the receivers, the parents moved to,
  // the anchors and the objects renamed on the target. One of the patch's
  // own objects is checked by its text already.
  const relied = new Map<string, string>();
  const rely = (a: string) => { if (a && !isRootAddress(a) && !carried.has(key(a))) relied.set(key(a), a); };
  for (const p of creates) rely(receiverOf(p));
  for (const p of moved) rely(moves.get(p)!.to);
  for (const o of order) rely(o.anchor);
  for (const h of applied) rely(h.from);
  /** Checked in a loop (stateCheckLoop): the target has it, its ID fits. */
  const inLoop = (x: Planned) => x.outcome !== 'create' && !x.renamed && x.targetSize != null && LOOP_ID.test(idOfAddress(x.p.address));
  const loopGroups = new Map<string, Array<{ id: string; size: number; date: string }>>();
  for (const x of planned.filter(inLoop)) {
    const at = splitAddress(x.p.address)!;
    const g = `${at.space}\u0000${isShort(x.p) ? 'S' : ''}\u0000${isPlainId(at.id) ? 'p' : 'g'}`;
    loopGroups.set(g, [...(loopGroups.get(g) ?? []), { id: at.id, size: x.targetSize!, date: x.targetDate ?? '' }]);
  }
  const checkLoops: PartUnit[] = [];
  for (const [g, items] of loopGroups) {
    const [space, short, plain] = g.split('\u0000');
    for (let i = 0; i < items.length; i += CHECK_LOOP) {
      const chunk = items.slice(i, i + CHECK_LOOP);
      checkLoops.push({ text: stateCheckLoop(space, chunk, short === 'S', plain === 'p'), objects: chunk.length, guards: [] });
    }
  }
  const checks: PartUnit[] = [
    // Before any genedit() of the part: it adds a temporary object.
    ...deletes.map(d => ({ text: checkStatement('delete', d.address, '', d.under), objects: 1, guards: [] as IdentityGuard[] })),
    // The links of flow projects, before any genedit() too.
    ...planned.filter(x => x.flowText != null && !x.renamed).map(x => ({ text: flowCheckStatement(x.p.address, x.flowText!), objects: 1, guards: [] as IdentityGuard[] })),
    ...planned.filter(x => !inLoop(x)).map(x => ({
      text: x.outcome === 'create' || x.renamed ? checkStatement('missing', x.p.address)
        : x.targetSize != null ? stateCheckStatement(x.p.address, x.targetSize, x.targetDate ?? '', isShort(x.p))
          : checkStatement('text', x.p.address, x.target, 0, isShort(x.p)),
      objects: 1, guards: [] as IdentityGuard[],
    })),
    // The others in loops of CHECK_LOOP per ID space.
    ...checkLoops,
    ...[...relied.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, a]) => ({ text: checkStatement('exists', a), objects: 1, guards: [] as IdentityGuard[] })),
    // The links of property definitions the target has.
    ...planned.filter(x => x.linksText != null && !x.renamed).map(x => ({ text: linksCheckStatement(x.p.address, x.linksText!, x.targetLinks ?? []), objects: 1, guards: [] as IdentityGuard[] })),
    // Their own values per class. (A flow project's links are in its text,
    // checked whole above.)
    ...planned.filter(x => x.instancesText != null && !x.renamed).map(x => ({ text: instancesCheckStatement(x.p.address, x.instancesText!), objects: 1, guards: [] as IdentityGuard[] })),
  ];

  // Steps of the flow projects that are not in the transport: needed where
  // the target lacks them or has them with other values.
  const stepsNeeded: string[] = [];
  const inside = new Set(prepared.map(p => key(p.address)));
  for (const p of prepared) for (const st of p.flow?.steps ?? []) {
    const a = addressOf('t', st.id);
    if (!a || inside.has(key(a)) || stepsNeeded.some(x => key(x) === key(a))) continue;
    const t = stateOf(a);
    if (t?.state === 'present' && t.genedit != null && sameArgs(st.args, t.genedit)) continue;
    stepsNeeded.push(a);
  }

  const review: PatchReviewObject[] = planned.map(x => ({
    rid: x.p.input.rid, address: x.p.address, className: x.p.className, isNew: x.p.input.isNew, ...(x.p.name != null ? { name: x.p.name } : {}),
    outcome: x.outcome, values: x.values, ...(x.wholeLine ? { wholeLine: true as const } : {}), ...(places.has(x.p) ? { place: places.get(x.p)! } : {}),
    ...(x.renamed ? { renamedFrom: x.renamed.from } : {}),
    ...(isShort(x.p) ? (x.outcome === 'create' ? { upload: true as const } : { contentNotCompared: true as const }) : {}),
    ...(x.links ? { links: { add: [...x.links.add], targetOnly: [...x.links.targetOnly], ...(x.links.remove?.length ? { remove: [...x.links.remove] } : {}) } } : {}),
    ...(x.flowLinks ? { flowLinks: { add: x.flowLinks.add.map(flowPair), targetOnly: [...x.flowLinks.targetOnly], ...(x.flowLinks.unknown ? { unknown: true as const } : {}) } } : {}),
    ...(x.own ? { own: x.own.map(o => ({ className: o.className, values: o.values })) } : {}),
  }));
  // Files added without their content: the person uploads them afterwards.
  const uploads = planned.filter(x => x.outcome === 'create').map(x => uploadOf(x.p)).filter((u): u is UploadFile => !!u);
  const count = (o: PatchOutcome) => planned.filter(x => x.outcome === o).length;
  const counts: PatchCounts = {
    create: count('create'), change: count('change'), move: count('move'), same: count('same'),
    rename: applied.length, delete: deletes.length, targetOnly: only.size, leftOut: leftOut.length,
  };
  const hints: RenameHint[] = renames.map(({ p: _p, ...h }) => h);

  let record: PartUnit | undefined;
  if (opts.record && !nothingToDo) {
    const { entryId } = opts.record;
    if (!WORD_ID.test(entryId)) throw new Error(`Not a transport log entry ID: ${entryId}`);
    const title = oneLine(opts.record.title).slice(0, 200) || entryId;
    const summary = (opts.record.summary ?? transportSummary({ review, leftOut, deletes, renames: hints, uploads })).slice(0, TRANSPORT_SUMMARY_LIMIT);
    record = { text: recordStatement(entryId, title, summary), objects: 1, guards: [{ address: `t.${TRANSPORT_LOG_ID}`, className: 'Category' }, { address: `t.${entryId}`, className: 'Category' }] };
  }

  // Only the objects the scripts add or change, each compared with its whole
  // text here; an object that is the same, or only moved, gets no line.
  const report: PartUnit[] = planned.filter(x => x.outcome === 'create' || x.outcome === 'change').map(x => ({ text: reportStatement(x.p.address, x.p.text, isShort(x.p)), objects: 1, guards: [] }));
  const units: Record<PatchStep, PartUnit[]> = nothingToDo
    ? { check: [], rename: [], create: [], set: [], link: [], own: [], setAgain: [], order: [], delete: [], record: [], report }
    : {
      check: checks,
      rename: applied.map(h => ({ text: renameStatement(h), objects: 1, address: h.to, guards: [{ address: h.from, className: h.className }, { address: h.to, className: h.className }] })),
      create: createUnits,
      set: values,
      link: links,
      own,
      setAgain: again,
      // Every move before any moveAfter or moveBefore.
      order: [...moved.map(p => guarded(moveStatement(p.address, moves.get(p)!.to), p)), ...order.map(o => guarded(o.text, o.moved))],
      delete: [
        ...deletes.map(d => ({ text: deleteStatement(d), objects: 1, guards: [{ address: d.address, className: d.className }] })),
        ...unlinks.map(u => guarded(unlinkStatement(u.x.p.address, u.className), u.x.p)),
      ],
      record: record ? [record] : [],
      report,
    };
  const frames: Partial<Record<PatchStep, StepInput<PatchStep>['frame']>> = { check: checkFrame, report: reportFrame };
  const rendered = renderParts('Transport scripts', PATCH_STEP_ORDER.map(step => ({ step, spec: PATCH_STEPS[step], units: units[step], frame: frames[step] })), limit);
  warnings.push(...rendered.warnings);
  const parts = rendered.parts;

  const objects: BundledObject[] = planned.map(x => ({
    rid: x.p.input.rid, address: x.p.address, className: x.p.className, isNew: x.p.input.isNew, ...(x.p.name != null ? { name: x.p.name } : {}),
  }));
  const notes = listing ? [opts.deleteExtra ? DELETE_NOTE_ON : DELETE_NOTE_OFF, ...PATCH_NOTES.slice(1)] : PATCH_NOTES;
  const n = planned.length;
  const extra = [
    counts.delete ? `${counts.delete} to delete` : '',
    counts.rename ? `${counts.rename} ID${counts.rename === 1 ? '' : 's'} to change` : '',
  ].filter(Boolean).map(t => `, ${t}`).join('');
  const lines = [
    `// Transport scripts (beta): ${n} object${n === 1 ? '' : 's'}: ${counts.create} to add, ${counts.change} to change, ${counts.move} to move, ${counts.same} the same${extra}; ${counts.leftOut} left out. ${parts.length} part${parts.length === 1 ? '' : 's'}.`,
    nothingToDo
      ? '// Nothing to do: the target already holds every object as it is here.'
      : `// Made from the comparison with key ${plan.key}. Run part 1 with Preview first; when it says Ready, run the next parts in order with Execute, then the report with Preview.`,
    ...notes.map(note => `// ${note}`),
    ...uploadLines(uploads),
    ...(deletes.length ? [`// To delete (${deletes.length}), each with everything under it:`, ...deletes.map(d => `//   ${d.address} (${d.className})${d.under ? `, ${d.under} under it` : ''}`)] : []),
    ...leftOutAndWarningLines(leftOut, warnings),
  ];
  const preamble = lines.join('\n') + '\n';
  return {
    parts, objects, leftOut, warnings, notes, preamble, text: [preamble, ...parts.map(p => p.text)].join('\n'), review, counts, key: plan.key, nothingToDo,
    renames: hints, targetOnly: tree.list, deletes, uploads, flowSteps: stepsNeeded,
    unlinks: unlinks.map(u => ({ address: u.x.p.address, className: u.className })), typesOff,
    linksOnlyOnTarget: planned.reduce((n, x) => n + (x.outcome !== 'create' ? x.links?.targetOnly.length ?? 0 : 0), 0),
    ...(listing ? { listing: { start: listing.start, state: listing.missing ? 'missing' as const : listing.cut ? 'cut' as const : 'ok' as const } } : {}),
  };
}

/** A property definition whose links a patch compares and adds: not a
 *  linked copy, not a system object. */
const isLinkable = (p: PreparedObject) => isPropertyDefinition(p.className, p.address) && !p.input.linkedTo && !p.input.systemObject;

/** The RIDs of the property definitions of `inputs` (objects the probe
 *  leaves out not counted), whose `generate(true)` text a patch needs for
 *  their links: on the target or not. In the order of `inputs`. Every other
 *  object is added from its values. */
export function propertyDefinitionRids(inputs: readonly BundleInput[]): string[] {
  const wanted = new Set(probePlan(inputs).prepared.filter(isLinkable).map(p => p.input.rid));
  return [...new Set(inputs.map(i => i.rid))].filter(rid => wanted.has(rid));
}

// ── the transport log ───────────────────────────────────────────────

/**
 * The ID of a transport log entry: `cc_tr_<YYYYMMDD>_<HHMM>_<6 characters
 * of key>`, the date in UTC; letters, digits and underscore only, so it can
 * be addressed as `t.<ID>`. Deterministic from its inputs. Throws for an
 * invalid date.
 */
export function transportEntryId(date: Date, key: string): string {
  if (Number.isNaN(date.getTime())) throw new Error('Not a date.');
  const p = (n: number) => String(n).padStart(2, '0');
  const k = (key.toLowerCase().replace(/[^a-z0-9]/g, '') + '000000').slice(0, 6);
  return `cc_tr_${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}_${p(date.getUTCHours())}${p(date.getUTCMinutes())}_${k}`;
}

/**
 * A plain text of a patch for its log entry, at most `limit` characters
 * (default TRANSPORT_SUMMARY_LIMIT): one line of counts, then the addresses
 * renamed (old → new), created, changed, moved, kept, deleted, the same and
 * left out (with the reason), one per line, a place that changes after its
 * address; when that is too long, cut before an address with a line "… and
 * <n> more".
 */
export function transportSummary(patch: Pick<TransportPatch, 'review' | 'leftOut'> & Partial<Pick<TransportPatch, 'deletes' | 'renames' | 'uploads'>>, limit = TRANSPORT_SUMMARY_LIMIT): string {
  const of = (o: PatchOutcome) => patch.review.filter(r => r.outcome === o).map(r => (r.place?.labels.length ? `${r.address} (${r.place.labels.join(', ')})` : r.address));
  const added = of('create'), changed = of('change'), moved = of('move'), same = of('same');
  const renamed = (patch.renames ?? []).filter(h => h.on).map(h => `${h.from} → ${h.to}`);
  const deleted = (patch.deletes ?? []).map(d => (d.under ? `${d.address} (and ${d.under} under it)` : d.address));
  const head = `Added ${added.length}, changed ${changed.length}, moved ${moved.length}, deleted ${deleted.length}, ID changed ${renamed.length}, the same ${same.length}, left out ${patch.leftOut.length}.`;
  const lines: Array<{ text: string; address: boolean }> = [{ text: head, address: false }];
  const group = (title: string, items: readonly string[]) => {
    if (!items.length) return;
    lines.push({ text: `${title}:`, address: false });
    for (const a of items) lines.push({ text: a, address: true });
  };
  group('Upload afterwards', (patch.uploads ?? []).map(uploadText));
  group('ID changed', renamed);
  group('Added', added);
  group('Changed', changed);
  group('Moved', moved);
  group('Deleted', deleted);
  group('The same', same);
  group('Left out', patch.leftOut.map(o => `${oneLine(o.address ?? o.id) || o.rid} (${oneLine(o.detail)})`));
  const full = lines.map(l => l.text).join('\n');
  if (full.length <= limit) return full;
  let text = head;
  for (let i = 1; i < lines.length; i++) {
    const rest = lines.slice(i).filter(l => l.address).length;
    const more = `\n… and ${rest} more`;
    const next = `${text}\n${lines[i].text}`;
    if (next.length + more.length > limit) return (text + more).slice(0, limit);
    text = next;
  }
  return text.slice(0, limit);
}
