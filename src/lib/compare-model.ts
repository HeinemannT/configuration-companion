/**
 * Compare model: two objects side by side (src/diff/diff.ts draws it).
 *
 * Properties are compared on the full object read (lib/object-read.ts), in
 * the object window's sections, groups, order and labels
 * (lib/object-window-table.ts). A property that one read did not return is
 * "only in A / only in B" when both objects have the same type; for two
 * types it is listed as not comparable. Identity (RID, ID, created,
 * modified, location) is a fact about each side and never a difference.
 * Custom properties are matched by their definition (same definition RID,
 * else the same definition business ID, else the same definition name).
 *
 * Code is a line diff with the changed words marked inside changed lines;
 * whitespace-only differences can be ignored. Children are matched by
 * business ID, then by name and type.
 *
 * Pure: no DOM, no chrome.*. Values missing on older servers are simply
 * absent; nothing here throws on a partial read.
 */

import type { FullObject, ObjectSummary, PropValue } from './object-read';
import {
  EXPRESSIONS, HIDDEN_ROLES, ROLE_ORDER, blocksFor, isCustomKey, isDataObject, isEmptyValue, roleLabel, splitWords, tableLabel,
  typeInfo, type FieldDef,
} from './object-window-table';
import { diffSeq } from './line-diff';
import type { StructureNode, StructureTree } from './object-structure';

export type SideKey = 'a' | 'b';

// ── values ────────────────────────────────────────────────────────

export type CmpKind = 'text' | 'mono' | 'bool' | 'enum' | 'ref' | 'code';

export interface CmpValue {
  /** Display text ('' = not set). */
  text: string;
  /** Text the comparison uses (enum: its full value). */
  raw: string;
  empty: boolean;
  /** Reference targets (kind 'ref'). */
  rids?: string[];
  /** Short class name of a structured value without text. */
  cls?: string;
}

export interface CmpRow {
  /** Stable key: `p:<prop>`, `r:<role>` or `c:<defA>|<defB>`. */
  key: string;
  label: string;
  kind: CmpKind;
  /** null: the read of that side did not return the property. */
  a: CmpValue | null;
  b: CmpValue | null;
  equal: boolean;
  only?: SideKey;
  /** Code properties: the line diff. */
  code?: CodeDiff;
  /** Not Extended Code (no colouring). */
  plain?: boolean;
  /** Template plumbing between a template and its instance: shown, never
   *  counted as a difference. */
  template?: boolean;
}

export interface CmpGroup {
  /** '' for the single untitled group of a section. */
  title: string;
  rows: CmpRow[];
}

export interface CmpSection {
  title: string;
  groups: CmpGroup[];
}

export interface IdentityFacts {
  rid: string;
  businessId: string;
  name: string;
  type: string;
  created: string;
  modified: string;
  createdBy?: string;
  modifiedBy?: string;
  /** Parent rid (name through summaries). */
  parent?: string;
}

export interface PropertyCompare {
  sections: CmpSection[];
  /** Compared rows (both sides, or one side for the same type). */
  total: number;
  differ: number;
  sameType: boolean;
  /** Different types: labels of the properties only one type has. */
  notComparable: { a: string[]; b: string[] };
  identity: { a: IdentityFacts; b: IdentityFacts };
  /** One side is the template of the other (or both share one): the
   *  template plumbing rows are not counted. */
  templatePair: boolean;
}

export interface CompareOptions {
  /** Names and IDs of reference targets and custom property definitions. */
  summaries?: Readonly<Record<string, ObjectSummary>>;
  ignoreWhitespace?: boolean;
}

/** Identity and plumbing: facts about a side, never compared. */
const IDENTITY_PROPS = new Set(['id', 'uuid', 'fullPath', 'typeKey', 'simpleName', 'createdTime', 'lastModifiedDate', 'rid']);
const IDENTITY_ROLES = new Set(['parent', 'createdBy', 'lastModifiedBy', 'ownership', 'refresh', 'profileMappings']);

/** Enum display: `buttonType.EXPRESSION_TYPE` → "Expression type". A value
 *  in capitals with no separator (`TEMPLATECATEGORY`) cannot be split into
 *  its words reliably: it is shown as stored. */
export function enumText(raw: string): string {
  const tail = raw.split('.').pop() ?? raw;
  if (!tail) return '';
  if (/^[A-Z][A-Z0-9]+$/.test(tail)) return tail;
  return splitWords(tail);
}

/** Label of a property without a table label. Internal properties
 *  (`_templateLinkedTo`) keep their stored name. */
function rawLabel(prop: string): string {
  return prop.startsWith('_') ? prop : tableLabel(prop) ?? splitWords(prop);
}

