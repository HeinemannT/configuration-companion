import { expect, it } from 'vitest';
import { evaluateMatrixExpression, coverageStatus, conditionKinds, collectMatrixReferences, matrixTypeGraph, DEFINITE, CONDITIONAL, UNRESOLVED } from './matrix-evaluation';
import { createMatrixIndex } from './matrix-model';
import { transposeMatrix, matrixGridState } from './matrix-grid.js';
const c = (Left, Comparison, Right) => ({ Condition:{Left, Comparison, Right} });
const metadata = { types:{Identifiable:{parents:[],concrete:false},Scorecard:{parents:['Identifiable'],concrete:true},CeTIA:{parents:['Identifiable'],concrete:true},Widget:{parents:['Identifiable'],concrete:false},InputView:{parents:['Widget'],concrete:true}},
  references:{'Scorecard:landing':{rid:'9000000000000000001',type:'Scorecard',model:'TEMPLATECATEGORY'},'Widget:sharedNamespace':{rid:'9000000000000000002',type:'InputView',model:'PAGE'}},models:{} };
const children = matrixTypeGraph(metadata);
const evaluate = (e, action='Read', type='CeTIA') => evaluateMatrixExpression(e,{action,type,metadata,children,roleIds:new Set(['auditor'])});
const policy = (rid, Resource, Action=['Read']) => ({rid,name:rid,enabled:true,content:{Statement:[{Subject:'*',Effect:'Allow',Action,Resource}]}});
const model = policies => ({roles:[{rid:'1',id:'auditor',name:'Auditor',parent:''}],policies});
it('uses the engine absent-value semantics, not generic negative inversion',()=>{
  for (const op of ['NotContains','NotContainsAny','NotContainsAll']) {
    expect(evaluate(c('resource.type',op,['Scorecard']),'Create').truth).toBe(false);
    for (const action of ['Read','Delete']) expect(evaluate(c('new.type',op,['Scorecard']),action).truth).toBe(false);
  }
  expect(evaluate(c('resource.type','NotEqual','Scorecard'),'Create').truth).toBe(true);
  // A submitted-change test is a known kind of condition: conditional, not unresolved.
  const submitted=evaluate(c('new.type','Equal','CeTIA'),'Update');
  expect(coverageStatus(submitted)).toBe(CONDITIONAL);
  expect(conditionKinds(submitted)).toEqual({kinds:['some'],gaps:[]});
});
it('handles unary and empty-list type comparisons',()=>{
  for(const [op,expected] of [['Empty',false],['NotEmpty',true],['Equal',false],['NotEqual',true],['ContainsAny',false],['NotContainsAny',true],['ContainsAll',true],['NotContainsAll',false]])
    expect(evaluate(c('resource.type',op,[])).truth,op).toBe(expected);
});
it('requires a supported branch and does not leak type evidence out of Any',()=>{
  const type=c('resource.type','Equal','CeTIA'), value=c('resource.status','Equal','active'), related={HasAccessTo:{Reference:'resource.owner',Action:'Read'}};
  const gap=c('resource.linkedTo','Equal','Scorecard:missing');
  const kinds=e=>conditionKinds(evaluate(e)).kinds;
  // A known kind of condition is conditional with or without a type guard.
  expect(coverageStatus(evaluate(value))).toBe(CONDITIONAL);
  expect(kinds(value)).toEqual(['some']);
  expect(coverageStatus(evaluate({All:[type,value]}))).toBe(CONDITIONAL);
  expect(coverageStatus(evaluate({Any:[type,related]}))).toBe(DEFINITE);
  expect(coverageStatus(evaluate({All:[{Any:[c('resource.type','Equal','Scorecard'),related]},value]}))).toBe(CONDITIONAL);
  expect(kinds({All:[{Any:[c('resource.type','Equal','Scorecard'),related]},value]})).toEqual(['related','some']);
  expect(coverageStatus(evaluate({All:[type,related]}))).toBe(CONDITIONAL);
  expect(kinds({All:[type,related]})).toEqual(['related']);
  expect(coverageStatus(evaluate({All:[type,c('resource.model','Equal','DEFAULTS')]}))).toBe(CONDITIONAL);
  expect(kinds({All:[type,c('resource.model','Equal','DEFAULTS')]})).toEqual(['model']);
  expect(coverageStatus(evaluate({All:[type,c('resource.owner','ContainsAny','user')]}))).toBe(CONDITIONAL);
  expect(kinds({All:[type,c('resource.owner','ContainsAny','user')]})).toEqual(['own']);
  // A type guard in one Any branch does not carry a sibling gap: the gap alone stays unresolved.
  expect(coverageStatus(evaluate({Any:[related,gap]}))).toBe(UNRESOLVED);
  expect(coverageStatus(evaluate({Any:[{All:[type,value]},gap]}))).toBe(CONDITIONAL);
});
it('maps each reason group to its condition kind and returns other reasons as gaps',()=>{
  const reasons=(...r)=>conditionKinds({reasons:r,unresolvedReasons:[]});
  expect(reasons('Personal access requires a User test')).toEqual({kinds:['own'],gaps:[]});
  expect(reasons('Related-object access requires an engine test')).toEqual({kinds:['related'],gaps:[]});
  expect(reasons('Role membership requires evaluation')).toEqual({kinds:['related'],gaps:[]});
  expect(reasons('Model-restricted access; test an object in that model')).toEqual({kinds:['model'],gaps:[]});
  for(const r of ['Depends on object or submitted field values','Depends on submitted changes','Only the referenced objects','Only objects linked to these templates','Reference exclusion requires object values'])
    expect(reasons(r)).toEqual({kinds:['some'],gaps:[]});
  // Kinds come back in matrix order, from both reason lists, once each.
  expect(conditionKinds({reasons:['Depends on submitted changes','Personal access requires a User test'],unresolvedReasons:['Role membership requires evaluation','Object reference unavailable or missing']}))
    .toEqual({kinds:['own','related','some'],gaps:['Object reference unavailable or missing']});
  for(const r of ['Object reference unavailable or missing','Type inheritance unavailable','Unsupported expression','Ambiguous expression','Invalid or unresolved type operand','Operand requires engine evaluation'])
    expect(reasons(r)).toEqual({kinds:[],gaps:[r]});
});
it('is unresolved for a gap alone or a condition beside a gap with no type guard, conditional once a guard matched',()=>{
  const reasons=['Depends on object or submitted field values'], gaps=['Object reference unavailable or missing'];
  const fact=(anchored,r,u=[])=>({truth:null,anchored,blocked:false,reasons:r,unresolvedReasons:u});
  expect(coverageStatus(fact(false,gaps))).toBe(UNRESOLVED);
  expect(coverageStatus(fact(true,gaps))).toBe(UNRESOLVED);
  expect(coverageStatus(fact(false,reasons,gaps))).toBe(UNRESOLVED);
  expect(coverageStatus(fact(true,reasons,gaps))).toBe(CONDITIONAL);
  expect(coverageStatus(fact(false,reasons))).toBe(CONDITIONAL);
  expect(coverageStatus({truth:true,reasons:[]})).toBe(DEFINITE);
});
it('only resolves literal identities used by the coverage evaluator',()=>{
  expect(collectMatrixReferences(model([policy('1',{All:[c('resource','Equal','Widget:sharedNamespace'),c('resource.owner','Equal','User:john')]}),policy('2',c('resource.linkedTo','ContainsAny',['Scorecard:landing']))]))).toEqual(['Widget:sharedNamespace','Scorecard:landing']);
});
it('resolves actual reference classes and excludes impossible scalar identities',()=>{
  for(const left of ['resource','resource.linkedTo']) {
    expect(evaluate(c(left,'ContainsAny',['Scorecard:landing'])).truth).toBe(false);
    expect(coverageStatus(evaluate(c(left,'ContainsAny',['Scorecard:landing']),'Read','Scorecard'))).toBe(CONDITIONAL);
    expect(evaluate(c(left,'ContainsAll',['Scorecard:landing','Widget:sharedNamespace'])).truth).toBe(false);
  }
  expect(coverageStatus(evaluate(c('resource','Equal','Widget:sharedNamespace'),'Read','InputView'))).toBe(CONDITIONAL);
  expect(coverageStatus(evaluate(c('resource.linkedTo','Equal','Scorecard:missing')))).toBe(UNRESOLVED);
});
it('keeps per-action certainty and unresolved evidence out of default coverage',()=>{
  const index=createMatrixIndex(model([
    policy('1','*'), policy('2',c('resource.linkedTo','ContainsAny',['Scorecard:landing'])),
    policy('3',{All:[c('resource.type','Equal','Scorecard'),c('resource.owner','NotEmpty')]},['Update']),
    policy('4',{HasAccessTo:{Reference:'resource.owner'}},['Delete']),
    policy('5',c('new.type','Equal','Scorecard:landing'),['Create']),
  ]),{},children,metadata);
  // Delete hangs on a known condition (related object): conditional, with its kind. Create has an unreadable
  // statement: unresolved, and not an operation the cell grants.
  expect(index.cell('1','Scorecard')).toMatchObject({actions:['Read','Update','Delete'],conditionalActions:['Update','Delete'],unresolvedActions:['Create'],
    kinds:{Update:['some'],Delete:['related']}});
  expect(index.cell('1','Scorecard').unresolvedRules.map(r=>r.policy.rid)).toEqual(['5']);
  expect(index.cell('1','Scorecard').rules.map(r=>r.policy.rid)).toEqual(['1','2','3','4']);
  expect(index.summary('1','Scorecard')).toMatchObject({conditionalActions:['Update','Delete'],unresolvedActions:['Create'],kinds:{Update:['some'],Delete:['related']}});
  const types=(lens,s)=>transposeMatrix(index,{...matrixGridState(),lens,...s}).rows.filter(r=>r.kind==='type');
  // Hide empty keeps only answers that grant something; the unreadable Create question stays a '?' in the counts.
  expect(types('Create',{})).toHaveLength(0);
  expect([...transposeMatrix(index,{...matrixGridState(),lens:'Create'}).bands[0].counts.values()][0].text).toMatch(/\?/);
  // A conditional operation is not a '?': Delete counts as a grant under a condition.
  expect(types('Delete',{}).length).toBeGreaterThan(0);
  expect([...transposeMatrix(index,{...matrixGridState(),lens:'Delete'}).bands[0].counts.values()][0].text).not.toMatch(/\?/);
  expect(index.columns.map(c=>c.id)).toContain('InputView');
  expect(index.columns.map(c=>c.id)).not.toContain('Widget');
});
it('does not turn missing fallback type edges into negative-comparator grants',()=>{
  const m=model([policy('1',c('resource.type','NotEqual','Scorecard'))]);
  const fallback={Scorecard:['Scorecard'],CeTIA:['CeTIA']};
  expect(createMatrixIndex(m,{CeTIA:[]},fallback).summary('1','CeTIA')).toMatchObject({actions:[],unresolvedActions:['Read']});
  expect(createMatrixIndex(m,{CeTIA:[]},fallback,metadata).summary('1','CeTIA').actions).toEqual(['Read']);
});
it('separates actor-dependent HasRole from shared Everyone evidence',()=>{
  const m=model([policy('1',{HasRole:{Reference:'resource.owner',Roles:['auditor']}})]);
  m.roles.push({rid:'2',id:'reader',name:'Reader',parent:''},{rid:'3',id:'child',name:'Child',parent:'1'});
  const index=createMatrixIndex(m,{CeTIA:[]},children,metadata);
  expect(index.summary('1','CeTIA').actions).toEqual(['Read']);
  expect(index.summary('2','CeTIA').actions).toEqual([]);
  expect(index.summary('3','CeTIA').actions).toEqual(['Read']);
});

