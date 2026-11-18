/**
 * Blast-radius queries for the blueprint apply-preview — PURE (builders + parsers, no I/O).
 *
 * Three questions the preview answers before the user commits, all driven by `rref()` (reverse
 * reference) against live BMP via the LayoutIO seam:
 *
 *   (A) INSTANCE FAN-OUT — is the page being edited a TEMPLATE MASTER? `page.rref(linkedTo)` returns
 *       the instances that inherit from it; non-empty ⇒ widget edits here propagate to all of them.
 *   (B) SHARED-STRUCTURE BLAST — a TabSet/Tab/Container is a single shared object (under PortalRoot),
 *       so a structural edit hits every page bound into it. For each touched container,
 *       `container.rref(container)` → the widgets → `widget.scorecard` → the distinct scorecards.
 *       Collapsed by TEMPLATE-FAMILY so a master and its own instances count as ONE thing (not N
 *       scary "places"); only families OTHER than the page's own are an external blast.
 *   (C) SHARED FORM DEFINITION — an EditPage or InputSet can itself be referenced by multiple
 *       views. Structural child edits therefore warn when the same definition is reused elsewhere.
 *
 * `name` is the LAST pipe field everywhere (free-text, parsed as the remainder) — a name containing
 * `|` can't shift the structural fields (same rule as the layout wire format). See
 * skills/bmp-platform/reference/template-instance-architecture.md.
 *
 * Note: `.scorecard` (the ModelAscender) resolves the owning Scorecard through an `rref` result;
 * `.ancestor(Scorecard)` does NOT in that context (returns MISSING) — verified live.
 */

import { buildRowEc } from '../ec-row-codec';
import { formatEcLiteral } from '../ec-guards';
import { userScript } from '../script-kinds';
import { markerLines, safeWireTextEc } from '../layout-wire';

const SEP = '<<<CREV_BLAST>>>';

export interface InstanceFanout {
  /** The page's template-family key: its linkedTo rid if it's an instance, else its own rid. */
  ownFamilyKey: string;
  /** True when other scorecards link to this page (it is a template master). */
  isMaster: boolean;
  /** The first INSTANCE_ROWS instances; `total` counts all of them. */
  instances: { rid: string; businessId?: string; name?: string }[];
  total: number;
}

/** Rows one probe returns per list. The counts are complete; only the listed rows are cut, so a
 *  template with thousands of pages costs one count and a short list. */
export const INSTANCE_ROWS = 20;
export const USAGE_ROWS = 300;

export interface SharedFamily {
  /** A representative scorecard rid for the family (the master if seen, else any member). */
  rid: string;
  name?: string;
  isMaster: boolean;
}

export interface ContainerBlast {
  /** Distinct template-families using the shared structure, EXCLUDING the page being edited. */
  otherFamilies: number;
  /** One representative page per other family (for the warning text). */
  families: SharedFamily[];
  /** A container has more users than the probe lists: other pages may use it unseen. */
  truncated?: boolean;
}

export interface FlowContainerProbe {
  id: string;
  className: 'InputSet' | 'EditPage';
  ref: string;
}

export interface FlowContainerBlast {
  sharedContainers: number;
  containers: Array<{
    id: string;
    className: 'InputSet' | 'EditPage';
    usages: Array<{
      rid: string;
      businessId?: string;
      name?: string;
      className?: string;
    }>;
  }>;
}

/** (A) Build the fan-out probe for the page being edited. Emits one SELF row (own rid + linkedTo)
 *  then one INST row per linking instance. */
export function buildInstanceFanoutEc(pageRef: string): string {
  const selfRow = buildRowEc([
    { name: 'rid', expr: '_p.rid.whenMissing("")' },
    { name: 'linkedTo', expr: '_p.linkedTo.rid.whenMissing("")' },
  ], '|');
  const instRow = buildRowEc([
    { name: 'rid', expr: '_i.rid.whenMissing("")' },
    { name: 'id', expr: '_i.id.whenMissing("")' },
    { name: 'name', expr: safeWireTextEc('_i.name.whenMissing("")') },
  ], '|');
  // Apply review (the Apply Session): part of the user's write, unchanged
  // by intent, so the user's kind (script-kinds.ts).
  return userScript([
    `_p := ${pageRef}`,
    // The count of all instances, and the first few as one row each, joined once.
    `_l := _p.rref(linkedTo)`,
    `_rows := _l.first(${INSTANCE_ROWS}).calculate(`,
    `     _i := self`,
    `     "${SEP}INST|" + ${instRow} + "\\n"`,
    `)`,
    `"${SEP}SELF|" + ${selfRow} + "\\n" + "${SEP}COUNT|" + str(_l.size()) + "\\n" + _rows.join("").whenMissing("")`,
  ].join('\n'));
}

export function parseInstanceFanout(log: string): InstanceFanout {
  let ownRid = '';
  let ownLinkedTo = '';
  const instances: InstanceFanout['instances'] = [];
  let count = 0;
  const seen = new Set<string>();
  for (const line of markerLines(log, SEP)) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts[0] === 'SELF') {
      ownRid = parts[1] ?? '';
      ownLinkedTo = parts[2] ?? '';
    } else if (parts[0] === 'COUNT') {
      const n = Number(parts[1]);
      if (Number.isInteger(n) && n >= 0) count = n;
    } else if (parts[0] === 'INST') {
      const rid = parts[1];
      if (!rid || seen.has(rid)) continue;
      seen.add(rid);
      instances.push({ rid, businessId: parts[2] || undefined, name: parts.slice(3).join('|') || undefined });
    }
  }
  const total = Math.max(count, instances.length);
  return { ownFamilyKey: ownLinkedTo || ownRid, isMaster: total > 0, instances, total };
}