/** Template plumbing: the link and the flags BMP sets on an instance and on
 *  the template it links to. */
const TEMPLATE_KEYS = new Set(['p:_templateLinkedTo', 'p:templateLinkedTo', 'p:link', 'p:model', 'r:linkedTo']);

/** One object is the template of the other, or both link to one template. */
export function isTemplatePair(a: FullObject, b: FullObject): boolean {
  const la = a.references.linkedTo?.[0], lb = b.references.linkedTo?.[0];
  return la === b.rid || lb === a.rid || (!!la && la === lb);
}

function propValue(v: PropValue, widget?: FieldDef['widget']): { kind: CmpKind; value: CmpValue } {
  const empty = isEmptyValue(v);
  if (v.kind === 'boolean' || widget === 'bool') {
    const on = v.bool ?? v.text === 'true';
    return { kind: 'bool', value: { text: on ? 'On' : 'Off', raw: String(on), empty: false } };
  }
  if (v.kind === 'code') return { kind: 'code', value: { text: v.text, raw: v.text, empty } };
  if (v.kind === 'unknown' && !v.text && v.cls) return { kind: 'mono', value: { text: '', raw: `@${v.cls}`, empty: false, cls: v.cls } };
  if (v.kind === 'enum' || widget === 'enum') return { kind: 'enum', value: { text: enumText(v.text), raw: v.text, empty } };
  const text = v.kind === 'list' ? (v.items ?? []).join(', ') : v.text;
  const mono = widget === 'mono' || widget === 'num' || v.kind === 'number';
  return { kind: mono ? 'mono' : 'text', value: { text, raw: text, empty } };
}

function refValue(rids: readonly string[]): CmpValue {
  return { text: '', raw: [...rids].join(','), empty: rids.length === 0, rids: [...rids] };
}

/** Whitespace-free form of code, for "ignore whitespace". */
export function squeezeWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

function valuesEqual(kind: CmpKind, a: CmpValue, b: CmpValue, ignoreWs: boolean): boolean {
  if (a.empty && b.empty) return true;
  if (kind === 'code' && ignoreWs) return squeezeWhitespace(a.raw) === squeezeWhitespace(b.raw);
  if (kind === 'ref') return [...(a.rids ?? [])].sort().join(',') === [...(b.rids ?? [])].sort().join(',');
  return a.raw === b.raw;
}

// ── slots: what one object shows, in the object window's order ────

interface Slot {
  section: string;
  group: string;
  key: string;
  label: string;
  kind: CmpKind;
  value: CmpValue;
  plain?: boolean;
  /** Custom property definition rid. */
  def?: string;
}

function customLabel(def: string, summaries: Readonly<Record<string, ObjectSummary>>): string {
  const s = summaries[def];
  return s ? (s.name || s.businessId || 'Custom property') : 'Custom property';
}

