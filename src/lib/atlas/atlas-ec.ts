/**
 * The Extended Code Atlas reads with, and what it makes of the answers. All
 * of it is read-only (preview runs).
 *
 *  1. `buildAtlasPropertiesEc`: every reference property and the classes it
 *     is linked to. One fixed script.
 *  2. `buildAtlasHeldEc`: for one class, which classes a few of its
 *     references hold on up to ATLAS_SAMPLE of its objects. Extended Code has
 *     no way to name a class or a property from a value, so the class and
 *     the properties are in the text: one short script per class and group
 *     of properties, the same text on every read.
 *  3. `buildAtlasObjectEc`: the command's context object, its name and class.
 *  4. `buildAtlasRouteRowsEc`: the objects along one route.
 */
import { constantScript, varyingScript, SCRIPT_LIMITS } from '../script-kinds';
import type { AtlasEdge, AtlasModel, AtlasObjectRef, AtlasReverse, AtlasStep, AtlasType } from './model';

export const ATLAS_FIELD = '\u0001';
export const ATLAS_ROW = '\u0002';
const LINK_FIELD = '\u0003';
const LINK_ROW = '\u0004';
/**
 * Objects of one class looked at for what its references hold. Atlas's own
 * limit, not one of BMP: the read grows with objects times references
 * (measured: 864 objects with 123 references in 0.6 s), and every script of a
 * class selects the class again. This keeps a class of any size bounded.
 */
export const ATLAS_SAMPLE = 2000;
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const PROP_ID = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;
const F = ATLAS_FIELD, R = ATLAS_ROW;

export function buildAtlasPropertiesEc(): string {
  return constantScript('buildAtlasPropertiesEc', [
    '_m := root.property.descendants().filter(className = "ReferenceMethodConfig" OR className = "HistoricalReferenceMethodConfig" OR className = "ReverseReferenceMethodConfig")',
    // calculate(...).join(""), never one text grown row by row.
    '_r := _m.calculate(',
    '     _x := self',
    '     _l := LIST().merge(_x.rref(linkedTo)).calculate(',
    '          _k := self',
    `          _k.parent.id.whenMissing("") + "${LINK_FIELD}" + _k.parent.name.whenMissing("") + "${LINK_FIELD}" + _k.name.whenMissing("") + "${LINK_ROW}"`,
    '     )',
    `     _x.id.whenMissing("") + "${F}" + _x.name.whenMissing("") + "${F}" + _x.className + "${F}" + _x.multiselect.whenMissing("") + "${F}" + _x.types.whenMissing("") + "${F}" + _x.property.id.whenMissing("") + "${F}" + _l.join("") + "${F}" + _x.advanced.whenMissing("") + "${R}"`,
    ')',
    '_r.join("")',
  ].join('\n'));
}

export interface AtlasProperty {
  id: string;
  name: string;
  reverse: boolean;
  multi: boolean;
  /** The property's own `types`. */
  types: string[];
  /** A reverse reference: the reference it reads backwards. */
  forward?: string;
  historical?: boolean;
  advanced?: boolean;
  links: Array<{ cls: string; className: string; label: string }>;
}

const lastSegment = (fqn: string) => fqn.trim().split('.').pop() ?? '';

/** `[CeVendor, User]`, the text of a list of classes. */
function classList(text: string): string[] {
  return text.replace(/^\[|\]$/g, '').split(',').map(lastSegment).filter(c => CLASS_NAME.test(c));
}

export function parseAtlasProperties(log: string): AtlasProperty[] {
  const out: AtlasProperty[] = [];
  for (const row of log.split(R)) {
    const p = row.split(F);
    if (p.length < 7) continue;
    const id = p[0].replace(/^[\s\S]*\n/, '').trim();
    if (!PROP_ID.test(id)) continue;
    const links: AtlasProperty['links'] = [];
    for (const l of p[6].split(LINK_ROW)) {
      const [fqn, className, label] = l.split(LINK_FIELD);
      const cls = lastSegment(fqn ?? '');
      // A link sits under a class configuration, whose ID is the full class name.
      if (!fqn?.includes('.') || !CLASS_NAME.test(cls) || links.some(x => x.cls === cls)) continue;
      links.push({ cls, className: (className ?? '').trim(), label: (label ?? '').trim() });
    }
    const reverse = p[2].trim() === 'ReverseReferenceMethodConfig';
    const forward = p[5].trim();
    out.push({
      id, name: p[1].trim(), reverse, multi: p[3].trim() === 'true', types: classList(p[4]),
      ...(reverse && PROP_ID.test(forward) ? { forward } : {}), links,
      ...(p[2].trim() === 'HistoricalReferenceMethodConfig' ? { historical: true } : {}), ...((p[7] ?? '').trim() === 'true' ? { advanced: true } : {}),
    });
  }
  return out;
}

