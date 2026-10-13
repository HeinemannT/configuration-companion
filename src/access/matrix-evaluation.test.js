import { expect, it } from 'vitest';
import { evaluateMatrixExpression, coverageStatus, collectMatrixReferences, matrixTypeGraph, DEFINITE, CONDITIONAL, UNRESOLVED } from './matrix-evaluation.js';
import { createMatrixIndex, filterMatrix } from './matrix-model.js';
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
  expect(coverageStatus(evaluate(c('new.type','Equal','CeTIA'),'Update'))).toBe(UNRESOLVED);
});
it('handles unary and empty-list type comparisons',()=>{
  for(const [op,expected] of [['Empty',false],['NotEmpty',true],['Equal',false],['NotEqual',true],['ContainsAny',false],['NotContainsAny',true],['ContainsAll',true],['NotContainsAll',false]])
    expect(evaluate(c('resource.type',op,[])).truth,op).toBe(expected);
});
it('requires a supported branch and does not leak type evidence out of Any',()=>{
  const type=c('resource.type','Equal','CeTIA'), value=c('resource.status','Equal','active'), related={HasAccessTo:{Reference:'resource.owner',Action:'Read'}};
  expect(coverageStatus(evaluate(value))).toBe(UNRESOLVED);
  expect(coverageStatus(evaluate({All:[type,value]}))).toBe(CONDITIONAL);
  expect(coverageStatus(evaluate({Any:[type,related]}))).toBe(DEFINITE);
  expect(coverageStatus(evaluate({All:[{Any:[c('resource.type','Equal','Scorecard'),related]},value]}))).toBe(UNRESOLVED);
  expect(coverageStatus(evaluate({All:[type,related]}))).toBe(UNRESOLVED);
  expect(coverageStatus(evaluate({All:[type,c('resource.model','Equal','DEFAULTS')]}))).toBe(UNRESOLVED);
  expect(coverageStatus(evaluate({All:[type,c('resource.owner','ContainsAny','user')]}))).toBe(UNRESOLVED);
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
  ]),{},children,metadata);
  expect(index.cell('1','Scorecard')).toMatchObject({actions:['Read','Update'],conditionalActions:['Update'],unresolvedActions:['Delete']});
  expect(index.cell('1','Scorecard').unresolvedRules.map(r=>r.policy.rid)).toEqual(['4']);
  expect(filterMatrix(index,{filters:['Delete'],hideEmpty:true}).cols).toHaveLength(0);
  expect(filterMatrix(index,{filters:['Delete'],hideEmpty:true,unresolved:true}).cols.length).toBeGreaterThan(0);
  expect(index.columns.map(c=>c.id)).toContain('InputView');
  expect(index.columns.map(c=>c.id)).not.toContain('Widget');
});
it('reuses projection for inspector changes but invalidates filters and metadata',()=>{
  const m=model([policy('1','*')]),index=createMatrixIndex(m,{CeTIA:[]});
  const result=filterMatrix(index,{hideEmpty:true,sort:'coverage'});
  expect(filterMatrix(index,{hideEmpty:true,sort:'coverage',selected:{role:'1',type:'CeTIA'}})).toBe(result);
  expect(filterMatrix(index,{hideEmpty:true,sort:'coverage',typeQ:'no-match'}).cols).toHaveLength(0);
  const next=createMatrixIndex(m,{},children,metadata);
  expect(filterMatrix(next,{hideEmpty:true,sort:'coverage'})).not.toBe(result);
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
  expect(result({All:[a,c('resource','Equal','Scorecard:unloaded')]})).toMatchObject({actions:[],unresolved:true});
});

it('retains unresolved alternatives independently and shares a single inspector entry across action evidence',()=>{
  const Resource={Any:[{All:[c('resource.type','Equal','Scorecard'),c('resource.parent','NotEmpty')]},{HasAccessTo:{Reference:'resource.owner'}}]};
  const index=createMatrixIndex(model([policy('1',Resource,['Read','Update'])]),{},children,metadata);
  const cell=index.cell('1','Scorecard');
  expect(cell).toMatchObject({actions:['Read','Update'],conditional:true,unresolved:true,unresolvedActions:['Read','Update']});
  expect(cell.rules).toHaveLength(1);expect(cell.unresolvedRules).toHaveLength(1);
  expect(cell.rules[0]).toBe(cell.unresolvedRules[0]);
  expect(cell.rules[0].unresolvedReasons).toContain('Related-object access requires an engine test');
  const definite=createMatrixIndex(model([policy('1',{Any:['*',Resource]})]),{},children,metadata).summary('1','Scorecard');
  expect(definite).toMatchObject({actions:['Read'],conditional:false,unresolved:false});
});
