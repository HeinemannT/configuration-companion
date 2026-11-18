/**
 * Connections resolver (service-worker side) — discovers an object's reference
 * relationships GENERICALLY from its class config and reads their current
 * endpoints. No hardcoded relationship table: this works on any workspace.
 *
 * Discovery reuses the (cached) type-schema props — each prop carries its
 * config kind. Forward refs (this → target) are ReferenceMethodConfig /
 * HistoricalReferenceMethodConfig; reverse refs (target → this) are
 * ReverseReferenceMethodConfig.
 *
 * Reading: every ref field is read via forEach — verified live to handle a
 * set single forward ref (one iteration), a multi-value forward ref (all
 * targets), a reverse ref (its back-reference list), and an unset ref
 * (no-op). So multiplicity needs no special-casing, and direction is purely
 * a display concern.
 *
 * The EC is built from the same proven atoms the rest of the codebase uses
 * (`.rid/.id/.name/.className.whenMissing("")`, the `_sep` block accumulator).
 */

import type { ConnTarget, ConnGroup, TypeSchemaProp } from './types';
import { appendRowEc, contextObjectEc, EC_CHUNK, EC_DONE_LITERAL, objectLoopEc, parseFramedLog, stableRidOrder, STATIC_EC_FRAME, type EcFrame } from './ec-parser';
import { isCodeProperty } from './ec-code-safety';
import { constantScript, scriptOn, varyingScript } from './script-kinds';

export type { ConnTarget, ConnGroup } from './types';

/** The schema-prop shape we read (a type's property config). Re-uses the
 *  cache/FETCH_TYPE_SCHEMA prop type so there's one source of truth. */
export type SchemaProp = TypeSchemaProp;

// ── Ref-field discovery from type-schema props ──────────────────────

/** A reference relationship field on a type. */
export interface RefField {
  accessor: string;
  label: string;
  direction: 'out' | 'in';
}

const FORWARD_REF_KINDS = new Set([
  'ReferenceMethodConfig',
  'HistoricalReferenceMethodConfig',
]);
const REVERSE_REF_KINDS = new Set([
  'ReverseReferenceMethodConfig',
]);

/** Pull the reference relationships out of a type's schema props. System
 *  props are kept — many real relationships (owner, master_reference) are
 *  system-defined — but obvious non-relationship system noise is excluded by
 *  the config-kind filter alone. */
export function refFieldsFromSchema(props: SchemaProp[]): RefField[] {
  const out: RefField[] = [];
  for (const p of props) {
    if (!p.accessor) continue;
    if (FORWARD_REF_KINDS.has(p.configClass)) {
      out.push({ accessor: p.accessor, label: humanize(p.accessor, p.label), direction: 'out' });
    } else if (REVERSE_REF_KINDS.has(p.configClass)) {
      out.push({ accessor: p.accessor, label: humanize(p.accessor, p.label), direction: 'in' });
    }
  }
  return out;
}

/** Prefer the config's own label; fall back to a de-snaked accessor. */
function humanize(accessor: string, label: string): string {
  const l = (label || '').trim();
  if (l) return l;
  return accessor.replace(/_/g, ' ');
}

// ── EC codegen ──────────────────────────────────────────────────────

/** Accessors are interpolated into EC source, so they must be safe identifiers
 *  (the schema only ever yields these, but defend the codegen boundary). */
/** A reference accessor: an identifier, never a code property (reading
 *  `_o.expression` would run it; ec-code-safety). */
function isSafeAccessor(a: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(a) && !isCodeProperty(a);
}

/** EC lines appending one framed row `[kind, key, rid, id, name, className]`
 *  (ec-parser length framing: names keep any character). */
const ROW = (acc: string, kind: string, key: string, v: string, indent: string) => appendRowEc(acc, [
  `"${kind}"`, key, `${v}.rid.whenMissing("")`, `${v}.id.whenMissing("")`, `${v}.name.whenMissing("")`, `${v}.className.whenMissing("")`,
], indent);