it('excludes contradictions in the same All without mixing alternative or collection constraints',()=>{
  const type=c('resource.type','Equal','Scorecard'), empty=c('resource.parent','Empty'), notEmpty=c('resource.parent','NotEmpty');
  const a=c('resource','Equal','Scorecard:a'), b=c('resource','Equal','Scorecard:b');
  const meta={...metadata,references:{...metadata.references,
    'Scorecard:a':{rid:'9000000000000000003',type:'Scorecard',model:'TEMPLATECATEGORY'},
    'Scorecard:b':{rid:'9000000000000000004',type:'Scorecard',model:'TEMPLATECATEGORY'},
    'Scorecard:alias':{rid:'9000000000000000003',type:'Scorecard',model:'TEMPLATECATEGORY'}}};
  const result=Resource=>createMatrixIndex(model([policy('1',Resource)]),{},children,meta).summary('1','Scorecard');
  for(const expression of [{All:[a,b]},{All:[type,empty,{All:[notEmpty]}]},
    {All:[type,c('resource.name','=','active'),c('resource.name','NotEqual','active')]},
    {All:[c('resource.linkedTo','ContainsAny',['Scorecard:a']),c('resource.linkedTo','ContainsAll',['Scorecard:b'])]}])
    expect(result(expression)).toMatchObject({actions:[],unresolved:false});
  for(const expression of [{Any:[{All:[type,empty]},{All:[type,notEmpty]}]},
    {All:[a,c('resource','Equal','Scorecard:alias')]},
    {All:[a,c('resource','ContainsAny',['Scorecard:a','Scorecard:b'])]},
    {All:[type,c('resource.owners','ContainsAny',['Scorecard:a']),c('resource.owners','ContainsAny',['Scorecard:b'])]}])
    expect(result(expression).actions).toEqual(['Read']);
  // Nothing readable: unresolved. A matched object test beside an unloaded one still names the condition.
  expect(result(c('resource.linkedTo','Equal','Scorecard:unloaded'))).toMatchObject({actions:[],unresolved:true,unresolvedActions:['Read'],conditional:false});
  expect(result({All:[a,c('resource','Equal','Scorecard:unloaded')]})).toMatchObject({actions:['Read'],conditionalActions:['Read'],conditional:true,unresolved:false,kinds:{Read:['some']}});
});

