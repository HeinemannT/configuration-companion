// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {CompletionContext} from '@codemirror/autocomplete';
import {analyzePBAC} from './pbac-document.js';
import {pbacCompletionSource} from './pbac-completion.js';
import {rankCompletions} from './completion-ranking.js';

it('ranks abbreviations by native token without matching unrelated explanatory prose',async()=>{
  const {result}=await complete('{"Statement":[{"Resource":{"Condition":{"Comparison":"ConA|"}}}]}');
  expect(result.options.slice(0,2).map(o=>o.label)).toEqual(['ContainsAny','ContainsAll']);
  const rows=Array.from({length:100},(_,i)=>({value:'r'+i,detail:'record '+i}));rows.push({value:'r',detail:'exact'});
  expect(rankCompletions(rows,'r')[0].value).toBe('r');expect(rankCompletions(rows,'r')).toHaveLength(80);
});

async function complete(marked,catalogue=async()=>[]) {
  const pos=marked.indexOf('|'),doc=marked.replace('|',''),state=EditorState.create({doc});
  const context=new CompletionContext(state,pos,true);
  return {result:await pbacCompletionSource(s=>analyzePBAC(s.doc.toString()),catalogue)(context),context,state};
}
it('completes native tokens and replaces whole quoted values without doubling quotes',async()=>{
  const {result,state}=await complete('{"Statement":[{"Effect":"Al|"}]}');
  expect(result.options.map(o=>o.label)).toEqual(['Allow']);
  const view=new EditorView({state,parent:document.body});
  try {result.options[0].apply(view,result.options[0],result.from,result.to);expect(JSON.parse(view.state.doc.toString()).Statement[0].Effect).toBe('Allow');}finally{view.destroy();}
  const actions=await complete('{"Statement":[{"Action": |}]}');
  const v=new EditorView({state:actions.state,parent:document.body});
  try {actions.result.options[0].apply(v,actions.result.options[0],actions.result.from,actions.result.to);expect(JSON.parse(v.state.doc.toString()).Statement[0].Action).toEqual(['Create']);}finally{v.destroy();}
});
it('filters role suggestions by their readable names while inserting business IDs',async()=>{
  const catalogue=vi.fn(async()=>[{value:'role:original_tax_admin',detail:'Tax administrator'}]);
  const {result}=await complete('{"Statement":[{"Subject":["role:administrator|"]}]}',catalogue);
  expect(result.options.map(o=>o.label)).toEqual(['role:original_tax_admin']);
  expect(catalogue.mock.calls[0][0]).toMatchObject({kind:'subjects',rolePrefix:true});
  expect(catalogue.mock.calls[0][1]).toBeInstanceOf(globalThis.AbortSignal);
});
it('does not offer PBAC fields inside annotations or arbitrary literal objects',async()=>{
  for(const marked of ['{"comment":{"Effect":"Al|"}}','{"Statement":[{"Resource":{"Condition":{"Right":{"Ef|":1}}}}]}']) {
    expect((await complete(marked)).result).toBeNull();
  }
});

it('repairs unfinished quoted tokens and does not insert fields where a comma is missing',async()=>{
  for(const marked of ['{"Statement":[{"Effect":"Al|','{"Statement":[{"Eff|']) {
    const {result,state}=await complete(marked);
    expect(result.options[0].label).toBe(marked.endsWith('Al|')?'Allow':'Effect');
    const view=new EditorView({state,parent:document.body});
    try {
      result.options[0].apply(view,result.options[0],result.from,result.to);
      expect(view.state.doc.toString()).toBe(marked.endsWith('Al|')?'{"Statement":[{"Effect":"Allow"':'{"Statement":[{"Effect": ');
    }finally{view.destroy();}
  }
  expect((await complete('{"Statement":[{"Effect":"Allow" |}]}')).result).toBeNull();
  expect((await complete('{"Statement":[{"Eff|ect":"Allow"}]}')).result.options[0].label).toBe('Effect');
});

it('only offers the wildcard as a scalar Subject, never as an entry in a subject array',async()=>{
  expect((await complete('{"Statement":[{"Subject": |}]}')).result.options.map(o=>o.label)).toContain('*');
  expect((await complete('{"Statement":[{"Subject":["|"]}]}')).result.options.map(o=>o.label)).not.toContain('*');
});