/** Declared reverse refs are loaded only on demand, but they still need hard
 * payload bounds: one relationship can point at thousands of objects and a
 * type can declare several such fields. The +1 emitted by the builder lets
 * the parser report truncation without a separate count query. */
export const REVERSE_REF_FIELD_CAP = 50;
export const REVERSE_REF_TOTAL_CAP = 100;

/**
 * Build the EC that reads every ref field's endpoint(s) for `ref`. Each field
 * emits a `{sep}f:<accessor>{sep}` header followed by zero or more
 * `rid|id|name|className` rows. Forward → 0/1 row (single accessor); reverse →
 * 0+ rows (forEach).
 */
export function buildConnectionsEc(ref: string, fields: RefField[], _frame: EcFrame = STATIC_EC_FRAME): string {
  const lines: string[] = [
    `_o := ${ref}`,
    '_r := ""',
    '_reverseN := 0',
  ];
  for (const f of fields) {
    if (!isSafeAccessor(f.accessor)) continue;
    // Read EVERY ref via forEach — verified live to iterate a set single
    // forward ref exactly once, a multi-value forward ref over all targets,
    // a reverse ref over its back-reference list, and to no-op on an unset
    // ref. One uniform read sidesteps both the single-vs-multi ambiguity and
    // EC's IF-is-an-expression rule (a guard block is a parse error).
    const key = `"${f.accessor}"`;
    if (f.direction === 'in') lines.push('_fieldN := 0');
    lines.push(`_o.${f.accessor}.forEach(_t:`);
    if (f.direction === 'in') {
      lines.push('     _fieldN := _fieldN + 1');
      lines.push('     _reverseN := _reverseN + 1');
      lines.push(`     IF _fieldN <= ${REVERSE_REF_FIELD_CAP + 1} AND _reverseN <= ${REVERSE_REF_TOTAL_CAP + 1} THEN`);
      lines.push(...ROW('_r', 'f', key, '_t', '          '));
      lines.push('     ELSE');
      lines.push('          _r := _r');
      lines.push('     ENDIF');
    } else {
      lines.push(...ROW('_r', 'f', key, '_t', '     '));
    }
    lines.push(`)`);
    if (f.direction === 'in') {
      lines.push(...appendRowEc('_r', ['"n"', key, '_fieldN', '""', '""', '""']));
    }
  }
  lines.push(`_r + ${EC_DONE_LITERAL}`);
  return scriptOn('buildConnectionsEc', ref, lines.join('\n'));
}

// ── Parsing ─────────────────────────────────────────────────────────

function parseRow(fields: string[]): ConnTarget | null {
  if (fields.length !== 4) return null;
  const rid = fields[0].trim();
  const id = fields[1].trim();
  const name = fields[2];
  const type = fields[3].trim();
  if (!rid) return null;
  // A ref whose target rid resolves but carries no identity is a dangling
  // pointer (deleted object) — flag it broken.
  const broken = !id && !name && !type;
  return { rid, businessId: id ?? '', name: name ?? '', type: type ?? '', broken: broken || undefined };
}

/**
 * Parse the EC output into connection groups, preserving the declared field
 * order/direction. `fields` drives which groups exist (so unset edges still
 * render); the log fills in their targets. Throws on a cut-off answer.
 */
export function parseConnections(log: string, fields: RefField[], frame: EcFrame = STATIC_EC_FRAME): ConnGroup[] {
  const byAccessor = new Map<string, ConnTarget[]>();
  const counts = new Map<string, number>();
  for (const [kind, accessor, ...rest] of parseFramedLog(log, frame, 6)) {
    if (kind === 'f') {
      const t = parseRow(rest);
      if (!t) continue;
      const list = byAccessor.get(accessor) ?? [];
      list.push(t);
      byAccessor.set(accessor, list);
    } else if (kind === 'n') {
      const count = Number(rest[0].trim());
      if (Number.isSafeInteger(count) && count >= 0) counts.set(accessor, count);
    }
  }

  return fields.map(f => {
    const rawTargets = byAccessor.get(f.accessor) ?? [];
    const targets = f.direction === 'in'
      ? rawTargets.slice(0, REVERSE_REF_FIELD_CAP)
      : rawTargets;
    const total = counts.get(f.accessor) ?? rawTargets.length;
    return {
      field: f.accessor,
      label: f.label,
      direction: f.direction,
      targets,
      ...(f.direction === 'in' && total > targets.length ? { capped: true } : {}),
    };
  });
}

