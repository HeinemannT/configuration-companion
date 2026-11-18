import { PBAC_ACTIONS, pbacActions, pbacEffect } from './pbac-syntax';
import { evaluateMatrixExpression, coverageStatus, conditionKinds, matrixTypeGraph, CONDITION_KINDS, EXCLUDED, DEFINITE, CONDITIONAL, UNRESOLVED, type ConditionKind } from './matrix-evaluation';
export { typeMatch, collectMatrixReferences } from './matrix-evaluation';
import type { PolicyJson } from './schema-model';
const list = (value: unknown): any[] => Array.isArray(value) ? value : [value];

export function matrixTypeGroup(type: string): string {
  if (['Scorecard', 'Organisation'].includes(type)) return 'Structure';
  if (/^Ce[A-Z]/.test(type)) return 'Enterprise objects';
  if (/^(ActionButton|InputView|ButtonInput|Tab|Container|Widget|Page|Layout|.*View|.*Widget|.*Input|.*Table)$/.test(type)) return 'Interface objects';
  return 'Other types';
}
// Four bits per evidence class (CRUD): definite (bits 0-3), not readable (4-7), then one
// class per kind of condition (8 + 4 * kind). Only Allow statements are indexed: the engine is
// grant-only, so a Deny statement grants nothing and blocks nothing and has no mark.
// Summaries contain no duplicated rules; details are resolved only on inspection.
const summaries = new Map<number, MatrixSummary>();
export interface MatrixSummary {
  actions: string[]; conditionalActions: string[]; conditional: boolean; unresolvedActions: string[];
  unresolved: boolean; hasCoverage: boolean;
  /** Per conditional operation, the kinds of condition it hangs on. */
  kinds: Record<string, ConditionKind[]>;
}
function summaryFrom(bits: number): MatrixSummary {
  if (summaries.has(bits)) return summaries.get(bits) as MatrixSummary;
  const kindsAt = (i: number) => CONDITION_KINDS.filter((_, k) => bits & 1 << (8 + 4 * k + i));
  const actions = PBAC_ACTIONS.filter((_, i) => bits & 1 << i || kindsAt(i).length);
  const conditionalActions = PBAC_ACTIONS.filter((_, i) => !(bits & 1 << i) && kindsAt(i).length);
  const unresolvedActions = PBAC_ACTIONS.filter((_, i) => bits & 1 << (i + 4));
  const kinds = Object.fromEntries(conditionalActions.map(a => [a, kindsAt(PBAC_ACTIONS.indexOf(a))]));
  const result = { actions, conditionalActions, conditional: !!conditionalActions.length,
    unresolvedActions, unresolved: !!unresolvedActions.length,
    hasCoverage: !!actions.length, kinds };
  summaries.set(bits, result); return result;
}
function bitsFor(status: number, i: number, kinds: readonly ConditionKind[] = []): number {
  if (!status) return 0;
  if (status === DEFINITE) return 1 << i;
  if (status === UNRESOLVED) return 1 << (i + 4);
  return kinds.reduce((bits, kind) => bits | 1 << (8 + 4 * CONDITION_KINDS.indexOf(kind) + i), 0);
}
/** The row for what statements grant without naming a type: a statement with no type test, or
 *  the branch of one that has none. It applies to every type. */
export const ANY_TYPE = '*';
function hasActorPredicate(v: PolicyJson): boolean {
  return !!v && typeof v === 'object' && (Object.hasOwn(v, 'HasRole') || Object.values(v).some(hasActorPredicate));
}
function actorSignature(v: PolicyJson, roleIds?: Set<string>): string {
  if (!v || typeof v !== 'object') return '';
  if (v.HasRole) return Array.isArray(v.HasRole.Roles) && v.HasRole.Roles.length ? String(v.HasRole.Roles.some((id: string) => roleIds?.has(id))) : '?';
  return Object.values(v).map(child => actorSignature(child, roleIds)).join('');
}

