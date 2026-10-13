import {canonical} from '../lib/access-workspace/model';

const annotations=['comment','description','_comment'];
const hasOnly=(node,keys)=>node&&typeof node==='object'&&!Array.isArray(node)&&Object.keys(node).every(k=>keys.includes(k)||annotations.includes(k));
function leaves(node) {
  if(hasOnly(node,['All'])&&Array.isArray(node.All)){
    const children=node.All.map(leaves);
    return children.every(Boolean)?children.flat():null;
  }
  if(hasOnly(node,['Condition'])&&hasOnly(node.Condition,['Left','Comparison','Right']))return [node];
  if(hasOnly(node,['HasAccessTo'])&&hasOnly(node.HasAccessTo,['Reference','Action','Roles','Grouping']))return [node];
  return null;
}
const values=v=>Array.isArray(v)?v:[v];
const knownChoice=c=>['=','Equal','Contains','ContainsAny'].includes(c.Comparison)&&values(c.Right).length>0&&values(c.Right).every(v=>typeof v==='string'&&/^[A-Za-z][\w]*:[\w-]+$/.test(v));
// Intentionally narrow proof: one resource reference, one exact type, direct All leaves.
// This must not infer cardinality from a property name or generalize to an Any branch.
export function coveredLinkedRules(report,referenceFacts) {
  const proposals=[], retained=new Set(), removed=new Set(), broadByAccess=new Map();
  const normalize=(a,action)=>canonical({reference:a.Reference,action:!a.Action||a.Action==='Inherited'?action:a.Action,roles:a.Roles??null});
  const parsed=new Map(report.rules.map(rule=>{
    const all=leaves(rule.statement.Resource);
    return [rule,all?{conditions:all.filter(n=>n.Condition).map(n=>n.Condition),access:all.filter(n=>n.HasAccessTo).map(n=>n.HasAccessTo)}:null];
  }));
  for(const broad of report.rules){
    const b=broad.statement,p=parsed.get(broad);
    if(b.Effect!=='Allow'||b.Subject!=='*'||!p||p.access.length!==1||!['Any','All',undefined].includes(p.access[0].Grouping))continue;
    for(const action of values(b.Action)){
      const key=action+':'+normalize(p.access[0],action),bucket=broadByAccess.get(key)||[];
      bucket.push({rule:broad,conditions:p.conditions});broadByAccess.set(key,bucket);
    }
  }
  for(const narrow of report.rules){
    if(retained.has(narrow))continue;
    const s=narrow.statement;if(s.Effect!=='Allow'||!Array.isArray(s.Action)||!s.Action.length||s.Action.some(a=>!['Read','Update'].includes(a))||narrow.policy.content.Statement.length!==1)continue;
    const p=parsed.get(narrow);if(!p)continue;
    const nc=p.conditions,na=p.access,conditionKeys=new Set(nc.map(canonical));
    const type=nc.find(c=>c.Left==='resource.type'&&c.Comparison==='ExactTypeOf'&&typeof c.Right==='string')||nc.find(c=>c.Left==='resource.type'&&['=','Equal'].includes(c.Comparison)&&values(c.Right).length===1);
    if(!type||na.length!==1||!['Any','All',undefined].includes(na[0].Grouping))continue;
    const resourceType=values(type.Right)[0],ref=na[0].Reference;
    if(!/^resource\.\w+$/.test(ref)||referenceFacts[resourceType+'.'+ref.slice(9)]?.multiselect!==false)continue;
    const coveredBy=[];
    for(const action of s.Action){
      const covering=(broadByAccess.get(action+':'+normalize(na[0],action))||[]).find(({rule:broad,conditions:bc})=>{
        if(broad===narrow||removed.has(broad))return false;
        const grouping=a=>a.Grouping??'All';
        if(grouping(parsed.get(broad).access[0])!==grouping(na[0])&&type.Comparison!=='ExactTypeOf')return false;
        // Equal also admits subtypes, whose class-local field cardinality may
        // differ. Any/All equivalence needs a scalar *exact* concrete type.
        // Missing Roles means NoFilter, not an empty RoleFilter.
        return bc.every(c=>conditionKeys.has(canonical(c))||(c.Left==='resource.type'&&['=','Equal'].includes(c.Comparison)&&values(c.Right).length===1&&values(c.Right)[0]===resourceType)||(c.Comparison==='NotEmpty'&&(c.Left===ref||nc.some(n=>n.Left===c.Left&&knownChoice(n)))));
      });
      if(!covering)break;coveredBy.push(covering.rule);
    }
    if(coveredBy.length===s.Action.length){
      removed.add(narrow);coveredBy.forEach(rule=>retained.add(rule));
      proposals.push({rule:narrow,coveredBy:[...new Set(coveredBy)],reference:ref,resourceType,before:s,after:null});
    }
  }
  return proposals;
}