/** Everything one object shows, in order, as section › group › row. */
function slotsOf(obj: FullObject, summaries: Readonly<Record<string, ObjectSummary>>): Slot[] {
  const info = typeInfo(obj.type);
  const out: Slot[] = [];
  const used = new Set<string>();
  const addProp = (section: string, group: string, prop: string, label: string, widget?: FieldDef['widget']) => {
    const v = obj.props[prop];
    if (!v || used.has(`p:${prop}`)) return;
    used.add(`p:${prop}`);
    const { kind, value } = propValue(v, widget);
    out.push({ section, group, key: `p:${prop}`, label, kind, value, ...(EXPRESSIONS[prop]?.plain ? { plain: true } : {}) });
  };
  const addRef = (section: string, group: string, role: string, label: string) => {
    if (!(role in obj.references) || used.has(`r:${role}`)) return;
    used.add(`r:${role}`);
    out.push({ section, group, key: `r:${role}`, label, kind: 'ref', value: refValue(obj.references[role]) });
  };
  const addCustom = (section: string, group: string, def: string, isRef: boolean) => {
    const label = customLabel(def, summaries);
    if (isRef) {
      if (used.has(`r:${def}`)) return;
      used.add(`r:${def}`);
      out.push({ section, group, key: `r:${def}`, label, kind: 'ref', value: refValue(obj.references[def]), def });
    } else {
      if (used.has(`p:${def}`)) return;
      used.add(`p:${def}`);
      const { kind, value } = propValue(obj.props[def]);
      out.push({ section, group, key: `p:${def}`, label, kind, value, def });
    }
  };
  for (const p of IDENTITY_PROPS) used.add(`p:${p}`);
  for (const r of IDENTITY_ROLES) used.add(`r:${r}`);

  if (isDataObject(obj)) {
    // The object window's property list: Built-in, then Custom; references
    // are rows of the list.
    const builtin: Array<[string, string, boolean]> = [];
    const custom: Array<[string, boolean]> = [];
    for (const k of Object.keys(obj.props)) {
      if (isCustomKey(k)) custom.push([k, false]);
      else if (k !== 'name') builtin.push([k, rawLabel(k), false]);
    }
    for (const role of Object.keys(obj.references)) {
      if (HIDDEN_ROLES.test(role) || IDENTITY_ROLES.has(role) || role in obj.props) continue;
      if (isCustomKey(role)) custom.push([role, true]);
      else builtin.push([role, roleLabel(role), true]);
    }
    addProp('Properties', 'Built-in', 'name', 'Name');
    for (const [k, label, isRef] of builtin.sort((x, y) => x[1].localeCompare(y[1]))) {
      if (isRef) addRef('Properties', 'Built-in', k, label); else addProp('Properties', 'Built-in', k, label);
    }
    const lab = (k: string) => customLabel(k, summaries);
    for (const [k, isRef] of custom.sort((x, y) => lab(x[0]).localeCompare(lab(y[0])))) addCustom('Properties', 'Custom', k, isRef);
    return out;
  }

  const behaviour = () => {
    for (const p of blocksFor(info, obj)) {
      const gate = EXPRESSIONS[p]?.gate;
      if (gate && gate in obj.props) addProp('Behaviour', '', gate, tableLabel(gate) ?? splitWords(gate), 'bool');
      addProp('Behaviour', '', p, EXPRESSIONS[p]?.label ?? tableLabel(p) ?? splitWords(p));
    }
  };
  const curated = () => {
    let first = true;
    for (const g of info.groups) {
      if (g.title === 'Audit') continue;
      // Name is compared even where the pane shows it in the header only.
      if (first) { addProp('Properties', g.title, 'name', 'Name'); first = false; }
      for (const f of g.fields) {
        if (f.ref) addRef('Properties', g.title, f.ref, f.label);
        else if (f.prop) addProp('Properties', g.title, f.prop, f.label, f.widget);
      }
    }
  };
  if (info.settingsFirst) { curated(); behaviour(); } else { behaviour(); curated(); }
  if (info.layout) for (const f of info.layout.fields) if (f.prop) addProp(info.layout.title, '', f.prop, f.label, f.widget);
  // Code that the type table does not name stays with Behaviour.
  for (const k of Object.keys(obj.props)) {
    if (!isCustomKey(k) && obj.props[k].kind === 'code' && !used.has(`p:${k}`) && !/^use[A-Z]/.test(k)) {
      addProp('Behaviour', '', k, EXPRESSIONS[k]?.label ?? tableLabel(k) ?? splitWords(k));
    }
  }
  const rest = Object.keys(obj.props).filter(k => !used.has(`p:${k}`) && !isCustomKey(k))
    .map(k => [k, rawLabel(k)] as const).sort((x, y) => x[1].localeCompare(y[1]));
  for (const [k, label] of rest) addProp('All properties', k.startsWith('_') ? 'Technical' : '', k, label);
  const customKeys = [...Object.keys(obj.props).filter(isCustomKey).map(k => [k, false] as const),
    ...Object.keys(obj.references).filter(r => isCustomKey(r) && !(r in obj.props)).map(r => [r, true] as const)];
  for (const [k, isRef] of customKeys.sort((x, y) => customLabel(x[0], summaries).localeCompare(customLabel(y[0], summaries)))) {
    addCustom('All properties', 'Custom', k, isRef);
  }
  const rank = (r: string) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? ROLE_ORDER.length : i; };
  const roles = Object.keys(obj.references).filter(r => !HIDDEN_ROLES.test(r) && !used.has(`r:${r}`) && !isCustomKey(r))
    .sort((x, y) => rank(x) - rank(y) || roleLabel(x).localeCompare(roleLabel(y)));
  for (const r of roles) addRef('Relations', '', r, roleLabel(r));
  return out;
}

/** Pair custom definitions of A with those of B: same rid, then same
 *  definition business ID, then same definition name. Returns B def → A def. */
export function matchCustomDefinitions(
  aDefs: readonly string[], bDefs: readonly string[], summaries: Readonly<Record<string, ObjectSummary>>,
): Map<string, string> {
  const out = new Map<string, string>();
  const freeA = new Set(aDefs);
  for (const d of bDefs) if (freeA.has(d)) { out.set(d, d); freeA.delete(d); }
  for (const by of ['businessId', 'name'] as const) {
    for (const d of bDefs) {
      if (out.has(d)) continue;
      const want = summaries[d]?.[by];
      if (!want) continue;
      const hit = [...freeA].find(x => summaries[x]?.[by] === want);
      if (hit) { out.set(d, hit); freeA.delete(hit); }
    }
  }
  return out;
}

