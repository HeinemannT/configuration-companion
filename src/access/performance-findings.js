import { analyze } from './performance-analysis.js';
import { coveredLinkedRules } from './performance-evidence.js';
const values=v=>v==null?[]:Array.isArray(v)?v:[v];

// Only flag a required positive lookup. Alternatives can be deliberately shared
// by Create and existing-object actions; negation/missing-value tests are unknown.
export function requiresOperand(node, matches) {
  if(!node||typeof node!=='object'||node.Not)return false;
  if(Array.isArray(node.All))return node.All.some(child=>requiresOperand(child,matches));
  if(Array.isArray(node.Any))return node.Any.length>0&&node.Any.every(child=>requiresOperand(child,matches));
  const c=node.Condition;
  if(c)return typeof c.Left==='string'&&matches(c.Left)&&['=','Equal','~','Contains','ContainsAny','ContainsAll','ExactTypeOf','NotEmpty'].includes(c.Comparison);
  const ref=node.HasRole?.Reference||node.HasAccessTo?.Reference;
  return typeof ref==='string'&&matches(ref);
}

/** Portable lessons from native validation. Historical benchmark numbers and
 * environment-specific policies are deliberately not shipped with Companion. */
export function performanceFindings(snapshot) {
  const report=analyze(snapshot),out=[];
  const add=(id,category,title,reason,rules,limit)=>{if(rules.length)out.push({id,category,title,reason,rules,limit});};
  const overlap=coveredLinkedRules(report,snapshot.referenceFacts||{});
  for(const p of overlap)add('covered:'+p.rule.key,'investigate','Review a grant covered by another policy','The same linked check is already covered by an enabled broader rule. Disabling the narrower policy may avoid repeated evaluation.',[p.rule], 'No saving has been measured here. The covering policy must remain enabled and deployed. Verify access before keeping a change.');
  for(const f of out)if(f.id.startsWith('covered:'))f.coveredBy=overlap.find(p=>'covered:'+p.rule.key===f.id).coveredBy;
  add('new','access','Review new.type on Read','Read checks an existing resource. Matching this rule requires new.type.',report.rules.filter(r=>values(r.statement.Action).some(a=>['Read','*'].includes(a))&&requiresOperand(r.statement.Resource,o=>o==='new.type')),'Replacing it can grant new access or add evaluation cost. Review intent; this is not a speed optimization.');
  add('invalid','access','Resolve invalid policies','An enabled policy is invalid or cannot be analyzed.',report.invalid.map(policy=>({policy,index:0,key:policy.id+':0',invalid:true})),'Read BMP’s validation error before changing it.');
  const create=[],update=[];
  for(const r of report.rules){const actions=values(r.statement.Action);
    if(actions.some(a=>['Create','*'].includes(a))&&requiresOperand(r.statement.Resource,o=>o.startsWith('resource.')))create.push(r);
    if(actions.some(a=>['Update','*'].includes(a))&&requiresOperand(r.statement.Resource,o=>o==='new.type'))update.push(r);
  }
  add('create','access','Review resource fields on Create','Create has submitted values rather than an existing resource.',create,'Use the intended new fields and parent context. Do not replace every resource expression automatically.');
  add('update','access','Review new.type on Update','Ordinary field edits may not submit a type.',update,'Inspect a realistic Update request before deciding to activate the rule.');
  add('duplicates','reviewed','Identical rules','Duplicate permission logic was found in different policy owners.',report.duplicates.flat(),'Consolidation did not consistently improve native indexed timings in validation. Separate enablement or deployment may justify the copies.');
  add('repeated','reviewed','Repeated comparisons','An identical comparison occurs more than once within a boolean group.',[...new Map(report.repeated.map(x=>[x.rule.key,x.rule])).values()],'The indexed engine can already share comparisons. Shorter JSON is not evidence of a speed gain.');
  add('linked','reviewed','Keep the semantics of linked access','HasAccessTo evaluates the target policies and their conditions.',report.rules.filter(r=>r.nested),'A direct HasRole replacement changed permissions in native validation. Do not recommend it as an equivalent shortcut.');
  return out;
}