const heldLine = (prop: string) => [
  '_t := LIST()',
  `_s.forEach(_x: _t := _t.union(LIST().merge(_x.${prop}.whenMissing(LIST()))))`,
  `_o := _o + "${prop}${F}" + _t.as(className).distinct().join(",") + "${F}" + _s.calculate(_x := self  IF LIST().merge(_x.${prop}.whenMissing(LIST())).size() > 0 THEN 1 ELSE 0 ENDIF).sum() + "${R}"`,
].join('\n');

const heldHead = (cls: string) => `_q := LIST().merge(SELECT ${cls})\n_s := LIST().merge(_q.first(${ATLAS_SAMPLE}))\n_o := "#${F}" + _q.size() + "${F}" + _s.size() + "${R}"\n`;

/** The scripts that read which classes `props` of `cls` hold: as few as fit the limit of a script whose text varies. */
export function buildAtlasHeldEc(cls: string, props: readonly string[]): string[] {
  if (!CLASS_NAME.test(cls)) throw new Error(`Not a class name: ${cls}`);
  const scripts: string[] = [];
  let body: string[] = [];
  const flush = () => { if (body.length) scripts.push(varyingScript('buildAtlasHeldEc', `${heldHead(cls)}${body.join('\n')}\n_o`)); body = []; };
  for (const prop of [...props].sort()) {
    if (!PROP_ID.test(prop)) continue;
    const line = heldLine(prop);
    if (body.length && heldHead(cls).length + [...body, line].join('\n').length + 3 > SCRIPT_LIMITS.varying) flush();
    body.push(line);
  }
  flush();
  return scripts;
}

/** How many objects one class has: for a class that is only ever referenced, so no held read counts it. */
export function buildAtlasCountEc(cls: string): string {
  if (!CLASS_NAME.test(cls)) throw new Error(`Not a class name: ${cls}`);
  return varyingScript('buildAtlasCountEc', `_q := LIST().merge(SELECT ${cls})\n"#${F}" + _q.size() + "${F}" + _q.size() + "${R}"`);
}

export function parseAtlasHeld(log: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of log.split(R)) {
    const p = row.split(F);
    if (p.length < 2) continue;
    const prop = p[0].replace(/^[\s\S]*\n/, '').trim();
    if (!PROP_ID.test(prop)) continue;
    out[prop] = p[1].split(',').map(c => c.trim()).filter(c => CLASS_NAME.test(c));
  }
  return out;
}

/** What a held read counted: the objects of the class, how many were looked at, and per reference how many of those hold something. */
export interface AtlasHeldCounts { count?: number; seen?: number; filled: Record<string, number> }

export function parseAtlasHeldCounts(log: string): AtlasHeldCounts {
  const out: AtlasHeldCounts = { filled: {} };
  for (const row of log.split(R)) {
    const p = row.split(F);
    const key = p[0].replace(/^[\s\S]*\n/, '').trim();
    if (key === '#' && p.length >= 3) { out.count = Number(p[1]) || 0; out.seen = Number(p[2]) || 0; continue; }
    // An empty list sums to "NA".
    if (p.length >= 3 && PROP_ID.test(key)) out.filled[key] = Number(p[2]) || 0;
  }
  return out;
}

/**
 * Put the properties and what they were seen to hold together. `held` is
 * keyed by class, then property; a class in `unread` could not be read.
 */
export function assembleAtlasModel(
  properties: readonly AtlasProperty[], held: Record<string, Record<string, string[]>>, unread: readonly string[] = [],
  counts: Record<string, AtlasHeldCounts> = {},
): AtlasModel {
  const types: Record<string, AtlasType> = {};
  const edges: AtlasEdge[] = [];
  const reverses: AtlasReverse[] = [];
  for (const p of properties) {
    for (const link of p.links) {
      const c = counts[link.cls];
      if (link.className) types[link.cls] = { cls: link.cls, name: link.className, ...(c?.count != null ? { count: c.count } : {}), ...(c?.seen != null ? { seen: c.seen } : {}) };
      if (p.reverse) {
        if (p.forward) reverses.push({ on: link.cls, prop: p.id, label: link.label || p.name, forward: p.forward });
        continue;
      }
      const seen = held[link.cls]?.[p.id] ?? [];
      const to = [...new Set([...p.types, ...seen])].sort();
      edges.push({ from: link.cls, prop: p.id, label: link.label || p.name, multi: p.multi, to, declared: p.types.length > 0 && seen.every(x => p.types.includes(x)), ...(c?.filled[p.id] != null ? { filled: c.filled[p.id] } : {}), ...(p.historical ? { historical: true } : {}), ...(p.advanced ? { advanced: true } : {}) });
    }
  }
  // A class that is only referenced: BMP gives no name here, its count was read on its own.
  for (const [cls, c] of Object.entries(counts)) if (!types[cls] && c.count != null) types[cls] = { cls, name: '', count: c.count, seen: c.seen ?? c.count };
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.prop.localeCompare(b.prop));
  return { types, edges, reverses, sample: ATLAS_SAMPLE, unread: [...unread].sort() };
}

