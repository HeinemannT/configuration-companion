import {expect,it} from 'vitest';
import {analyzePBAC} from './pbac-document.js';
import {completionSite,completionTarget,policyFolds,diagnosticFixes} from './pbac-assist.js';

const site = marked => {
  const pos=marked.indexOf('|'),text=marked.replace('|','');
  return completionSite(text,analyzePBAC(text),pos);
};
it('locates keys, empty values and typed values in incomplete PBAC JSON',()=>{
  for(const marked of ['{"Statement":[{"Ef|"}]}','{"Statement":[{ |}]}']) {
    const s=site(marked);expect(s.kind).toBe('key');expect(s.path).toEqual(['Statement',0]);
    expect(completionTarget(s).keys).toContain('Effect');
  }
  expect(completionTarget(site('{"Statement":[{"Effect": |}]}'))).toEqual({kind:'effects'});
  expect(completionTarget(site('{"Statement":[{"Subject":["role:rev|"]}]}'))).toMatchObject({kind:'subjects',rolePrefix:true,bare:false});
  expect(completionTarget(site('{"Statement":[{"Action": |}]}'))).toEqual({kind:'actions',bare:true});
  expect(completionTarget(site('{"Statement":[{"description":"Allow |Read"}]}'))).toEqual({kind:'none'});
  expect(completionTarget(site('{"metadata":{"Effect":"Al|"}}'))).toEqual({kind:'none'});
});
it('infers metadata from the matching branch and never borrows resource types for new',()=>{
  const prefix='{"Statement":[{"Resource":{"All":[{"Condition":{"Left":"resource.type","Comparison":"=","Right":"CeTask"}},';
  const left=site(prefix+'{"Condition":{"Left":"resource.ow|"}}]}}]}');
  expect(completionTarget(left)).toMatchObject({kind:'properties',types:['CeTask'],scope:'resource'});
  expect(completionTarget(site(prefix+'{"Condition":{"Left":"new.ow|"}}]}}]}')).types).toEqual([]);
  expect(completionTarget(site(prefix+'{"Condition":{"Left":"resource.scope","Right":["Li|"]}}]}}]}'))).toMatchObject({kind:'values',types:['CeTask'],field:'scope'});
  expect(completionTarget(site(prefix+'{"HasAccessTo":"resource.ow|"}]}}]}'))).toMatchObject({kind:'properties',reference:true,types:['CeTask']});
  expect(completionTarget(site('{"Statement":[{"Resource":{"Condition":{"Left":42,"Right":"|"}}}]}'))).toMatchObject({kind:'values',types:[]});
});
it('folds policy statements with native actions and locates errors inside a collapsed rule',()=>{
  const value={Version:'1.0',Statement:[{description:'Review access',Subject:'*',Effect:'Allow',Action:['Read'],Resource:{Condition:{Left:'resource.type',Comparison:'contains any',Right:['CeTask']}}}]};
  const text=JSON.stringify(value,null,2),analysis=analyzePBAC(text),fold=policyFolds(text,analysis).find(f=>f.path.length===2);
  expect(fold.label).toContain('Rule 1 · Allow · Read');expect(fold.errors).toBe(1);expect(fold.title).toBe('Review access');
  const [fix]=diagnosticFixes(text,analysis).get(0);expect(fix.label).toBe('Use ContainsAny');
  const change=fix.changes[0], fixed=text.slice(0,change.from)+change.insert+text.slice(change.to);
  expect(analyzePBAC(fixed).valid).toBe(true);expect(JSON.parse(fixed).Statement[0].description).toBe('Review access');
});
it('repairs only actual trailing commas, with no guesses about permissions or ambiguous syntax',()=>{
  const text=String.raw`{"description":"literal ,} and \"", "Statement":[],}`, analysis=analyzePBAC(text);
  const fix=diagnosticFixes(text,analysis).get(0)?.[0];expect(fix?.changes).toHaveLength(1);
  expect(text.slice(fix.changes[0].from,fix.changes[0].to)).toBe(',');
  for(const text of ['{"Statement":[{]}','{"Version":"1.0" "Statement":[],}','{"Statement":[{"Effect":"Grant"}]}']) expect(diagnosticFixes(text,analyzePBAC(text)).size).toBe(0);
});