function identityOf(obj: FullObject): IdentityFacts {
  const t = (p: string) => obj.props[p]?.text ?? '';
  return {
    rid: obj.rid, businessId: obj.businessId, name: obj.name, type: obj.type,
    created: t('createdTime'), modified: t('lastModifiedDate'),
    ...(obj.references.createdBy?.[0] ? { createdBy: obj.references.createdBy[0] } : {}),
    ...(obj.references.lastModifiedBy?.[0] ? { modifiedBy: obj.references.lastModifiedBy[0] } : {}),
    ...(obj.references.parent?.[0] ? { parent: obj.references.parent[0] } : {}),
  };
}

/** Compare the properties of two full reads. */
export function compareProperties(a: FullObject, b: FullObject, opts: CompareOptions = {}): PropertyCompare {
  const summaries = opts.summaries ?? {};
  const ignoreWs = !!opts.ignoreWhitespace;
  const sameType = a.type === b.type;
  const sa = slotsOf(a, summaries);
  const sb = slotsOf(b, summaries);
  const defMap = matchCustomDefinitions(sa.flatMap(s => s.def ? [s.def] : []), sb.flatMap(s => s.def ? [s.def] : []), summaries);
  // B's key in A's terms: a matched custom definition takes A's key.
  const keyOfB = (s: Slot) => {
    if (!s.def) return s.key;
    const d = defMap.get(s.def);
    return d ? `${s.key.slice(0, 2)}${d}` : `${s.key}#b`;
  };
  const bByKey = new Map(sb.map(s => [keyOfB(s), s]));
  const aKeys = new Set(sa.map(s => s.key));

  const sections: CmpSection[] = [];
  const place = (section: string, group: string, row: CmpRow) => {
    let sec = sections.find(s => s.title === section);
    if (!sec) { sec = { title: section, groups: [] }; sections.push(sec); }
    let grp = sec.groups.find(g => g.title === group);
    if (!grp) { grp = { title: group, rows: [] }; sec.groups.push(grp); }
    grp.rows.push(row);
  };
  const notComparable = { a: [] as string[], b: [] as string[] };
  const rowOf = (key: string, x: Slot | undefined, y: Slot | undefined): CmpRow => {
    const base = (x ?? y)!;
    const kind: CmpKind = x && y && x.kind !== y.kind ? (x.kind === 'code' || y.kind === 'code' ? 'code' : 'text') : base.kind;
    const av = x?.value ?? null, bv = y?.value ?? null;
    const equal = !!av && !!bv && valuesEqual(kind, av, bv, ignoreWs);
    const label = x?.def && y?.def && x.label !== y.label ? `${x.label} / ${y.label}` : base.label;
    const row: CmpRow = { key: x && y && x.def && y.def && x.def !== y.def ? `c:${x.def}|${y.def}` : key, label, kind, a: av, b: bv, equal,
      ...(!x ? { only: 'b' as const } : !y ? { only: 'a' as const } : {}), ...(base.plain ? { plain: true } : {}) };
    if (kind === 'code' && av && bv && !equal) row.code = diffCode(av.raw, bv.raw, { ignoreWhitespace: ignoreWs });
    return row;
  };
  for (const s of sa) {
    const other = bByKey.get(s.key);
    if (!other && !sameType && !s.def) { notComparable.a.push(s.label); continue; }
    place(s.section, s.group, rowOf(s.key, s, other));
  }
  for (const s of sb) {
    const k = keyOfB(s);
    if (aKeys.has(k)) continue;
    if (!sameType && !s.def) { notComparable.b.push(s.label); continue; }
    place(s.section, s.group, rowOf(k, undefined, s));
  }
  // Rows only one side has are "different" for the same type; empty on the
  // other side is not a difference worth a row when both are empty.
  const templatePair = isTemplatePair(a, b);
  let total = 0, differ = 0;
  for (const sec of sections) for (const g of sec.groups) for (const r of g.rows) {
    if (r.only && (r.a ?? r.b)!.empty) r.equal = true;
    if (templatePair && TEMPLATE_KEYS.has(r.key) && !r.equal) { r.equal = true; r.template = true; }
    total++;
    if (!r.equal) differ++;
  }
  return { sections, total, differ, sameType, notComparable, identity: { a: identityOf(a), b: identityOf(b) }, templatePair };
}

/** Rows of a group that differ. */
export function differing(g: CmpGroup): CmpRow[] {
  return g.rows.filter(r => !r.equal);
}

/** "n of m differ" / "m equal". */
export function groupCount(rows: readonly CmpRow[]): { differ: number; total: number } {
  return { differ: rows.filter(r => !r.equal).length, total: rows.length };
}

// ── words ─────────────────────────────────────────────────────────

