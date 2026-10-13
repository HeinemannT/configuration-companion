import { median } from './performance-analysis.js';
export const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
export function sampleSummary(checks) {
  return {
    runs: checks.reduce((n,c)=>n+c.runs.length+(c.indexedRuns?.length||0),0),
    objects: new Set(checks.filter(c=>c.action!=='CREATE').map(c=>c.object.rid)).size,
    proposedTypes: new Set(checks.filter(c=>c.action==='CREATE').map(c=>c.object.type)).size,
  };
}
const statementKey = n => `${n.details?.policyRid}:${n.details?.statementIndex}`;
export function prepareChecks(recording, snapshot) {
  const policies = new Map(snapshot.model.policies.map(p => [p.rid, p]));
  return (recording?.checks || []).map(c => {
    const runs = c.runs.filter(n => Number.isFinite(n.durationMs)).toSorted((a,b) => a.durationMs-b.durationMs);
    if (!runs.length) return null;
    // Retain one complete run. All costs in the inspector must belong to this same tree.
    const trace = runs[Math.floor(runs.length/2)];
    const rules = (trace.children || []).filter(n => n.element==='Statement').map((node, order) => {
      const policy = policies.get(node.details.policyRid);
      const index = Number(node.details.statementIndex);
      const nested = descendants(node).filter(n => n.element==='HasAccessTo');
      return {key:statementKey(node),node,order,index,policy,name:policy?.name || node.details.policyRid_name || node.details.policyRid,nested};
    });
    const grant = rules.find(r => r.node.result && r.node.details.effect?.toUpperCase()==='ALLOW');
    const slowest = rules.toSorted((a,b)=>b.node.durationMs-a.node.durationMs)[0];
    const consistent=[...runs,...(c.indexedRuns||[])].every(r=>!r.timedOut&&typeof r.result==='boolean'&&r.result===trace.result);
    const strategies=new Set(c.serverStrategies||['unknown']);
    const strategy=strategies.size!==1?'Mixed server modes':strategies.has('indexed')?'Indexed':strategies.has('sequential')?'Sequential fallback':'Server mode unconfirmed';
    return {...c,policyLookup:policies,trace,rules,grant,slowest,decision:consistent?trace.result:null,strategy,median:median(runs.map(r=>r.durationMs)),indexedMedian:median((c.indexedRuns||[]).map(r=>r.durationMs)),min:runs[0].durationMs,max:runs.at(-1).durationMs,consistent};
  }).filter(Boolean);
}
export function diagnose(rule, check) {
  const subject=rule.node.children?.find(n=>n.element==='Subject');
  if(subject&&subject.durationMs>rule.node.durationMs*0.5)return {title:'Subject / role resolution',node:subject,time:subject.durationMs,share:Math.round(subject.durationMs/rule.node.durationMs*100),detail:subject.details?.original,extra:'Assignment and delegation resolution',action:'Inspect role scope',reason:'This trace times the subject as a whole; it cannot attribute cost to an individual delegation. Removing a delegation can remove valid access.',requests:[]};
  const nested = rule.nested.toSorted((a,b)=>b.durationMs-a.durationMs);
  if (nested.length && nested[0].durationMs>rule.node.durationMs*0.5) {
    const n=nested[0];
    const requests=descendants(n).filter(x=>['TraceRequest','Access request'].includes(x.element));
    const reported=Number(n.details.numberOfAccessChecks);
    const count=n.details.numberOfAccessChecks!=null&&Number.isFinite(reported)?reported:requests.length;
    return {title:'Related-object access',node:n,time:n.durationMs,share:rule.node.durationMs ? Math.round(n.durationMs/rule.node.durationMs*100) : 0,
      detail:n.details.reference,extra:`${count} additional ${count===1?'check':'checks'}`,
      action:'No optimization identified',reason:null,requests};
  }
  const children=(rule.node.children||[]).toSorted((a,b)=>b.durationMs-a.durationMs);
  const n=children[0];
  return {title:n ? `${n.element} evaluation${n.result===false?' · no match':''}` : 'Rule evaluation',node:n,time:n?.durationMs??null,
    detail:n?.element||'Rule',extra:check.trace.result?'Evaluation stopped at the first grant':`${check.rules.length} rules evaluated`,
    action:'No optimization identified',reason:null,requests:[]};
}
export function policyTotals(checks) {
  const groups=new Map();
  for(const c of checks) for(const r of c.rules) {
    const old=groups.get(r.key)||{...r,max:0,calls:0,grants:0,checks:[]};
    if(!old.maxCheck||r.node.durationMs>old.max){old.maxCheck=c.id;old.driver=diagnose(r,c).title;} old.max=Math.max(old.max,r.node.durationMs); old.calls++;old.grants+=r.node.result?1:0; old.checks.push(c.id); groups.set(r.key,old);
  }
  return [...groups.values()].toSorted((a,b)=>b.max-a.max);
}