/** Immutable saved-snapshot + metadata index. Share type facts across roles,
 * keep actor-dependent expressions separate, and bound inspector allocations. */
export function createMatrixIndex(model: PolicyJson, classes: Record<string, unknown>, fallbackChildren: Record<string, string[]> = {}, metadata?: PolicyJson) {
  const children = matrixTypeGraph(metadata, fallbackChildren);
  const rules: PolicyJson[] = [], types = new Set<string>(Object.keys(classes)), bySubject = new Map<string, PolicyJson[]>(), everyone: PolicyJson[] = [];
  if (metadata) for (const t of children.Identifiable ?? []) if (metadata.types[t]?.concrete) types.add(t);
  function collectTypes(v: PolicyJson): void {
    if (!v || typeof v !== 'object') return;
    if (['resource.type', 'new.type'].includes(v.Left)) for (const t of list(v.Right))
      if (typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(t)) types.add(t);
    Object.values(v).forEach(collectTypes);
  }
  for (const policy of model.policies) {
    if (!policy.enabled || policy.valid === false || !Array.isArray(policy.content?.Statement)) continue;
    policy.content.Statement.forEach((statement: PolicyJson, index: number) => {
      collectTypes(statement.Resource);
      const actions = statement.Action === '*' ? PBAC_ACTIONS : pbacActions(statement.Action);
      if (!actions.length || pbacEffect(statement.Effect) !== 'Allow') return;
      const rule = { key: policy.rid + ':' + index, policy, index, statement, actions, actorDependent: hasActorPredicate(statement.Resource) };
      rules.push(rule);
      if (statement.Subject === '*') everyone.push(rule);
      else for (const subject of list(statement.Subject)) if (typeof subject === 'string' && subject.startsWith('role:')) {
        if (!bySubject.has(subject.slice(5))) bySubject.set(subject.slice(5), []);
        bySubject.get(subject.slice(5))!.push(rule);
      }
    });
  }
  const groups = ['Structure', 'Enterprise objects', 'Interface objects', 'Other types'];
  const columns = [...types].filter((t: string) => !metadata?.types[t] || metadata.types[t].concrete)
    .map((id: string) => ({ id, group: matrixTypeGroup(id), width: Math.max(80, id.length * 6.5 + 18) }))
    .sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.id.localeCompare(b.id));
  const roles = model.roles, roleMap = new Map<string, PolicyJson>(roles.map((r: PolicyJson): [string, PolicyJson] => [r.rid, r]));
  const columnAt = new Map(columns.map((c, i) => [c.id, i])), facts = new Map<PolicyJson, Map<string, Uint32Array>>(), rowFacts = new Map<string, Uint32Array>(), roleContexts = new Map<string, { ids: Set<string>; candidates: Set<PolicyJson> }>();
  const evaluate = (rule: PolicyJson, type: string, action: string, roleIds?: Set<string>) => evaluateMatrixExpression(rule.statement.Resource, type === ANY_TYPE
    ? { type: '', action, children, metadata, roleIds, anyType: true } : { type, action, children, metadata, roleIds });
  function compile(rule: PolicyJson, roleIds?: Set<string>): Uint32Array {
    const signature = rule.actorDependent ? actorSignature(rule.statement.Resource, roleIds) : '';
    if (!facts.has(rule)) facts.set(rule, new Map());
    const variants = facts.get(rule) as Map<string, Uint32Array>;
    if (variants.has(signature)) return variants.get(signature) as Uint32Array;
    // `byType` keeps only what a matched type test (or a named object of that type) supports.
    const result = new Uint32Array(columns.length), byType = new Uint32Array(columns.length);
    columns.forEach((column, i) => {
      for (const action of rule.actions) {
        const evidence = evaluate(rule, column.id, action, roleIds), status = coverageStatus(evidence), at = PBAC_ACTIONS.indexOf(action);
        const bits = bitsFor(status, at, status === CONDITIONAL ? conditionKinds(evidence).kinds : []);
        result[i] |= bits;
        if (evidence.anchored) byType[i] |= bits;
      }
    });
    variants.set(signature, result);
    if (!typedVariants.has(rule)) typedVariants.set(rule, new Map());
    typedVariants.get(rule)!.set(signature, byType);
    return result;
  }
  const typedVariants = new Map<PolicyJson, Map<string, Uint32Array>>();
  function compileTyped(rule: PolicyJson, roleIds?: Set<string>): Uint32Array {
    compile(rule, roleIds);
    return typedVariants.get(rule)!.get(rule.actorDependent ? actorSignature(rule.statement.Resource, roleIds) : '') as Uint32Array;
  }
  const merge = (target: Uint32Array, source: Uint32Array) => { for (let i = 0; i < source.length; i++) target[i] |= source[i]; };
  /** What a statement grants without a type test: evaluated for no type at all, so every type
   *  test fails and only the type-free part is left. The same for every type. */
  function anyBits(rule: PolicyJson, roleIds?: Set<string>): number {
    let bits = 0;
    for (const action of rule.actions) {
      const evidence = evaluate(rule, ANY_TYPE, action, roleIds), status = coverageStatus(evidence);
      if (!evidence.anchored) bits |= bitsFor(status, PBAC_ACTIONS.indexOf(action), status === CONDITIONAL ? conditionKinds(evidence).kinds : []);
    }
    return bits;
  }
  let everyoneFacts: Uint32Array | undefined;
  function roleContext(rid: string) {
    if (roleContexts.has(rid)) return roleContexts.get(rid) as { ids: Set<string>; candidates: Set<PolicyJson> };
    const ids = new Set<string>(), visited = new Set<string>(), candidates = new Set<PolicyJson>(everyone);
    for (let role = roleMap.get(rid); role && !visited.has(role.rid); role = roleMap.get(role.parent)) {
      visited.add(role.rid); ids.add(role.id);
      for (const rule of bySubject.get(role.id) ?? []) candidates.add(rule);
    }
    const result = { ids, candidates }; roleContexts.set(rid, result); return result;
  }
  // Per role: everything a type cell shows (row), what a matched type test supports (typedRow), and
  // what applies without one (anyOf). The last is one row of its own and never makes a type row "used".
  const typedFacts = new Map<string, Uint32Array>(), anyFacts = new Map<string, number>(), ownAnyFacts = new Map<string, number>();
  let everyoneTyped: Uint32Array | undefined;
  function everyoneShared(): void {
    if (everyoneFacts) return;
    everyoneFacts = new Uint32Array(columns.length); everyoneTyped = new Uint32Array(columns.length);
    for (const rule of everyone) if (!rule.actorDependent) { merge(everyoneFacts, compile(rule)); merge(everyoneTyped, compileTyped(rule)); }
  }
  function row(rid: string): Uint32Array {
    if (rowFacts.has(rid)) return rowFacts.get(rid) as Uint32Array;
    everyoneShared();
    const result = everyoneFacts!.slice(), { ids, candidates } = roleContext(rid);
    for (const rule of candidates) if (rule.actorDependent || rule.statement.Subject !== '*') merge(result, compile(rule, ids));
    rowFacts.set(rid, result); return result;
  }
  function typedRow(rid: string): Uint32Array {
    if (typedFacts.has(rid)) return typedFacts.get(rid) as Uint32Array;
    everyoneShared();
    const result = everyoneTyped!.slice(), { ids, candidates } = roleContext(rid);
    for (const rule of candidates) if (rule.actorDependent || rule.statement.Subject !== '*') merge(result, compileTyped(rule, ids));
    typedFacts.set(rid, result); return result;
  }
  function anyOf(rid: string): number {
    if (anyFacts.has(rid)) return anyFacts.get(rid) as number;
    const { ids, candidates } = roleContext(rid);
    let bits = 0;
    for (const rule of candidates) bits |= anyBits(rule, ids);
    anyFacts.set(rid, bits); return bits;
  }
  const summary = (rid: string, type: string) => summaryFrom(type === ANY_TYPE ? anyOf(rid) : row(rid)[columnAt.get(type) as number] ?? 0);
  /** A type's cell without the statements that name no type. */
  const typed = (rid: string, type: string) => summaryFrom(typedRow(rid)[columnAt.get(type) as number] ?? 0);
  // Coverage from statements that name the role itself. The rest of a row is
  // inherited from parent roles or from Everyone.
  const ownFacts = new Map<string, Uint32Array>();
  function ownRow(rid: string): Uint32Array {
    if (ownFacts.has(rid)) return ownFacts.get(rid) as Uint32Array;
    const role = roleMap.get(rid), result = new Uint32Array(columns.length), { ids } = roleContext(rid);
    for (const rule of role ? bySubject.get(role.id) ?? [] : []) merge(result, compile(rule, ids));
    ownFacts.set(rid, result); return result;
  }
  function ownAny(rid: string): number {
    if (ownAnyFacts.has(rid)) return ownAnyFacts.get(rid) as number;
    const role = roleMap.get(rid), { ids } = roleContext(rid);
    let bits = 0;
    for (const rule of role ? bySubject.get(role.id) ?? [] : []) bits |= anyBits(rule, ids);
    ownAnyFacts.set(rid, bits); return bits;
  }
  const own = (rid: string, type: string) => summaryFrom(type === ANY_TYPE ? ownAny(rid) : ownRow(rid)[columnAt.get(type) as number] ?? 0);
  const inspected = new Map<string, PolicyJson>();
  function cell(rid: string, type: string): PolicyJson {
    const key = rid + '|' + type;
    if (inspected.has(key)) return inspected.get(key);
    const { ids, candidates } = roleContext(rid), entries = [], unresolvedRules = [];
    for (const rule of candidates) {
      const evidence: { action: string; status: number; reasons: string[]; unresolvedReasons: string[]; kinds: ConditionKind[]; gaps: string[] }[] = rule.actions.map((action: string) => {
        const result = evaluate(rule, type, action, ids), status = type === ANY_TYPE && result.anchored ? EXCLUDED : coverageStatus(result);
        const parts = status === CONDITIONAL ? conditionKinds(result) : { kinds: [], gaps: [] };
        return { action, status, reasons: result.reasons, unresolvedReasons: result.unresolvedReasons ?? [], kinds: parts.kinds, gaps: parts.gaps };
      });
      const supported = evidence.filter(e => e.status === DEFINITE || e.status === CONDITIONAL);
      // Also a conditional operation with a part the matrix could not read: the detail names it.
      const unresolved = evidence.filter(e => e.status === UNRESOLVED || e.gaps.length);
      if (!supported.length && !unresolved.length) continue;
      const entry = { ...rule, actions:supported.map(e=>e.action),
        conditionalActions:supported.filter(e=>e.status===CONDITIONAL).map(e=>e.action),
        conditional:supported.some(e=>e.status===CONDITIONAL),
        unresolved:!supported.length, unresolvedActions:unresolved.map(e=>e.action),
        kinds:Object.fromEntries(supported.filter(e=>e.status===CONDITIONAL).map(e=>[e.action,e.kinds])),
        reasons:[...new Set(supported.flatMap(e=>e.reasons))],
        unresolvedReasons:[...new Set(unresolved.flatMap(e=>e.status===UNRESOLVED?[...e.reasons,...e.unresolvedReasons]:e.gaps))] };
      if (supported.length) entries.push(entry);
      if (unresolved.length) unresolvedRules.push(entry);
    }
    const result = { ...summary(rid, type), rules: entries, unresolvedRules };
    if (inspected.size >= 32) inspected.delete(inspected.keys().next().value as string);
    inspected.set(key, result); return result;
  }
  return { roles, columns, cell, summary, own, typed, rules };
}