/** A changed character range [start, end). */
export type Range = readonly [number, number];

const TOKEN_RE = /\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;

function tokens(text: string): Array<{ s: number; e: number; t: string }> {
  const out: Array<{ s: number; e: number; t: string }> = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ s: m.index, e: m.index + m[0].length, t: m[0] });
  return out;
}

function merge(ranges: Array<[number, number]>): Range[] {
  const out: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** The changed parts of two texts, word by word. With `ignoreWhitespace`
 *  whitespace tokens are never marked. */
export function wordDiff(a: string, b: string, opts: { ignoreWhitespace?: boolean } = {}): { a: Range[]; b: Range[] } {
  let ta = tokens(a), tb = tokens(b);
  if (opts.ignoreWhitespace) { ta = ta.filter(t => t.t.trim()); tb = tb.filter(t => t.t.trim()); }
  const ra: Array<[number, number]> = [], rb: Array<[number, number]> = [];
  for (const op of diffSeq(ta, tb, t => t.t)) {
    if (op.op === '-') ra.push([ta[op.i].s, ta[op.i].e]);
    else if (op.op === '+') rb.push([tb[op.j].s, tb[op.j].e]);
  }
  // A lone whitespace token between two changed words joins them.
  const join = (rs: Array<[number, number]>, text: string) => {
    const out: Array<[number, number]> = [];
    for (const r of rs) {
      const last = out[out.length - 1];
      if (last && /^\s*$/.test(text.slice(last[1], r[0]))) last[1] = r[1];
      else out.push([r[0], r[1]]);
    }
    return merge(out);
  };
  return { a: join(ra, a), b: join(rb, b) };
}

// ── code ──────────────────────────────────────────────────────────

/** One row of a code diff. `eq`: same on both sides (with "ignore
 *  whitespace" the texts may still differ in whitespace); `ch`: a removed
 *  line paired with an added one; `del` / `add`: only on one side. */
export interface CodeRow {
  op: 'eq' | 'ch' | 'del' | 'add';
  /** 1-based line numbers. */
  na?: number;
  nb?: number;
  a?: string;
  b?: string;
  /** Changed word ranges in `a` / `b` (ch rows). */
  ra?: Range[];
  rb?: Range[];
  /** The line differs only in whitespace (ignored). */
  ws?: boolean;
}

export interface CodeDiff {
  rows: CodeRow[];
  added: number;
  removed: number;
  changed: number;
  linesA: number;
  linesB: number;
  /** The texts have no line in common: shown as plain A and B. */
  disjoint: boolean;
}

/** Share of the words two lines have in common (0 to 1). */
export function lineSimilarity(a: string, b: string): number {
  const ta = [...a.matchAll(TOKEN_RE)].map(m => m[0]).filter(t => t.trim());
  const tb = [...b.matchAll(TOKEN_RE)].map(m => m[0]).filter(t => t.trim());
  if (!ta.length && !tb.length) return 1;
  const common = diffSeq(ta, tb).filter(o => o.op === ' ').length;
  return common / Math.max(ta.length, tb.length);
}

/** A removed and an added line are shown as one changed line only when they
 *  share at least this much; otherwise as a removed and an added line. */
const PAIR_SIMILARITY = 0.4;

const splitLines = (t: string) => (t === '' ? [] : t.split('\n'));

/** Line diff of two code texts with changed words inside changed lines. */
export function diffCode(a: string, b: string, opts: { ignoreWhitespace?: boolean } = {}): CodeDiff {
  const la = splitLines(a), lb = splitLines(b);
  const ignore = !!opts.ignoreWhitespace;
  const key = ignore ? squeezeWhitespace : (l: string) => l;
  const ops = diffSeq(la, lb, key);
  const rows: CodeRow[] = [];
  let added = 0, removed = 0, changed = 0;
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.op === ' ') {
      rows.push({ op: 'eq', na: op.i + 1, nb: op.j + 1, a: la[op.i], b: lb[op.j], ...(la[op.i] !== lb[op.j] ? { ws: true } : {}) });
      k++;
      continue;
    }
    const dels: number[] = [], adds: number[] = [];
    while (k < ops.length && ops[k].op !== ' ') {
      const o = ops[k];
      if (o.op === '-') dels.push(o.i); else if (o.op === '+') adds.push(o.j);
      k++;
    }
    const pairs = Math.min(dels.length, adds.length);
    const lone: number[] = [], loneAdd: number[] = [];
    for (let p = 0; p < pairs; p++) {
      const ta = la[dels[p]], tb = lb[adds[p]];
      if (lineSimilarity(ta, tb) < PAIR_SIMILARITY) { lone.push(p); loneAdd.push(p); continue; }
      const w = wordDiff(ta, tb, { ignoreWhitespace: ignore });
      rows.push({ op: 'ch', na: dels[p] + 1, nb: adds[p] + 1, a: ta, b: tb, ra: w.a, rb: w.b });
      changed++;
    }
    for (const p of [...lone, ...Array.from({ length: dels.length - pairs }, (_, i) => pairs + i)]) {
      const ws = ignore && key(la[dels[p]]) === '';
      rows.push({ op: 'del', na: dels[p] + 1, a: la[dels[p]], ...(ws ? { ws: true } : {}) });
      if (!ws) removed++;
    }
    for (const p of [...loneAdd, ...Array.from({ length: adds.length - pairs }, (_, i) => pairs + i)]) {
      const ws = ignore && key(lb[adds[p]]) === '';
      rows.push({ op: 'add', nb: adds[p] + 1, b: lb[adds[p]], ...(ws ? { ws: true } : {}) });
      if (!ws) added++;
    }
  }
  // +n −m counts lines as git does: a changed line is one removed, one added.
  const disjoint = la.length > 0 && lb.length > 0 && !rows.some(r => r.op === 'eq' || r.op === 'ch');
  return { rows, added: added + changed, removed: removed + changed, changed, linesA: la.length, linesB: lb.length, disjoint };
}

