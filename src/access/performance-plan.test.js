import { expect,it } from 'vitest';
import { clarityFixture } from './__fixtures__/clarity.js';
import { performancePlan,comparePerformance } from './performance-plan.js';
import { performanceFindings } from './performance-findings.js';
import { prepareChecks } from './performance-model.js';
const sample=()=>{const {snapshot,object}=clarityFixture();return {snapshot,objects:[object],assignedUsers:[],scope:{unsampledTypes:[]},problems:[]};};
const timing=(ms,result=true)=>({element:'TraceRequest',durationMs:ms,result,timedOut:false,details:{},children:[]});
export const recorded=(snapshot,c,ms=1,result=true)=>({snapshot,complete:true,checks:[{...c,runs:Array.from({length:5},()=>timing(ms,result)),indexedRuns:Array.from({length:5},()=>timing(ms,result))}]});
it('caps and balances samples without manufacturing Create values or loading a user directory',()=>{
 const d=sample();d.snapshot.model.policies[0].content.Statement[0].Action=['*'];
 d.objects=Array.from({length:30},(_,i)=>({...d.objects[0],rid:String(100+i),id:'risk'+i}));
 d.snapshot.users=Array.from({length:20000},(_,i)=>({rid:String(200+i),id:'user'+i,type:'User'}));
 const p=performancePlan(d);
 expect(p.checks).toHaveLength(48);expect(p.capped).toBe(true);
 expect(new Set(p.checks.map(c=>c.actor.rid)).size).toBe(5);
 expect(new Set(p.checks.map(c=>c.action))).toEqual(new Set(['READ','UPDATE','DELETE']));
 expect(p.checks.filter(c=>c.action==='UPDATE').every(c=>c.request.proposed.properties.name)).toBe(true);
});
it('compares only identical requests, separates access changes and rejects unstable decisions',()=>{
 const d=sample(),c=performancePlan(d).checks[0],before=recorded(d.snapshot,c,2);
 expect(comparePerformance(before,recorded(d.snapshot,c,1))[0]).toMatchObject({faster:true,changed:false});
 expect(comparePerformance(before,recorded(d.snapshot,c,1,false))[0]).toMatchObject({faster:false,changed:true,status:'Access changed'});
 const unstable=recorded(d.snapshot,c,1);unstable.checks[0].indexedRuns[0].result=false;
 expect(comparePerformance(before,unstable)[0]).toMatchObject({faster:false,stable:false});
 expect(comparePerformance(before,recorded(d.snapshot,{...c,request:{...c.request,subject_rid:'different'}},1)).map(r=>r.status)).toEqual(['Not measured','No baseline']);
 expect(comparePerformance({...before,stale:true},recorded(d.snapshot,c))).toEqual([]);
 expect(comparePerformance({...before,historical:true},recorded(d.snapshot,c,1))).toHaveLength(1);
});
it('exposes regressions, missing contexts and mode changes without permission equivalence claims',()=>{
 const d=sample(),c=performancePlan(d).checks[0],before=recorded(d.snapshot,c,1),after=recorded(d.snapshot,c,100);
 expect(comparePerformance(before,after)[0]).toMatchObject({slower:true,faster:false,status:'Slower in this sample'});
 after.checks[0].serverStrategies=['sequential'];before.checks[0].serverStrategies=['indexed'];
 expect(comparePerformance(before,after)[0]).toMatchObject({slower:false,status:'Evaluation mode changed'});
 before.checks[0].serverStrategies=['indexed','sequential'];after.checks[0].serverStrategies=['sequential','indexed','indexed'];
 expect(comparePerformance(before,after)[0]).toMatchObject({slower:false,faster:false,status:'Mixed evaluation modes'});
 after.failures=[{...c,error:'Failed to fetch'}];after.checks=[];
 expect(comparePerformance(before,after)[0]).toMatchObject({missing:true,status:'Measurement failed',error:'Failed to fetch',canOpen:false});
});
it('retains applicable roles and actions when a sampled object is a subtype',()=>{
 const d=sample();d.snapshot.classes={FileResource:[],URIResource:[]};d.snapshot.typeChildren={FileResource:['URIResource']};
 d.objects=[{...d.objects[0],type:'URIResource'}];
 d.snapshot.model.policies=d.snapshot.model.policies.slice(0,1);
 d.snapshot.model.policies[0].content.Statement=[{Subject:'role:'+d.snapshot.model.roles[0].id,Action:['Read'],Resource:{Condition:{Left:'resource.type',Comparison:'Equal',Right:'FileResource'}}}];
 expect(performancePlan(d).checks).toHaveLength(1);
 expect(performancePlan(d).checks[0].actor.id).toBe(d.snapshot.model.roles[0].id);
});
it('does not warn about unavailable operands when another boolean branch serves the action',()=>{
 const d=sample(),s=d.snapshot.model.policies[0].content.Statement[0];s.Action=['Create','Read','Update'];
 const old={Condition:{Left:'resource.type',Comparison:'=',Right:'CeTask'}},fresh={Condition:{Left:'new.type',Comparison:'=',Right:'CeTask'}};
 s.Resource={Any:[old,fresh]};
 expect(performanceFindings(d.snapshot).filter(f=>['create','update','new'].includes(f.id))).toEqual([]);
 s.Resource={All:[old,fresh]};
 expect(performanceFindings(d.snapshot).filter(f=>['create','update','new'].includes(f.id)).map(f=>f.id)).toEqual(['new','create','update']);
 s.Resource={Not:fresh};
 expect(performanceFindings(d.snapshot).filter(f=>['create','update','new'].includes(f.id))).toEqual([]);
});
it('uses the retained median tree rather than adding costs from different runs',()=>{
 const d=sample(),c=performancePlan(d).checks[0],r=recorded(d.snapshot,c);
 r.checks[0].runs=[1,2,3,4,5].map(ms=>timing(ms));
 r.checks[0].runs[2].children=[{element:'Statement',result:true,durationMs:2,details:{policyRid:d.snapshot.model.policies[0].rid,statementIndex:'0'},children:[]}];
 expect(prepareChecks(r,d.snapshot)[0]).toMatchObject({median:3,rules:[{index:0,node:{durationMs:2}}]});
});
it('ignores examples and metadata that look like policy expressions',()=>{
 const d=sample(),s=d.snapshot.model.policies[0].content.Statement[0];s.Action=['Create','Update'];
 s.Resource={All:[],description:{Condition:{Left:'new.type',Comparison:'=',Right:'CeTask'}},comment:'resource.type'};
 expect(performanceFindings(d.snapshot).filter(f=>['create','update','new'].includes(f.id))).toEqual([]);
 s.Resource.All.push({Condition:{Left:'new.type',Comparison:'=',Right:'CeTask'}});
 expect(performanceFindings(d.snapshot).some(f=>f.id==='update')).toBe(true);
});
