/**
 * Atlas: which types of a workspace point at which, read from its reference
 * properties.
 *
 * An edge is one reference property on one class: the class that has the
 * property, the property, and the classes of the objects it holds. BMP only
 * names those classes on a plain reference (`types`); most references choose
 * their objects with an expression, so their target classes are the ones the
 * property is seen to hold on the class's objects (a sample, atlas-ec.ts).
 * A reference no object uses yet has no known target.
 *
 * Everything here is pure: the stored model, the routes between two types
 * and their order, and the Extended Code of a route.
 */

export interface AtlasType {
  /** The class name, as `SELECT` and `className` use it. */
  cls: string;
  /** The name BMP gives the class ("Enterprise risk assessment"). */
  name: string;
  /** Objects of the class. Absent when the class could not be read. */
  count?: number;
  /** Objects looked at for what the references hold: `count`, or the sample when the class has more. */
  seen?: number;
}

export interface AtlasEdge {
  from: string;
  /** The property's ID: the accessor in Extended Code. */
  prop: string;
  /** The property's name on that class. */
  label: string;
  multi: boolean;
  to: string[];
  /** The target classes are the property's own `types`, not observed. */
  declared: boolean;
  /** Of the `seen` objects of `from`, how many hold something in it. */
  filled?: number;
  /** A historical reference (HistoricalReferenceMethodConfig). */
  historical?: boolean;
  /** The property's `advanced` setting: its objects come from an expression. */
  advanced?: boolean;
}

/** A reverse reference property: a read-only list of the objects that point here through `forward`. */
export interface AtlasReverse { on: string; prop: string; label: string; forward: string }

export interface AtlasModel {
  types: Record<string, AtlasType>;
  edges: AtlasEdge[];
  reverses: AtlasReverse[];
  /** At most this many objects of a class were looked at for the classes a reference holds. */
  sample: number;
  /** Classes whose objects could not be read: their references have no observed target. */
  unread: string[];
}

/** "CeRiskAssessment" → "Ce risk assessment": a readable name for a class BMP gives none. */
export function plainClassName(cls: string): string {
  const words = cls.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ');
  return words.map((w, i) => (i === 0 ? w : w.toLowerCase())).join(' ');
}

/** The name BMP gives the class, in full ("Enterprise risk assessment"). */
export function fullTypeName(model: AtlasModel, cls: string): string {
  return model.types[cls]?.name || plainClassName(cls);
}

/** The name Atlas shows: BMP's, with "Enterprise" of an enterprise class cut to "CE" ("CE Risk Assessment"). */
export function typeName(model: AtlasModel, cls: string): string {
  const full = fullTypeName(model, cls);
  const m = /^Ce[A-Z]/.test(cls) ? /^Enterprise\s+(.+)$/.exec(full) : null;
  return m ? `CE ${m[1].replace(/(^|\s)([a-z])/g, (_x, sp: string, c: string) => sp + c.toUpperCase())}` : full;
}

export function aliasFor(model: AtlasModel, on: string, forward: string): string | undefined {
  return model.reverses.find(r => r.on === on && r.forward === forward)?.prop;
}

/** Every class the model knows, by name: the ones with references and the ones referenced. */
export function allTypes(model: AtlasModel): AtlasType[] {
  const seen = new Set<string>();
  for (const e of model.edges) { seen.add(e.from); for (const t of e.to) seen.add(t); }
  for (const cls of Object.keys(model.types)) seen.add(cls);
  return [...seen].map(cls => ({ cls, name: typeName(model, cls) })).sort((a, b) => a.name.localeCompare(b.name) || a.cls.localeCompare(b.cls));
}

/** Types whose name or class contains every word of `text`. */
export function findTypes(model: AtlasModel, text: string, limit = 30): AtlasType[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const all = allTypes(model);
  if (words.length === 0) return all.slice(0, limit);
  const hits = all.filter(t => { const hay = `${t.name} ${fullTypeName(model, t.cls)} ${t.cls}`.toLowerCase(); return words.every(w => hay.includes(w)); });
  const starts = (t: AtlasType) => (t.name.toLowerCase().startsWith(words[0]) || t.cls.toLowerCase().startsWith(words[0]) ? 0 : 1);
  return hits.sort((a, b) => starts(a) - starts(b)).slice(0, limit);
}