/** Rows of a code diff with unchanged runs folded. A fold keeps `context`
 *  lines next to each change; `open` lists folds (by first row index) the
 *  user expanded. */
export type CodeView = Array<{ row: CodeRow; index: number } | { fold: number; count: number }>;

export function foldCode(rows: readonly CodeRow[], context = 3, open: ReadonlySet<number> = new Set()): CodeView {
  const quiet = (r: CodeRow) => r.op === 'eq' || !!r.ws;
  const keep = rows.map(r => !quiet(r));
  rows.forEach((r, i) => {
    if (quiet(r)) return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out: CodeView = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) { out.push({ row: rows[i], index: i }); i++; continue; }
    const start = i;
    while (i < rows.length && !keep[i]) i++;
    const count = i - start;
    // A fold of one or two lines saves nothing.
    // A short fold saves next to nothing.
    if (count < 6 || open.has(start)) for (let k = start; k < i; k++) out.push({ row: rows[k], index: k });
    else out.push({ fold: start, count });
  }
  return out;
}

// ── structure ─────────────────────────────────────────────────────

export interface StructRow {
  depth: number;
  a: StructureNode | null;
  b: StructureNode | null;
  /** How the pair was matched: one is the template of the other (or both
   *  share one), the same business ID, or the same name and type. */
  by?: MatchBy;
  status: 'same' | 'changed' | 'onlyA' | 'onlyB';
  /** Differing properties of a matched pair. */
  diffs: number;
  /** A pair whose sides are known by their row facts only: its property
   *  count is read lazily (the window reads the pair in full). */
  pending?: boolean;
  /** This row and every row below it are equal. */
  subtreeEqual: boolean;
  /** Index of the parent row (-1 for the roots). */
  parent: number;
}

export type MatchBy = 'same' | 'link' | 'id' | 'name';

export interface StructureCompare {
  rows: StructRow[];
  /** Child rows (the roots excluded). */
  total: number;
  differ: number;
  bySame: number;
  byLink: number;
  byId: number;
  byName: number;
  onlyA: number;
  onlyB: number;
  /** Pairs whose property count is not known yet. */
  pending: number;
  /** One root lies inside the other side's tree (an InputView and its own
   *  input set): the trees are compared from that node, and `anchor` names
   *  the side whose tree was entered there. */
  anchor?: { side: SideKey; rid: string };
}

type Kid = { node: StructureNode; obj: FullObject | null };

/** Pair two child lists: a template link first (an instance's `linkedTo`
 *  points at the template's child, or both point at the same one), then
 *  business ID, then name and type. Order follows A; B-only children stay
 *  next to the B neighbour before them. */
