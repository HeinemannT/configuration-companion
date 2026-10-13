import type { BmpClient } from '../bmp-client';
import type { AccessTraceNode } from '../types';
import type { AccessSnapshot, AccessChoice, AccessTest } from './model';
import { frame, literal, readAccess, readEc, ROOTS, type ReadContext } from './read';
import { validateEcIdentifier, validateRid } from '../ec-guards';
import { prepareAccessTest } from './trace';
import { readTypeFields } from './requests';
import { performanceTypeHints } from './performance-types';

export const PERFORMANCE_LIMITS = { types: 12, objectsPerType: 2, users: 6, runs: 5 } as const;
/** Prioritize recursive rules, but sample interface types as well as business types.
 * This chooses a sample, never infers that unsampled policies are unused. */
export function performanceTypes(snapshot: AccessSnapshot): string[] {
  const scores = new Map<string, number>();
  const walk = (value: unknown, visit: (node: Record<string, any>) => void) => {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, any>;
    visit(node);
    for (const group of [node.All, node.Any]) if (Array.isArray(group)) for (const child of group) walk(child, visit);
  };
  for (const p of snapshot.model.policies.filter(p => p.enabled && p.valid !== false)) {
    const statements = p.content?.Statement;
    if (!Array.isArray(statements)) continue;
    for (const statement of statements) {
      const nodes: Record<string, any>[] = [];
      walk(statement?.Resource, node => nodes.push(node));
      const weight = nodes.some(node => node.HasAccessTo) ? 3 : 1;
      for (const {Condition:c} of nodes) for (const type of performanceTypeHints(c,snapshot.classes,snapshot.typeChildren)) scores.set(type, (scores.get(type) ?? 0) + weight);
    }
  }
  for (const s of snapshot.model.scope) if (s.source && s.source in snapshot.classes && !scores.has(s.source)) scores.set(s.source, 1);
  // A broad policy can have no type condition or field assignment at all.
  // Prefer configured model roots, then use the live class catalogue.
  if (!scores.size) {
    const classes=Object.keys(snapshot.classes);
    return [...new Set([...ROOTS.flatMap(root=>classes.filter(type=>type.toLowerCase()===root.toLowerCase())),...classes])];
  }
  return [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([type])=>type);
}

export function sampleObjectsQuery(type: string) {
  validateEcIdentifier(type);
  const f = frame();
  const root = ROOTS.find(r=>r.toLowerCase()===type.toLowerCase());
  const sources = root ? [root] : ['User','Group','Role'].includes(type) ? [type.toLowerCase()] : ['organisation', 'templateCategory', 'page', 'portal'];
  // Filter before the cap; never serialize an entire model or include Defaults.
  const code = ['_out := ""', '_count := 0', ...sources.flatMap(source => [
    `IF _count < ${PERFORMANCE_LIMITS.objectsPerType} THEN`,
    ` _nodes := root.${source}.descendants.filter(className = ${literal(type)}).first(${PERFORMANCE_LIMITS.objectsPerType} - _count)`,
    ' _nodes.forEach(_n:', f.row([f.start, '_n.rid', '_n.id', '_n.name', '_n.className']), ' _count := _count + 1', ' )', 'ENDIF',
  ]), '_out'].join('\n');
  return { code, parse: (value: string): AccessChoice[] => f.parse(value).map(([rid,id,name,type])=>({rid:validateRid(rid),id,name,type})) };
}