/** One step of a walked route: along a reference (`out`) or against it (`in`). */
export interface AtlasStep {
  dir: 'out' | 'in';
  prop: string;
  /** Against a reference: the reverse reference property that lists the same objects. */
  alias?: string;
}

const SAFE_PROP = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hop(receiver: string, step: AtlasStep, guard: boolean): string {
  if (!SAFE_PROP.test(step.prop) || (step.alias != null && !SAFE_PROP.test(step.alias))) throw new Error(`Not a property ID: ${step.alias ?? step.prop}`);
  if (step.dir === 'in' && !step.alias) return `${receiver}.rref(${step.prop})`;
  const read = `${receiver}.${step.dir === 'in' ? step.alias : step.prop}`;
  return guard ? `${read}.whenMissing(LIST())` : read;
}

/** Where a route starts: `this.object` on a page of the object and in the Extended Code window, `this` in an expression of the object's own property. */
export type AtlasStart = 'this.object' | 'this';

/**
 * The Extended Code that walks `steps` from `start`. One step is the plain
 * read. A longer route collects per object: a property read on a list gives
 * nothing, and `rref` on a list is empty, so each further step is a loop that
 * unions what every object holds.
 */
export function routeEc(steps: readonly AtlasStep[], start: AtlasStart = 'this.object'): string {
  if (steps.length === 0) return start;
  if (steps.length === 1) return hop(start, steps[0], false);
  const lines = [`_s1 := LIST().merge(${hop(start, steps[0], true)})`];
  for (let i = 1; i < steps.length; i++) {
    lines.push(`_s${i + 1} := LIST()`);
    lines.push(`_s${i}.forEach(_x: _s${i + 1} := _s${i + 1}.union(LIST().merge(${hop('_x', steps[i], true)})))`);
  }
  lines.push(`_s${steps.length}`);
  return lines.join('\n');
}

/** The short form of a step for the trail: `.controls`, or `rref(controls)` against a reference. */
export function stepLabel(step: AtlasStep): string {
  if (step.dir === 'out') return `.${step.prop}`;
  return step.alias ? `.${step.alias}` : `.rref(${step.prop})`;
}

/** One object, as a route row and the object Atlas was opened on show it. */
export interface AtlasObjectRef { rid: string; id: string; name: string; cls: string }

// ── Routes between two types ────────────────────────────────────

/** One way from a type to another: the classes it passes (start first) and the steps between them. */
export interface AtlasRoute {
  classes: string[];
  steps: AtlasStep[];
  /** How much of the route the data fills: the product of each step's share of filled objects (0 to 1). Null when a step was never counted. */
  fill: number | null;
  /** A step no object fills: the route gives nothing today. */
  empty: boolean;
  /** How often the route's properties are used in the server's code (the least used step). */
  used: number;
}

interface Hop { to: string; step: AtlasStep; share: number | null }

/**
 * Against a reference, how many objects of `cls` something points at is not
 * counted. The most it can be: the objects that fill the reference, spread
 * over the types it holds, as a share of the objects of `cls`.
 */
function shareAgainst(model: AtlasModel, e: AtlasEdge, cls: string): number | null {
  const count = model.types[cls]?.count, owner = model.types[e.from];
  if (e.filled == null || count == null) return null;
  if (e.filled === 0 || count === 0) return 0;
  // `filled` is of the objects looked at: scaled to the whole class.
  const scale = owner?.count != null && owner.seen ? owner.count / owner.seen : 1;
  return Math.min(1, e.filled * scale / Math.max(1, e.to.length) / count);
}

/** Every single step away from `cls`: along its own references and against the references that point at it. */
function hopsFrom(model: AtlasModel, cls: string): Hop[] {
  const hops: Hop[] = [];
  for (const e of model.edges) {
    const seen = model.types[e.from]?.seen;
    const share = e.filled != null && seen != null ? (seen > 0 ? e.filled / seen : 0) : null;
    if (e.from === cls) for (const to of e.to) hops.push({ to, step: { dir: 'out', prop: e.prop }, share });
    if (e.to.includes(cls)) {
      const alias = aliasFor(model, cls, e.prop);
      hops.push({ to: e.from, step: { dir: 'in', prop: e.prop, ...(alias ? { alias } : {}) }, share: shareAgainst(model, e, cls) });
    }
  }
  return hops;
}