export function matchChildren(a: readonly Kid[], b: readonly Kid[]): Array<{ a: Kid | null; b: Kid | null; by?: MatchBy }> {
  const pairOfA = new Map<number, { j: number; by: MatchBy }>();
  const takenB = new Set<number>();
  const linkOf = (k: Kid) => k.obj?.references.linkedTo?.[0] ?? '';
  // The same object on both sides first.
  a.forEach((x, i) => {
    const j = b.findIndex((y, jj) => !takenB.has(jj) && y.node.rid === x.node.rid);
    if (j < 0) return;
    pairOfA.set(i, { j, by: 'same' });
    takenB.add(j);
  });
  a.forEach((x, i) => {
    if (pairOfA.has(i)) return;
    const j = b.findIndex((y, jj) => !takenB.has(jj) && (
      linkOf(y) === x.node.rid || linkOf(x) === y.node.rid || (!!linkOf(x) && linkOf(x) === linkOf(y))));
    if (j < 0) return;
    pairOfA.set(i, { j, by: 'link' });
    takenB.add(j);
  });
  const tryMatch = (by: MatchBy, keyOf: (k: Kid) => string) => {
    const free = new Map<string, number[]>();
    b.forEach((k, j) => {
      if (takenB.has(j)) return;
      const key = keyOf(k);
      if (!key) return;
      free.set(key, [...(free.get(key) ?? []), j]);
    });
    a.forEach((k, i) => {
      if (pairOfA.has(i)) return;
      const key = keyOf(k);
      const list = key ? free.get(key) : undefined;
      const j = list?.shift();
      if (j == null) return;
      pairOfA.set(i, { j, by });
      takenB.add(j);
    });
  };
  tryMatch('id', k => k.obj?.businessId ?? '');
  tryMatch('name', k => (k.obj?.name ? `${k.obj.type}\u0000${k.obj.name}` : ''));
  const out: Array<{ a: Kid | null; b: Kid | null; by?: MatchBy }> = [];
  let nextB = 0;
  const flushB = (upTo: number) => {
    for (; nextB < upTo; nextB++) if (!takenB.has(nextB)) out.push({ a: null, b: b[nextB] });
  };
  a.forEach((k, i) => {
    const m = pairOfA.get(i);
    if (!m) { out.push({ a: k, b: null }); return; }
    flushB(m.j);
    if (nextB <= m.j) nextB = m.j + 1;
    out.push({ a: k, b: b[m.j], by: m.by });
  });
  flushB(b.length);
  return out;
}

/** Compare two structure trees (lib/object-structure assembleStructure). */
export function compareStructure(ta: StructureTree, tb: StructureTree, opts: CompareOptions = {}): StructureCompare {
  const rows: StructRow[] = [];
  const count = (x: FullObject | null, y: FullObject | null) => (x && y ? compareProperties(x, y, opts).differ : 0);
  const kids = (t: StructureTree, n: StructureNode | null): Kid[] =>
    (n?.children ?? []).map(rid => t.nodes[rid]).filter(Boolean).map(node => ({ node, obj: node.obj }));
  const walk = (na: StructureNode | null, nb: StructureNode | null, depth: number, parent: number, by?: MatchBy): boolean => {
    const status: StructRow['status'] = !na ? 'onlyB' : !nb ? 'onlyA' : 'same';
    const pending = !!na?.obj && !!nb?.obj && (!!na.obj.lite || !!nb.obj.lite) && na.obj.rid !== nb.obj.rid;
    const diffs = na && nb && !pending ? count(na.obj, nb.obj) : 0;
    const row: StructRow = { depth, a: na, b: nb, ...(by ? { by } : {}), status: status === 'same' && diffs ? 'changed' : status, diffs, subtreeEqual: false, parent, ...(pending ? { pending: true } : {}) };
    const index = rows.length;
    rows.push(row);
    let equal = row.status === 'same' && !pending;
    if (na && nb) {
      for (const p of matchChildren(kids(ta, na), kids(tb, nb))) {
        if (!walk(p.a?.node ?? null, p.b?.node ?? null, depth + 1, index, p.by)) equal = false;
      }
    } else {
      // One-sided subtree: every node below is one-sided too.
      const t = na ? ta : tb;
      for (const k of kids(t, na ?? nb)) walk(na ? k.node : null, nb ? k.node : null, depth + 1, index);
      equal = false;
    }
    row.subtreeEqual = equal;
    return equal;
  };
  // The same object is never shown removed on one side and added on the
  // other: when one root is inside the other tree, start there.
  let anchor: StructureCompare['anchor'];
  let startA = ta.nodes[ta.rootRid] ?? null, startB = tb.nodes[tb.rootRid] ?? null;
  if (ta.rootRid !== tb.rootRid && ta.nodes[tb.rootRid]) { startA = ta.nodes[tb.rootRid]; anchor = { side: 'a', rid: tb.rootRid }; }
  else if (ta.rootRid !== tb.rootRid && tb.nodes[ta.rootRid]) { startB = tb.nodes[ta.rootRid]; anchor = { side: 'b', rid: ta.rootRid }; }
  walk(startA, startB, 0, -1, anchor ? 'same' : undefined);
  const children = rows.slice(1);
  return {
    rows,
    ...(anchor ? { anchor } : {}),
    total: children.length,
    differ: children.filter(r => r.status !== 'same').length,
    bySame: children.filter(r => r.by === 'same').length,
    byLink: children.filter(r => r.by === 'link').length,
    byId: children.filter(r => r.by === 'id').length,
    byName: children.filter(r => r.by === 'name').length,
    onlyA: children.filter(r => r.status === 'onlyA').length,
    onlyB: children.filter(r => r.status === 'onlyB').length,
    pending: children.filter(r => r.pending).length,
  };
}

