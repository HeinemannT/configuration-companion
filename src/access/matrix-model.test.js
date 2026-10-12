import { expect, it, vi } from 'vitest';
import { createMatrixIndex, filterMatrix, typeMatch } from './matrix-model.js';
const c=(Left,Comparison,Right)=>({Condition:{Left,Comparison,Right}});
const children={CeTask:['CeTask'],Scorecard:['Scorecard'],FileResource:['FileResource','URIResource']};
it('combines section filters before evaluating coverage and preserves the full cell actions',()=>{
  const index={roles:[{rid:'1',id:'one',name:'One'}],columns:[
    {id:'Scorecard',group:'Structure'},{id:'CeTask',group:'Enterprise objects'},{id:'ActionButton',group:'Interface objects'}],
    cell:vi.fn(()=>({actions:['Read','Update'],rules:[{}]}))};
  const state={sections:['Enterprise objects'],filters:['Read'],hideEmpty:true,sort:'coverage'};
  expect(filterMatrix(index,state).cols.map(c=>c.id)).toEqual(['CeTask']);
  expect(index.cell.mock.calls.every(([,type])=>type==='CeTask')).toBe(true);
  state.sections.push('Structure');
  expect(filterMatrix(index,state).cols.map(c=>c.id)).toEqual(['Scorecard','CeTask']);
  expect(index.cell('1','CeTask').actions).toEqual(['Read','Update']);
  expect(filterMatrix(index,{...state,typeQ:'action'}).cols).toEqual([]);
  expect(filterMatrix(index,{...state,sections:[]}).cols).toHaveLength(3);
});
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
  expect(typeMatch(c('new.type','Equal','CeTask'),'CeTask','Update',children)).toBe(true);
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
it('includes parent roles and Everyone, excludes disabled rules and never subtracts Deny as a grant',()=>{
  const roles=[{rid:'9000000000000000001',id:'parent',name:'Parent',parent:''},{rid:'9000000000000000002',id:'child',name:'Child',parent:'9000000000000000001'}];
  const make=(rid,Subject,Action,Effect='Allow',enabled=true)=>({rid,name:rid,enabled,content:{Statement:[{Subject,Action,Effect,Resource:c('resource.type','Equal','CeTask')}]}});
  const index=createMatrixIndex({roles,policies:[make('1',['role:parent'],['Read']),make('2','*',['Update']),make('3',['role:child'],['Delete'],'Deny'),make('4','*',['Create'],'Allow',false)]},{CeTask:[],Scorecard:[]},children);
  expect(index.cell(roles[1].rid,'CeTask')).toMatchObject({actions:['Read','Update'],deny:true,conditional:false});
  expect(index.cell(roles[1].rid,'Scorecard').actions).toEqual([]);
  const filtered=filterMatrix(index,{filters:['Create','Read'],hideEmpty:true,sort:'name'});
  expect(filtered.rows).toHaveLength(2);expect(filtered.cols.map(c=>c.id)).toEqual(['CeTask']);
  expect(index.cell(roles[1].rid,'CeTask').actions).toEqual(['Read','Update']);
});