// ── Junction inlining (C2) ──────────────────────────────────────────

/**
 * EC that reads the forward refs of a set of junction objects (e.g. the
 * CeWorkflows that mitigate a risk), so we can inline each junction's far side.
 * One loop over the junctions (ec-parser objectLoopEc); each target is a
 * `[j, junction rid, rid, id, name, className]` row.
 */
export function buildJunctionEc(rids: string[], forwardFields: RefField[], _frame: EcFrame = STATIC_EC_FRAME): string {
  const refs = stableRidOrder(rids.filter(rid => /^-?\d+$/.test(rid))).map(rid => `lookup(${rid})`); // rids are numeric; guard EC interpolation
  const body = ['_jid := str(_j.rid)'];
  for (const f of forwardFields) {
    if (!isSafeAccessor(f.accessor)) continue;
    body.push(`_j.${f.accessor}.forEach(_t:`, ...ROW(EC_CHUNK, 'j', '_jid', '_t', '     '), ')');
  }
  return varyingScript('buildJunctionEc', objectLoopEc(refs, '_j', body, 8).join('\n'));
}

/** The forward refs of the context junction: ONE constant script per field
 *  list, one command per junction (BmpClient.executeEcEach). Rows as
 *  buildJunctionEc. */
export function buildContextJunctionEc(forwardFields: RefField[]): string {
  const body = ['_jid := str(_j.rid)'];
  for (const f of forwardFields) {
    if (!isSafeAccessor(f.accessor)) continue;
    body.push(`_j.${f.accessor}.forEach(_t:`, ...ROW(EC_CHUNK, 'j', '_jid', '_t', '     '), ')');
  }
  return constantScript('buildContextJunctionEc', contextObjectEc('_j', body).join('\n'));
}

/** Parse the junction EC into a map of junction-rid → its forward-ref targets. */
export function parseJunctions(log: string, frame: EcFrame = STATIC_EC_FRAME): Map<string, ConnTarget[]> {
  const out = new Map<string, ConnTarget[]>();
  for (const [kind, rid, ...rest] of parseFramedLog(log, frame, 6)) {
    if (kind !== 'j') continue;
    const t = parseRow(rest);
    if (!t) continue;
    const list = out.get(rid.trim()) ?? [];
    list.push(t);
    out.set(rid.trim(), list);
  }
  return out;
}

/**
 * Pick a junction's far side: a forward ref whose target is neither the source
 * object (that edge is the back-reference we arrived through) nor the junction
 * itself. Returns undefined when the junction has no distinct far side.
 */
export function pickFarSide(sourceRid: string, junctionRid: string, fars: ConnTarget[]): ConnTarget | undefined {
  return fars.find(f => f.rid && f.rid !== sourceRid && f.rid !== junctionRid && !f.broken);
}

// ── Inbound scan ("referenced by", C3) ──────────────────────────────

/** Max inbound referrers surfaced — single source of truth for the server-side
 *  emission cap, the parser cap, and the "first N referrers shown" UI note, so
 *  they can never drift apart. */
export const INBOUND_CAP = 100;

/**
 * EC for the universal inbound scan: `rref()` returns every object that
 * references this one, regardless of whether a reverse ref is declared — so it
 * surfaces edges BMP's own UI can't (an undeclared inbound reference). One row
 * per referrer: rid|id|name|className.
 *
 * Emission is capped server-side at INBOUND_CAP+1 rows. `rref()` on a heavily-
 * referenced object (a shared property / common template / FileResource used
 * everywhere) can return thousands of referrers; without the cap the server
 * builds and transmits ALL of them only for the client to keep the first 100.
 * The forEach still iterates — `rref` has no early break — but only the bounded
 * concat/payload is paid (mirrors the siblings cap in buildObjectPaneEc). The
 * +1 lets parseInbound still flag "capped".
 */