export async function discoverPerformance(client: BmpClient, environment: string, name: string, assertEnvironment: () => void, context: ReadContext = {}) {
  const snapshot = await readAccess(client, environment, name, context);
  const types = performanceTypes(snapshot), selected = types.slice(0, PERFORMANCE_LIMITS.types);
  const objects: AccessChoice[] = [], problems: string[] = [], assignedUsers = new Map<string, AccessChoice>();
  const referenceFacts: Record<string,{rid:string;multiselect:boolean}> = {};
  for (const type of selected) {
    context.signal?.throwIfAborted(); assertEnvironment();
    context.progress?.(`Finding sample objects · ${type}`);
    try {
      const query = sampleObjectsQuery(type), found = query.parse(await readEc(client, query.code, context.signal));
      objects.push(...found);
      if (!found.length) problems.push(`${type}: no sample found in business or interface models.`);
      try { for (const field of await readTypeFields(client,type,context.signal)) if (field.reference) referenceFacts[type+'.'+field.businessId]={rid:field.id,multiselect:field.multiselect}; }
      catch { context.signal?.throwIfAborted(); problems.push(`${type}: reference cardinality unavailable; overlap suggestions remain conservative.`); }
      const fields = [...new Set(snapshot.model.scope.filter(s=>s.kind==='RoleAssignment'&&s.source===type&&s.field).map(s=>s.field!))].slice(0,8);
      // Discover real assigned users with bounded reads. Multivalue/group fields
      // without a scalar identity remain unrepresented, not guessed as users.
      for (const object of found) if (fields.length && assignedUsers.size < PERFORMANCE_LIMITS.users) {
        try {
          const values = await client.fetchSelectedProperties(object.rid, fields.map(accessor=>({accessor,reference:true})), context.signal);
          for (const value of values) if (value.reference?.type==='User' && assignedUsers.size < PERFORMANCE_LIMITS.users) {
            const r=value.reference; assignedUsers.set(r.rid,{rid:r.rid,id:r.businessId??'',name:r.name??'',type:'User'});
          }
        } catch (error) { context.signal?.throwIfAborted(); problems.push(`${type}: assigned users could not be sampled (${error instanceof Error?error.message:String(error)}).`); }
      }
    } catch (error) { context.signal?.throwIfAborted(); problems.push(`${type}: ${error instanceof Error?error.message:String(error)}`); }
  }
  if (!snapshot.users.length && !assignedUsers.size) {
    try {
      const query=sampleObjectsQuery('User');
      for(const user of query.parse(await readEc(client,query.code,context.signal)))assignedUsers.set(user.rid,user);
    } catch(error) { context.signal?.throwIfAborted(); problems.push(`No users could be sampled: ${error instanceof Error?error.message:String(error)}`); }
  }
  assertEnvironment(); context.signal?.throwIfAborted();
  return { snapshot:{...snapshot,referenceFacts}, objects, assignedUsers:[...assignedUsers.values()], problems,
    scope:{ availableTypes:types.length, sampledTypes:selected, unsampledTypes:types.slice(selected.length), limits:PERFORMANCE_LIMITS } };
}

function completeTrace(node: AccessTraceNode): boolean {
  return !node.timedOut && node.children.every(completeTrace);
}
export async function measurePerformance(client: BmpClient, request: AccessTest, assertEnvironment: () => void, signal?: AbortSignal) {
  signal?.throwIfAborted(); assertEnvironment();
  const updates = await prepareAccessTest(client, request, signal);
  const sequential: AccessTraceNode[] = [], indexed: AccessTraceNode[] = [];
  const serverStrategies: string[] = [];
  const summary=(n:AccessTraceNode)=>({element:n.element,result:n.result,timedOut:n.timedOut,durationMs:n.durationMs,details:{},children:[],traceOmitted:true});
  // Warm both modes, then alternate their order to reduce order bias. Requests
  // are sequential so the profiler does not create its own concurrent load.
  for (let round=-1; round<PERFORMANCE_LIMITS.runs; round++) for (const mode of round%2===0 ? [true,false] : [false,true]) {
    signal?.throwIfAborted(); assertEnvironment();
    const trace=await client.fetchAccessTrace(request.resource_rid,request.subject_rid,request.action,signal,updates,mode);
    signal?.throwIfAborted(); assertEnvironment();
    if (!trace || typeof trace.result!=='boolean' || !Number.isFinite(trace.durationMs) || trace.durationMs!<0 || !completeTrace(trace)) throw new Error('BMP returned an incomplete or untimed access trace. This check was not measured.');
    if (round>=0) {
      (mode?indexed:sequential).push(mode?summary(trace):trace);
      // A server can disable indexing despite the requested flag. Empty traces
      // cannot establish either strategy; do not infer one from the request.
      if (mode) serverStrategies.push(trace.children.some(n=>n.element==='Statement') ? 'sequential' : trace.children.length ? 'indexed' : 'unknown');
    }
  }
  const representative=[...sequential].sort((a,b)=>a.durationMs!-b.durationMs!)[Math.floor(sequential.length/2)];
  // Retain every total/decision, but only one complete tree for attribution.
  return {runs:sequential.map(n=>n===representative?n:summary(n)),indexedRuns:indexed,serverStrategies,recordedAt:new Date().toISOString()};
}