/** (B) Build the shared-structure probe for the containers the plan touches. One rref(container)
 *  walk per container, emitting (scorecardRid | scorecardLinkedTo | scorecardName) rows. */
export function buildContainerBlastEc(containerRefs: string[]): string {
  const scRow = buildRowEc([
    { name: 'rid', expr: '_sc.rid.whenMissing("")' },
    { name: 'linkedTo', expr: '_sc.linkedTo.rid.whenMissing("")' },
    { name: 'name', expr: safeWireTextEc('_sc.name.whenMissing("")') },
  ], '|');
  const lines: string[] = ['_r := ""'];
  containerRefs.forEach((ref, i) => {
    lines.push(`_c${i} := ${ref}`);
    // One row per widget, joined once per container; a container used on very many pages is cut.
    lines.push(`_l${i} := _c${i}.rref(container)`);
    lines.push(`_x${i} := _l${i}.first(${USAGE_ROWS}).calculate(`);
    lines.push('     _w := self');
    lines.push('     _sc := _w.scorecard');
    lines.push(`     "${SEP}" + ${scRow} + "\\n"`);
    lines.push(')');
    lines.push(`_r := _r + _x${i}.join("").whenMissing("") + (IF _l${i}.size() > ${USAGE_ROWS} THEN "${SEP}MORE|" + "\\n" ELSE "" ENDIF)`);
  });
  lines.push('_r');
  return userScript(lines.join('\n'));
}

export function parseContainerBlast(log: string, ownFamilyKey: string): ContainerBlast {
  const byFamily = new Map<string, SharedFamily>();
  let truncated = false;
  for (const line of markerLines(log, SEP)) {
    if (!line) continue;
    const parts = line.split('|');
    const scRid = parts[0];
    if (scRid === 'MORE') { truncated = true; continue; }
    if (!scRid) continue;
    const linkedTo = parts[1] || '';
    const name = parts.slice(2).join('|') || undefined;
    const family = linkedTo || scRid; // instances collapse onto their master
    if (family === ownFamilyKey) continue; // the page's own template-family is not an external blast
    const existing = byFamily.get(family);
    // Prefer the master (linkedTo empty) as the family's representative + name.
    if (!existing || (!linkedTo && existing.isMaster === false)) {
      byFamily.set(family, { rid: scRid, name, isMaster: !linkedTo });
    }
  }
  return { otherFamilies: byFamily.size, families: [...byFamily.values()], ...(truncated ? { truncated: true } : {}) };
}

/** (C) Probe whether an edited InputSet/EditPage is referenced by more than
 * one InputView/CreateObjectView. These configuration objects are shared by
 * reference, so a child add/reorder/delete affects every referencing form. */
export function buildFlowContainerBlastEc(probes: FlowContainerProbe[]): string {
  const lines: string[] = ['_r := ""'];
  probes.forEach((probe, index) => {
    const property = probe.className === 'EditPage' ? 'editPage' : 'inputSet';
    const id = formatEcLiteral(probe.id);
    const className = formatEcLiteral(probe.className);
    lines.push(`_f${index} := ${probe.ref}`);
    lines.push(`_y${index} := _f${index}.rref(${property}).first(${USAGE_ROWS}).calculate(`);
    lines.push('     _w := self');
    lines.push(
      `     "${SEP}FLOW|${id}|${className}|" + _w.rid.whenMissing("") + "|" + _w.id.whenMissing("") + "|" + _w.className.whenMissing("") + "|" + ${safeWireTextEc('_w.name.whenMissing("")')} + "\\n"`,
    );
    lines.push(')');
    lines.push(`_r := _r + _y${index}.join("").whenMissing("")`);
  });
  lines.push('_r');
  return userScript(lines.join('\n'));
}

export function parseFlowContainerBlast(log: string): FlowContainerBlast {
  const byContainer = new Map<string, FlowContainerBlast['containers'][number]>();
  const seen = new Map<string, Set<string>>();
  for (const line of markerLines(log, SEP)) {
    if (!line.startsWith('FLOW|')) continue;
    const parts = line.split('|');
    const id = parts[1];
    const className = parts[2];
    const rid = parts[3];
    if (
      !id
      || (className !== 'InputSet' && className !== 'EditPage')
      || !rid
    ) continue;
    let container = byContainer.get(id);
    if (!container) {
      container = { id, className, usages: [] };
      byContainer.set(id, container);
      seen.set(id, new Set());
    }
    const containerSeen = seen.get(id)!;
    if (containerSeen.has(rid)) continue;
    containerSeen.add(rid);
    container.usages.push({
      rid,
      businessId: parts[4] || undefined,
      className: parts[5] || undefined,
      name: parts.slice(6).join('|') || undefined,
    });
  }
  const containers = [...byContainer.values()].filter(container => container.usages.length > 1);
  return { sharedContainers: containers.length, containers };
}
