import { analyze, median } from './performance-analysis.js';
import { canonical } from '../lib/access-workspace/model';

export const MAX_PERFORMANCE_CHECKS = 48;
export const performanceRevision = snapshot => canonical({environment:snapshot.environment,model:snapshot.model});
const values = v => v==null?[]:Array.isArray(v)?v:[v];
export const contextKey = request => canonical(request);

/** A deterministic, bounded sample. No invented Create fields or wildcard roles. */
export function performancePlan(discovery, seeds=[]) {
  const {snapshot,objects,assignedUsers=[]}=discovery, report=analyze(snapshot);
  const rolesById=new Map(snapshot.model.roles.map(r=>[r.id,r]));
  const users=[],userRids=new Set();
  for(const source of [assignedUsers,snapshot.users]) for(const user of source){
    if(users.length===4)break;
    if(!userRids.has(user.rid)){users.push(user);userRids.add(user.rid);}
  }
  const result=[],seen=new Set();
  const add=c=>{const key=contextKey(c.request);if(!seen.has(key)&&result.length<MAX_PERFORMANCE_CHECKS){seen.add(key);result.push({...c,id:key});}};
  for(const c of seeds.slice(0,8)) if(c.actor?.rid&&c.object?.rid&&c.request) add(c);
  const perObject=objects.map(object=>{
    const rules=report.rules.filter(r=>!r.types.length||r.types.includes(object.type));
    const roleIds=[...new Set(rules.toSorted((a,b)=>b.nested-a.nested).flatMap(r=>values(r.statement.Subject)).filter(s=>typeof s==='string'&&s.startsWith('role:')).map(s=>s.slice(5)))];
    const roles=roleIds.map(id=>rolesById.get(id)).filter(Boolean).slice(0,3).map(r=>({...r,kind:'role'}));
    const actors=[...users.map(u=>({...u,kind:'user'})),...roles];
    const actions=[...new Set(rules.flatMap(r=>values(r.statement.Action)))];
    return {object,actors,actions};
  });
  const candidates=[];
  for(let round=0;round<7;round++)for(const {object,actors,actions} of perObject){
    const actor=actors[round];if(!actor)continue;
    for(const action of ['Read','Update','Delete']) if(actions.includes(action)||actions.includes('*')) {
      const request={resource_rid:object.rid,subject_rid:actor.rid,action:action.toUpperCase(),...(action==='Update'?{proposed:{type:object.type,properties:{name:(object.name||object.id)+' (access test)'}}}:{})};
      candidates.push({actor,object,action:request.action,request,proposedLabel:action==='Update'?'Name change':undefined});
    }
  }
  const coveredTypes=new Set(),coveredActors=new Set(),coveredActions=new Set(),coveredObjects=new Set();
  // Balance principal, type and action coverage before adding repeat samples.
  while(candidates.length&&result.length<MAX_PERFORMANCE_CHECKS){
    const score=c=>(coveredTypes.has(c.object.type)?0:8)+(coveredActors.has(c.actor.rid)?0:8)+(coveredActions.has(c.action)?0:4)+(coveredObjects.has(c.object.rid)?0:2);
    candidates.sort((a,b)=>score(b)-score(a));const c=candidates.shift();
    add(c);coveredTypes.add(c.object.type);coveredActors.add(c.actor.rid);coveredActions.add(c.action);coveredObjects.add(c.object.rid);
  }
  return {checks:result,capped:candidates.length>0,
    needsCreate:report.rules.filter(r=>values(r.statement.Action).some(a=>['Create','*'].includes(a))).length};
}

/** Compare identical contexts, separately from permission changes. An observational
 * rerun is not a controlled A/B proof that a particular edit caused a saving. */
export function comparePerformance(before,after) {
  if(!before||!after||before.snapshot.environment!==after.snapshot.environment||!before.complete||!after.complete||before.stale||after.stale)return [];
  const old=new Map(before.checks.map(c=>[contextKey(c.request),c]));
  const measured=new Map(after.checks.map(c=>[contextKey(c.request),c]));
  const failures=new Map((after.failures||[]).map(c=>[contextKey(c.request),c.error]));
  const contexts=new Map([...before.checks,...(after.plan?.checks||[]),...after.checks].map(c=>[contextKey(c.request),c]));
  return [...contexts].map(([key,context])=>{
    const b=old.get(key),c=measured.get(key);
    const identity={id:context.id,actor:context.actor,object:context.object,action:context.action};
    if(!b||!c)return {...identity,missing:true,before:b?median(b.indexedRuns.map(r=>r.durationMs)):null,after:c?median(c.indexedRuns.map(r=>r.durationMs)):null,status:!b?'No baseline':failures.get(key)?'Measurement failed':'Not measured',error:failures.get(key)||'',canOpen:!!c};
    const br=[...b.runs,...b.indexedRuns],ar=[...c.runs,...c.indexedRuns];
    const stable=br.length===10&&ar.length===10&&[br,ar].every(runs=>runs.every(r=>typeof r.result==='boolean'&&r.result===runs[0].result&&!r.timedOut));
    const changed=stable&&br[0].result!==ar[0].result;
    const bms=b.indexedRuns.map(r=>r.durationMs).filter(Number.isFinite),ams=c.indexedRuns.map(r=>r.durationMs).filter(Number.isFinite);
    const timed=bms.length===5&&ams.length===5;
    const strategy=r=>[...new Set(r.serverStrategies||['unknown'])].sort().join(',');
    const mixed=[b,c].some(r=>new Set((r.serverStrategies||[]).filter(mode=>mode!=='unknown')).size>1);
    const modeChanged=strategy(b)!==strategy(c);
    const comparable=timed&&stable&&!changed&&!modeChanged&&!mixed;
    const faster=comparable&&Math.max(...ams)<Math.min(...bms);
    const slower=comparable&&Math.min(...ams)>Math.max(...bms);
    return {...identity,canOpen:true,before:median(bms),after:median(ams),beforeResult:br[0]?.result,afterResult:ar[0]?.result,stable,changed,faster,slower,status:!stable?'Inconsistent decisions':changed?'Access changed':!timed?'Incomplete timings':mixed?'Mixed evaluation modes':modeChanged?'Evaluation mode changed':faster?'Faster in this sample':slower?'Slower in this sample':'No clear change'};
  });
}