/** What stage 2 has to read: per class, the references whose target the property does not name. */
export function heldRequests(properties: readonly AtlasProperty[]): Array<{ cls: string; props: string[] }> {
  const by = new Map<string, string[]>();
  for (const p of properties) {
    if (p.reverse) continue;
    for (const link of p.links) by.set(link.cls, [...(by.get(link.cls) ?? []), p.id]);
  }
  return [...by].map(([cls, props]) => ({ cls, props: props.sort() })).sort((a, b) => a.cls.localeCompare(b.cls));
}

// ── One object ──────────────────────────────────────────────────

/** The command's context object: its RID, ID, name and class. One fixed text. */
export function buildAtlasObjectEc(): string {
  return constantScript('buildAtlasObjectEc', [
    '_s := this.object',
    `str(_s.rid) + "${F}" + _s.id.whenMissing("") + "${F}" + _s.name.whenMissing("") + "${F}" + _s.className + "${R}"`,
  ].join('\n'));
}

export function parseAtlasObject(log: string): AtlasObjectRef | null {
  for (const row of log.split(R)) {
    const p = row.split(F);
    if (p.length < 4) continue;
    const rid = p[0].replace(/^[\s\S]*\n/, '').trim();
    if (/^-?\d+$/.test(rid) && CLASS_NAME.test(p[3].trim())) return { rid, id: p[1].trim(), name: p[2].trim(), cls: p[3].trim() };
  }
  return null;
}

// ── The objects of a route ──────────────────────────────────────

/** Start objects of a route read at once, objects followed per step from each, and rows kept: at most START x FAN x FAN rows are answered. */
export const ATLAS_ROUTE_START = 100;
export const ATLAS_ROUTE_FAN = 10;
export const ATLAS_ROUTE_ROWS = 1000;

const hopRead = (receiver: string, step: AtlasStep): string => {
  if (!PROP_ID.test(step.prop) || (step.alias != null && !PROP_ID.test(step.alias))) throw new Error(`Not a property ID: ${step.alias ?? step.prop}`);
  if (step.dir === 'in' && !step.alias) return `${receiver}.rref(${step.prop})`;
  return `${receiver}.${step.dir === 'in' ? step.alias : step.prop}.whenMissing(LIST())`;
};

/**
 * One row per way through `steps`: every object on it with its RID, ID, name
 * and class. From the first ATLAS_ROUTE_START objects of `cls`, or from the
 * command's context object when `cls` is null. Read with nested
 * `calculate(...).join("")`, never one text grown row by row. The text
 * changes with the route, so it is a varying script and stays short.
 */
export function buildAtlasRouteRowsEc(cls: string | null, steps: readonly AtlasStep[]): string {
  if (cls != null && !CLASS_NAME.test(cls)) throw new Error(`Not a class name: ${cls}`);
  if (steps.length < 1 || steps.length > 2) throw new Error('A route has one or two steps');
  const cell = (v: string) => `str(${v}.rid) + "${F}" + ${v}.id.whenMissing("") + "${F}" + ${v}.name.whenMissing("") + "${F}" + ${v}.className + "${F}"`;
  const vars = steps.map((_, i) => `_x${i + 2}`);
  let inner = `${['_x1', ...vars].map(cell).join(' + ')} + "${R}"`;
  for (let i = steps.length - 1; i >= 0; i--) {
    const from = i === 0 ? '_x1' : vars[i - 1];
    inner = `LIST().merge(LIST().merge(${hopRead(from, steps[i])}).first(${ATLAS_ROUTE_FAN})).calculate(\n${vars[i]} := self\n${inner}\n).join("")`;
  }
  const start = cls == null ? 'LIST().merge(this.object)' : `LIST().merge(LIST().merge(SELECT ${cls}).first(${ATLAS_ROUTE_START}))`;
  return varyingScript('buildAtlasRouteRowsEc', `_a := ${start}\n_r := _a.calculate(\n_x1 := self\n${inner}\n)\n_r.join("")`);
}

/** The rows of a route. With `classes`, only the rows whose objects are of the route's types: a reference may hold several types, and `rref` gives referrers of any. */
export function parseAtlasRouteRows(log: string, width: number, classes?: readonly string[]): AtlasObjectRef[][] {
  const rows: AtlasObjectRef[][] = [];
  for (const raw of log.split(R)) {
    const p = raw.split(F);
    if (p.length < width * 4) continue;
    p[0] = p[0].replace(/^[\s\S]*\n/, '');
    const row: AtlasObjectRef[] = [];
    for (let i = 0; i < width; i++) row.push({ rid: p[i * 4].trim(), id: p[i * 4 + 1].trim(), name: p[i * 4 + 2].trim(), cls: p[i * 4 + 3].trim() });
    if (row.every((o, i) => /^-?\d+$/.test(o.rid) && (!classes || o.cls === classes[i]))) rows.push(row);
  }
  return rows;
}
