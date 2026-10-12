import { expect,it } from 'vitest';
import { useCreateDefault,defaultFieldState,resetCreateDefault,changeCreateType } from './create-default-model.js';
import { setCreateValue,omitCreateValue,setCreateNumber } from './create-test-model.js';
it('replaces inherited fields, keeps overrides and resets exact reference RIDs',()=>{
  const q={proposed:'{"type":"CeTask"}',resource:'9000000000000000001'};
  const a={type:'CeTask',properties:{name:'A',count:0},references:{owner:['9000000000000000002']}};
  useCreateDefault(q,{rid:'3'},a);
  setCreateValue(q,'count','properties',2);
  useCreateDefault(q,{rid:'4'},{type:'CeTask',properties:{name:'B',count:8},references:{owner:['9000000000000000004']}});
  expect(JSON.parse(q.proposed)).toEqual({type:'CeTask',properties:{name:'B',count:2},references:{owner:['9000000000000000004']}});
  expect(defaultFieldState(q,'owner').inherited).toBe(true);
  expect(defaultFieldState(q,'count').inherited).toBe(false);
  resetCreateDefault(q,'count');expect(JSON.parse(q.proposed).properties.count).toBe(8);
});
it('keeps per-type inputs separate and restores unfinished overrides',()=>{
  const q={proposed:'{"type":"CeTask","properties":{"name":"Draft"}}',resource:'123',createNumberDrafts:{count:'1e'},createInitialized:true};
  changeCreateType(q,'CeRiskAssessment');expect(JSON.parse(q.proposed)).toEqual({type:'CeRiskAssessment'});expect(q.resource).toBe('');expect(q.createNumberDrafts).toBeUndefined();
  changeCreateType(q,'CeTask');expect(JSON.parse(q.proposed).properties.name).toBe('Draft');expect(q.resource).toBe('123');expect(q.createNumberDrafts).toEqual({count:'1e'});
});

it('preserves deliberate omissions and unfinished numbers when switching defaults',()=>{
  const q={proposed:'{"type":"CeTask"}'};
  useCreateDefault(q,{rid:'1'},{properties:{name:'A',count:10}});
  omitCreateValue(q,'name');setCreateNumber(q,'count','1e');
  useCreateDefault(q,{rid:'2'},{properties:{name:'B',count:20}});
  expect(JSON.parse(q.proposed).properties).toEqual({count:10});
  expect(q.createNumberDrafts.count).toBe('1e');
  resetCreateDefault(q,'name');resetCreateDefault(q,'count');
  expect(JSON.parse(q.proposed).properties).toEqual({name:'B',count:20});
  expect(q.createNumberDrafts.count).toBeUndefined();
});

it('does not let active field edits mutate the stored type snapshot',()=>{
  const q={proposed:'{"type":"CeTask"}',createNumberDrafts:{count:'1e'}};
  changeCreateType(q,'CeRiskAssessment');changeCreateType(q,'CeTask');
  setCreateValue(q,'count','properties',12);
  expect(q.createTypes.CeTask.createNumberDrafts).toEqual({count:'1e'});
});