export const routeKey = (r: Pick<AtlasRoute, 'classes' | 'steps'>): string => r.steps.map((s, i) => `${s.dir}:${s.prop}:${r.classes[i + 1]}`).join('>');

/**
 * The routes from `from` to `to` in one or two steps, in the order of
 * `rankRoutes`. A two-step route passes a third type, never one of its ends.
 * `usage` says how often a property is used in the server's code; without it
 * every route counts as unused.
 */
export function findRoutes(model: AtlasModel, from: string, to: string, usage: Readonly<Record<string, number>> = {}): AtlasRoute[] {
  const routes = new Map<string, AtlasRoute>();
  const add = (classes: string[], hops: Hop[]) => {
    const fill = hops.some(h => h.share == null) ? null : hops.reduce((n, h) => n * (h.share ?? 0), 1);
    const route: AtlasRoute = {
      classes, steps: hops.map(h => h.step), fill, empty: hops.some(h => h.share === 0),
      used: Math.min(...hops.map(h => usage[h.step.prop] ?? 0)),
    };
    routes.set(routeKey(route), route);
  };
  for (const first of hopsFrom(model, from)) {
    if (first.to === to) { add([from, to], [first]); continue; }
    // A way from a type to itself is only its own reference, never out and back.
    if (first.to === from || from === to) continue;
    for (const second of hopsFrom(model, first.to)) if (second.to === to) add([from, first.to, to], [first, second]);
  }
  return rankRoutes([...routes.values()]);
}

/**
 * The order routes are offered in: the shortest first; then the ones the data
 * fills most, in steps of a tenth, so that near-equal routes are told apart
 * by the next measure; then the ones the server's own code uses most. A
 * route that gives nothing today comes after every route of its length that
 * does.
 */
const tenth = (fill: number | null) => (fill == null ? -1 : Math.round(fill * 10));

export function rankRoutes(routes: readonly AtlasRoute[]): AtlasRoute[] {
  return [...routes].sort((a, b) =>
    a.steps.length - b.steps.length
    || Number(a.empty) - Number(b.empty)
    || tenth(b.fill) - tenth(a.fill)
    || b.used - a.used
    || (b.fill ?? -1) - (a.fill ?? -1)
    // All else equal, the route that reads along its references before the one that reads against them.
    || a.steps.filter(s => s.dir === 'in').length - b.steps.filter(s => s.dir === 'in').length
    || routeKey(a).localeCompare(routeKey(b)));
}

/** A route for a list: `controls › execution_performer`. */
export function routeLabel(route: Pick<AtlasRoute, 'steps'>): string {
  return route.steps.map(s => stepLabel(s).replace(/^\./, '')).join(' › ');
}

/** The types in the order of the grid: the ones that reference the most first, then by name. */
export function gridOrder(model: AtlasModel): string[] {
  const out = new Map<string, number>();
  for (const e of model.edges) out.set(e.from, (out.get(e.from) ?? 0) + e.to.length);
  return allTypes(model).map(t => t.cls).sort((a, b) => (out.get(b) ?? 0) - (out.get(a) ?? 0) || typeName(model, a).localeCompare(typeName(model, b)));
}

/** The references of `from` that hold `to`, the most filled first. */
export function edgesBetween(model: AtlasModel, from: string, to: string): AtlasEdge[] {
  return model.edges.filter(e => e.from === from && e.to.includes(to)).sort((a, b) => (b.filled ?? -1) - (a.filled ?? -1) || a.prop.localeCompare(b.prop));
}

/** "12 of 19", or "12 of the first 5,000" when only a part of the class was looked at. */
export function fillText(model: AtlasModel, edge: AtlasEdge): string {
  const t = model.types[edge.from];
  if (edge.filled == null || t?.seen == null) return '';
  return t.count != null && t.count > t.seen ? `${edge.filled} of the first ${t.seen.toLocaleString('en-US')}` : `${edge.filled} of ${t.seen}`;
}
