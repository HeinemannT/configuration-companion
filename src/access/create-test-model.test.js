import { expect, it } from 'vitest';
import { createInputs, initializeCreate, setCreateValue, setCreateNumber, omitCreateValue, createResource, readCreateValues, testContextRids } from './create-test-model.js';

it('rejects non-text types before starting a schema or destination lookup',()=>{
  for(const type of [42,true,null,{},[]])expect(()=>readCreateValues(JSON.stringify({type}))).toThrow('Object type must be text');
  expect(readCreateValues('{}')).toEqual({});
  expect(readCreateValues('{"type":"CeRiskAssessment"}').type).toBe('CeRiskAssessment');
});
import { proposedForTest, switchTestAction } from './test-request-model.js';

const rid = '9223372036854775806';
it('retains unfinished numbers through action changes and never submits a stale numeric value', () => {
  const check = { action:'Create',proposed:'{"type":"CeComment","properties":{"count":12}}' };
  for (const text of ['-', '1e', '1,5', 'NaN', 'Infinity', '1e999', '0x10']) {
    expect(setCreateNumber(check, 'count', text)).toBe(false);
    expect(check.createNumberDrafts.count).toBe(text);
    expect(readCreateValues(check.proposed).properties.count).toBe(12);
    expect(() => proposedForTest(check)).toThrow('unfinished number');
  }
  const restored = switchTestAction(switchTestAction(check,'Read'),'Create');
  expect(restored.createNumberDrafts.count).toBe('0x10');
  expect(setCreateNumber(restored,'count','1.5e2')).toBe(true);
  expect(proposedForTest(restored).properties.count).toBe(150);
  setCreateNumber(restored,'count','-'); omitCreateValue(restored,'count');
  expect(proposedForTest(restored).properties).not.toHaveProperty('count');
  omitCreateValue(restored,'count'); expect(proposedForTest(restored).properties.count).toBe(150);
  setCreateNumber(restored,'missing','-'); omitCreateValue(restored,'missing');
  expect(Object.keys(restored.createNumberDrafts)).toHaveLength(0);
  setCreateNumber(restored,'count','0'); expect(proposedForTest(restored).properties.count).toBe(0);
  setCreateNumber(restored,'count',''); expect(proposedForTest(restored).properties).not.toHaveProperty('count');
});
const statement = { Resource: { All: [
  { Condition: { Left:'new.type', Comparison:'=', Right:'CeComment' } },
  { Condition: { Left:'new.category', Comparison:'NotEmpty' } },
  { HasAccessTo: { Reference:'new.commentOn', Action:'Update' } },
  { Not:{ Condition:{Left:'new.flag',Comparison:'=',Right:false} } },
  { Condition: { Left:'resource.type',Comparison:'=',Right:'new.notAField' } },
], description:'new.notAField' } };

it('suggests native new operands without supplying values or borrowing resource types', () => {
  const check = { action:'Create', proposed:'{}', resource:'123' };
  initializeCreate(check, statement, ['CeComment']);
  expect(check.createFields).toEqual(['category','commentOn','flag']);
  expect(JSON.parse(check.proposed)).toEqual({type:'CeComment'});
  expect(check.resource).toBe(''); // migration: an old prototype is not a destination
  expect(createInputs({Resource:{Any:[statement.Resource, {Condition:{Left:'new.name',Right:'x'}}]}}).types).toEqual([]);
});

it('preserves extra JSON, exact scalar types, empty values and omitted values across form edits', () => {
  const check = { proposed:JSON.stringify({ type:'CeComment', description:'keep', properties:{flag:false, count:0, name:''}, references:{commentOn:rid} }) };
  omitCreateValue(check, 'name');
  expect(readCreateValues(check.proposed).properties).not.toHaveProperty('name');
  omitCreateValue(check, 'name');
  expect(readCreateValues(check.proposed).properties.name).toBe('');
  setCreateValue(check, 'commentOn', 'references', null);
  expect(readCreateValues(check.proposed)).toEqual({type:'CeComment',description:'keep',properties:{flag:false,count:0,name:''},references:{commentOn:null}});
  check.proposed = '{invalid';
  expect(() => setCreateValue(check,'name','properties','x')).toThrow('Fix the request JSON');
  expect(check.proposed).toBe('{invalid');
});

it('separates child type and parent context; parent omission is an explicit negative test', () => {
  const check = { action:'Create',proposed:'{"type":"CeComment"}' };
  setCreateValue(check,'parent','parent_rid',rid);
  expect(proposedForTest(check,{type:'Organisation'})).toEqual({type:'CeComment',parent_rid:rid});
  omitCreateValue(check,'parent');
  expect(createResource(check)).toBe(rid);
  expect(proposedForTest(check)).toEqual({type:'CeComment'});
  omitCreateValue(check,'parent');
  expect(proposedForTest(check).parent_rid).toBe(rid);
});

it('retains Create fields, destination, JSON view and reference labels across action changes', () => {
  const create = { action:'Create',mode:'role',subject:'123',resource:rid,proposed:JSON.stringify({type:'CeComment',references:{commentOn:'9000000000000000001'}}),createView:'json',createFields:['commentOn'],createInitialized:true,result:{trace:{result:true}} };
  const read = switchTestAction(create,'Read'); read.resource='999';
  const restored = switchTestAction(read,'Create');
  expect(restored).toMatchObject({...create,result:{trace:{result:true},stale:true}});
  expect(testContextRids(read)).toEqual(expect.arrayContaining([rid,'999','9000000000000000001']));
  expect(switchTestAction(restored,'Create')).toBe(restored);
});
