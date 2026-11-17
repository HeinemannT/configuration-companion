import { expect, it } from 'vitest';
import { createMatrixIndex, typeMatch } from './matrix-model';
import { transposeMatrix, matrixGridState } from './matrix-grid.js';
const c=(Left,Comparison,Right)=>({Condition:{Left,Comparison,Right}});
const children={CeTask:['CeTask'],Scorecard:['Scorecard'],FileResource:['FileResource','URIResource']};
it('respects BMP scalar, collection and subtype comparator semantics',()=>{
  expect(typeMatch(c('resource.type','Contains',['CeTask','Scorecard']),'CeTask','Read',children)).toBe(true);
  expect(typeMatch(c('resource.type','Contains','CeTask'),'CeTask','Read',children)).toBe(false);
  expect(typeMatch(c('resource.type','ContainsAll',['CeTask','Scorecard']),'CeTask','Read',children)).toBe(false);
  expect(typeMatch(c('resource.type','ContainsAny',['Scorecard']),'CeTask','Read',children)).toBe(false);
  expect(typeMatch(c('resource.type','NotContainsAny',['Scorecard']),'CeTask','Read',children)).toBe(true);
  expect(typeMatch(c('resource.type','Equal','FileResource'),'URIResource','Read',children)).toBe(true);
  expect(typeMatch(c('resource.type','ExactTypeOf','FileResource'),'URIResource','Read',children)).toBe(false);
  expect(typeMatch(c('resource.type','ExactTypeOf',['CeTask']),'CeTask','Read',children)).toBe(false);
  expect(typeMatch(c('new.type','Equal','CeTask'),'CeTask','Create',children)).toBe(true);
  expect(typeMatch(c('new.type','Equal','CeTask'),'CeTask','Update',children)).toBe(null);
  expect(typeMatch(c('resource.type','Equal','CeTask'),'CeTask','Create',children)).toBe(false);
  expect(typeMatch(c('resource.type','Equal','UnloadedBase'),'CeTask','Read',children)).toBe(null);
});
it('combines logical constraints conservatively instead of flattening Any into All',()=>{
  const type=c('resource.type','Equal','CeTask'), property=c('resource.owner','Equal','user');
  expect(typeMatch({All:[type,property]},'CeTask','Read',children)).toBe(null);
  expect(typeMatch({All:[type,property]},'Scorecard','Read',children)).toBe(false);
  expect(typeMatch({Any:[type,property]},'Scorecard','Read',children)).toBe(null);
  expect(typeMatch({Any:[type,property]},'CeTask','Read',children)).toBe(true);
});
it('includes parent roles and Everyone, excludes disabled rules and gives Deny no effect',()=>{
  const roles=[{rid:'9000000000000000001',id:'parent',name:'Parent',parent:''},{rid:'9000000000000000002',id:'child',name:'Child',parent:'9000000000000000001'}];
  const make=(rid,Subject,Action,Effect='Allow',enabled=true)=>({rid,name:rid,enabled,content:{Statement:[{Subject,Action,Effect,Resource:c('resource.type','Equal','CeTask')}]}});
  const index=createMatrixIndex({roles,policies:[make('1',['role:parent'],['Read']),make('2','*',['Update']),make('3',['role:child'],['Delete'],'Deny'),make('4','*',['Create'],'Allow',false)]},{CeTask:[],Scorecard:[]},children);
  expect(index.cell(roles[1].rid,'CeTask')).toMatchObject({actions:['Read','Update'],conditional:false});
  // Grant-only engine: the Deny statement is not indexed, adds no mark and lists no rule.
  expect(index.cell(roles[1].rid,'CeTask').rules.map(r=>r.policy.rid).sort()).toEqual(['1','2']);
  expect(index.cell(roles[1].rid,'CeTask')).not.toHaveProperty('deny');
  expect(index.rules.some(r=>r.statement.Effect==='Deny')).toBe(false);
  expect(index.cell(roles[1].rid,'Scorecard').actions).toEqual([]);
  const read=transposeMatrix(index,{...matrixGridState(),lens:'Read',unresolved:false});
  expect(read.roles).toHaveLength(2);expect(read.rows.filter(r=>r.kind==='type').map(r=>r.id)).toEqual(['CeTask']);
  expect(transposeMatrix(index,{...matrixGridState(),lens:'Create',unresolved:false}).rows.filter(r=>r.kind==='type')).toHaveLength(0);
  expect(index.cell(roles[1].rid,'CeTask').actions).toEqual(['Read','Update']);
});