it('retains unresolved alternatives independently and shares a single inspector entry across action evidence',()=>{
  const Resource={Any:[{All:[c('resource.type','Equal','Scorecard'),c('resource.parent','NotEmpty')]},{HasAccessTo:{Reference:'resource.owner'}}]};
  const index=createMatrixIndex(model([policy('1',Resource,['Read','Update'])]),{},children,metadata);
  const cell=index.cell('1','Scorecard');
  // Both branches are known conditions (object values, related object): conditional, nothing unresolved.
  expect(cell).toMatchObject({actions:['Read','Update'],conditional:true,unresolved:false,unresolvedActions:[],conditionalActions:['Read','Update']});
  expect(cell.kinds.Read).toEqual(['related','some']);expect(cell.kinds.Update).toEqual(['related','some']);
  expect(cell.rules).toHaveLength(1);expect(cell.unresolvedRules).toHaveLength(0);
  expect(cell.rules[0].kinds).toEqual({Read:['related','some'],Update:['related','some']});
  // The same statement with a gap beside the condition and no type guard: one entry, shared by both lists.
  const gapIndex=createMatrixIndex(model([policy('1',{Any:[c('resource.linkedTo','Equal','Scorecard:missing'),{HasAccessTo:{Reference:'resource.owner'}}]},['Read','Update'])]),{},children,metadata);
  const gapCell=gapIndex.cell('1','Scorecard');
  expect(gapCell).toMatchObject({actions:[],unresolved:true,unresolvedActions:['Read','Update']});
  expect(gapCell.unresolvedRules).toHaveLength(1);
  expect(gapCell.unresolvedRules[0].unresolvedReasons).toContain('Object reference unavailable or missing');
  const definite=createMatrixIndex(model([policy('1',{Any:['*',Resource]})]),{},children,metadata).summary('1','Scorecard');
  expect(definite).toMatchObject({actions:['Read'],conditional:false,unresolved:false});
});
it('summarises the kind of condition: own for owner = user, related for HasAccessTo',()=>{
  const kinds=(Resource,action='Read')=>createMatrixIndex(model([policy('1',{All:[c('resource.type','Equal','Scorecard'),Resource]},[action])]),{},children,metadata).summary('1','Scorecard');
  expect(kinds(c('resource.owner','Equal','user'))).toMatchObject({actions:['Read'],conditionalActions:['Read'],unresolvedActions:[],unresolved:false,kinds:{Read:['own']}});
  expect(kinds({HasAccessTo:{Reference:'resource.owner'}},'Update')).toMatchObject({conditionalActions:['Update'],unresolved:false,kinds:{Update:['related']}});
  expect(kinds(c('resource.status','Equal','active')).kinds).toEqual({Read:['some']});
  const open=createMatrixIndex(model([policy('1',c('resource.owner','Equal','user'))]),{},children,metadata);
  expect(open.cell('1','Scorecard').kinds).toEqual({Read:['own']});
  expect(open.cell('1','Scorecard').unresolvedRules).toEqual([]);
});