/** What a side's read left out of the structure. */
export interface SideCoverage {
  /** Children beyond this count were not listed. */
  structureTruncatedAt?: number;
  /** The children could not be listed. */
  structureError?: string;
  /** Some children's names, types or markers could not be read. */
  rowFactsError?: unknown;
}

/** Say what a comparison covered, so "identical" is never read as more than
 *  it checked: "42 properties and 12 children compared." plus, when something
 *  was left out, "Not compared: 2 properties that exist on only one type;
 *  children beyond the first 5,000 of A." `left` is empty when nothing was. */
export function compareCoverage(
  props: Pick<PropertyCompare, 'total' | 'notComparable'>,
  struct: Pick<StructureCompare, 'total' | 'pending'> | null,
  sides: Partial<Record<SideKey, SideCoverage>> = {},
): { compared: string; left: string; complete: boolean } {
  const n = (c: number, one: string, many: string) => `${c.toLocaleString('en-US')} ${c === 1 ? one : many}`;
  const parts = [n(props.total, 'property', 'properties')];
  if (struct) parts.push(n(struct.total - struct.pending, 'child', 'children'));
  const compared = `${parts.join(' and ')} compared.`;
  const out: string[] = [];
  const only = props.notComparable.a.length + props.notComparable.b.length;
  if (only) out.push(`${n(only, 'property', 'properties')} that exist on only one type`);
  if (struct?.pending) out.push(`${n(struct.pending, 'child', 'children')} still being compared`);
  for (const k of ['a', 'b'] as const) {
    const s = sides[k];
    if (!s) continue;
    const name = k.toUpperCase();
    if (s.structureTruncatedAt) out.push(`children beyond the first ${s.structureTruncatedAt.toLocaleString('en-US')} of ${name}`);
    if (s.structureError) out.push(`the children of ${name} (could not be listed)`);
    if (s.rowFactsError) out.push(`some children of ${name} (could not be read)`);
  }
  return { compared, left: out.length ? `Not compared: ${out.join('; ')}.` : '', complete: !out.length };
}

/** Rows to draw: with `diffOnly`, runs of equal sibling subtrees fold into
 *  one line (named). Rows below a folded or collapsed row are hidden. */
export type StructView = Array<{ row: StructRow; index: number } | { equal: number[]; depth: number; key: string }>;

export function structView(rows: readonly StructRow[], diffOnly: boolean, open: ReadonlySet<string> = new Set()): StructView {
  const out: StructView = [];
  const hidden = new Set<number>();
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const key = `eq:${run[0]}`;
    if (open.has(key)) {
      // An opened run shows its rows with everything below them.
      for (const i of run) {
        out.push({ row: rows[i], index: i });
        for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) out.push({ row: rows[j], index: j });
      }
    } else out.push({ equal: [...run], depth: rows[run[0]].depth, key });
    run = [];
  };
  rows.forEach((r, i) => {
    if (r.parent >= 0 && hidden.has(r.parent)) { hidden.add(i); return; }
    if (diffOnly && i > 0 && r.subtreeEqual) {
      // Runs are siblings; a row of another parent ends the run.
      if (run.length && rows[run[0]].parent !== r.parent) flush();
      run.push(i);
      hidden.add(i);
      return;
    }
    flush();
    out.push({ row: r, index: i });
  });
  flush();
  return out;
}

// ── identity and suggestions ──────────────────────────────────────

/** A short "where" for a side: the parent's name. */
export function whereOf(obj: FullObject, summaries: Readonly<Record<string, ObjectSummary>>): string {
  const p = obj.references.parent?.[0];
  const s = p ? summaries[p] : undefined;
  return s ? (s.name || s.businessId) : '';
}

/** Rids a compare side wants named: reference targets, custom property
 *  definitions, the template and the parent. Identity plumbing (users) is
 *  named too; ACL roles are not. */
export function ridsToName(obj: FullObject): string[] {
  const out = new Set<string>();
  for (const k of Object.keys(obj.props)) if (isCustomKey(k)) out.add(k);
  for (const [role, rids] of Object.entries(obj.references)) {
    if (HIDDEN_ROLES.test(role) && role !== 'createdBy' && role !== 'lastModifiedBy') continue;
    if (role === 'ownership') continue;
    if (isCustomKey(role)) out.add(role);
    for (const r of rids.slice(0, 20)) out.add(r);
  }
  out.delete(obj.rid);
  return [...out];
}
