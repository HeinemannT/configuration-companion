import {expect,it} from 'vitest';
import {analyze} from './performance-analysis.js';
import {coveredLinkedRules} from './performance-evidence.js';
import {clarityFixture} from './__fixtures__/clarity.js';
function model(narrowGrouping='All',broadGrouping='All'){
 const {snapshot}=clarityFixture();const linked=g=>({HasAccessTo:{Reference:'resource.owner',Action:'Read',Grouping:g,Roles:['reviewer']}});
 const type={Condition:{Left:'resource.type',Comparison:'=',Right:'CeTask'}};
 snapshot.model.policies=['narrow','broad'].map((id,i)=>({rid:String(10+i),id,name:id,enabled:true,content:{Statement:[{Effect:'Allow',Subject:i?'*':['role:risk_review'],Action:['Read'],Resource:{All:[type,linked(i?broadGrouping:narrowGrouping)]}}]}}));
 return analyze(snapshot);
}
it('requires known single-valued references and a covering policy that remains enabled',()=>{
 const r=model();expect(coveredLinkedRules(r,{})).toHaveLength(0);
 expect(coveredLinkedRules(r,{'CeTask.owner':{multiselect:true}})).toHaveLength(0);
 expect(coveredLinkedRules(r,{'CeTask.owner':{multiselect:false}})).toHaveLength(1);
 r.rules=r.rules.slice(0,1);expect(coveredLinkedRules(r,{'CeTask.owner':{multiselect:false}})).toHaveLength(0);
});
it('uses native scalar-reference grouping semantics but never equates missing and empty role filters',()=>{
 const exact=model('All','Any');exact.rules[0].statement.Resource.All[0].Condition.Comparison='ExactTypeOf';
 expect(coveredLinkedRules(exact,{'CeTask.owner':{multiselect:false}})).toHaveLength(1);
 const filters=model();delete filters.rules[0].statement.Resource.All[1].HasAccessTo.Roles;filters.rules[1].statement.Resource.All[1].HasAccessTo.Roles=[];
 expect(coveredLinkedRules(filters,{'CeTask.owner':{multiselect:false}})).toHaveLength(0);
});
it('does not use base-type scalar metadata to equate Any and All on possible subtypes',()=>{
 expect(coveredLinkedRules(model('Any','All'),{'CeTask.owner':{multiselect:false}})).toHaveLength(0);
 const equivalent=model(undefined,'All');delete equivalent.rules[0].statement.Resource.All[1].HasAccessTo.Grouping;
 expect(coveredLinkedRules(equivalent,{'CeTask.owner':{multiselect:false}})).toHaveLength(1);
});
it('does not treat disjunctive resource branches as covered conjunctions',()=>{
 const r=model();r.rules[0].statement.Resource={Any:r.rules[0].statement.Resource.All};
 expect(coveredLinkedRules(r,{'CeTask.owner':{multiselect:false}})).toHaveLength(0);
});
it('never proposes removing a covering policy required by another recommendation',()=>{
 const report=model();report.rules[0].statement.Subject='*';
 const recommendations=coveredLinkedRules(report,{'CeTask.owner':{multiselect:false}});
 expect(recommendations).toHaveLength(1);
 const removed=new Set(recommendations.map(r=>r.rule));
 expect(recommendations.every(r=>r.coveredBy.every(keeper=>!removed.has(keeper)))).toBe(true);
});
it('indexes unrelated linked checks instead of comparing every policy pair',()=>{
 const template=model().rules[1],facts={};
 const rules=Array.from({length:1000},(_,i)=>{
  const rule=structuredClone(template);rule.key='p'+i;rule.statement.Resource.All[1].HasAccessTo.Reference='resource.ref'+i;facts['CeTask.ref'+i]={multiselect:false};return rule;
 });
 expect(coveredLinkedRules({rules},facts)).toEqual([]);
});