export function buildInboundEc(ref: string, _frame: EcFrame = STATIC_EC_FRAME): string {
  return scriptOn('buildInboundEc', ref, [
    `_o := ${ref}`,
    '_r := ""',
    '_n := 0',
    '_o.rref().forEach(_t:',
    '     _n := _n + 1',
    `     IF _n <= ${INBOUND_CAP + 1} THEN`,
    ...ROW('_r', 'i', '""', '_t', '          '),
    '     ELSE',
    '          _r := _r',
    '     ENDIF',
    ')',
    // The total travels in its own row before the completion marker, so a
    // cut-off scan is an error.
    ...appendRowEc('_r', ['"n"', '_n']),
    `_r + ${EC_DONE_LITERAL}`,
  ].join('\n'));
}

/** Parse the inbound rows, capped (a heavily-referenced object can have many).
 *  `total` is the scan's own count. Throws when the completion marker is
 *  missing: the scan was cut off. */
export function parseInbound(log: string, cap = INBOUND_CAP, frame: EcFrame = STATIC_EC_FRAME): { targets: ConnTarget[]; capped: boolean; total?: number } {
  let rows: string[][];
  try { rows = parseFramedLog(log, frame); } catch { throw new Error('BMP returned an incomplete inbound scan (the answer was cut off)'); }
  const targets: ConnTarget[] = [];
  let capped = false;
  let total: number | undefined;
  for (const [kind, ...rest] of rows) {
    if (kind === 'n' && rest.length === 1) {
      const n = Number(rest[0].trim());
      if (Number.isInteger(n) && n >= 0) total = n;
      continue;
    }
    if (kind !== 'i' || rest.length !== 5) continue;
    const t = parseRow(rest.slice(1));
    if (!t) continue;
    if (targets.length >= cap) { capped = true; continue; }
    targets.push(t);
  }
  return { targets, capped, ...(total != null ? { total } : {}) };
}

// ── Instances of a template ─────────────────────────────────────────

/** Instances listed by name; the count is always complete. */
export const INSTANCE_LIST_CAP = 20;

/** EC that counts the objects linked to `ref` as their template and lists
 *  the first INSTANCE_LIST_CAP. One `t` row per instance, the count in `m`. */
export function buildInstancesEc(ref: string, _frame: EcFrame = STATIC_EC_FRAME): string {
  return scriptOn('buildInstancesEc', ref, [
    `_o := ${ref}`,
    '_l := _o.rref(linkedTo)',
    // One row per listed instance, joined once.
    `_x := _l.first(${INSTANCE_LIST_CAP}).calculate(`,
    '     _t := self',
    '     _row := ""',
    ...ROW('_row', 't', '""', '_t', '     '),
    '     _row',
    ')',
    '_s := _x.join("").whenMissing("")',
    ...appendRowEc('_s', ['"m"', '_l.size()']),
    `_s + ${EC_DONE_LITERAL}`,
  ].join('\n'));
}

/** Parse buildInstancesEc. Throws when the answer was cut off. */
export function parseInstances(log: string, frame: EcFrame = STATIC_EC_FRAME): { total: number; targets: ConnTarget[] } {
  const targets: ConnTarget[] = [];
  let total = 0;
  for (const [kind, ...rest] of parseFramedLog(log, frame)) {
    if (kind === 'm' && rest.length === 1) {
      const n = Number(rest[0].trim());
      if (Number.isInteger(n) && n >= 0) total = n;
    } else if (kind === 't' && rest.length === 5) {
      const t = parseRow(rest.slice(1));
      if (t && !t.broken) targets.push(t);
    }
  }
  return { total: Math.max(total, targets.length), targets };
}
