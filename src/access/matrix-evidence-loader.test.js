import { expect,it,vi } from 'vitest';
import { createMatrixEvidenceLoader } from './matrix-evidence-loader.js';
const fact={rid:'9000000000000000001',type:'Scorecard',model:'TEMPLATECATEGORY'};
const response=references=>({types:{Identifiable:{parents:[],concrete:false}},models:{},references,unavailable:[],unsupported:[]});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

it('retains partial evidence, retries only failures, and never retries on repeated renders',async()=>{
  const load=vi.fn().mockResolvedValueOnce({...response({a:fact,b:null}),unavailable:['c']}).mockResolvedValueOnce(response({c:fact}));
  const loader=createMatrixEvidenceLoader({load,validate:vi.fn(),changed:vi.fn()}),key={};
  await loader.ensure(key,['a','b','c']);
  expect(loader.read()).toMatchObject({canRetry:true,value:{references:{a:fact,b:null}}});
  loader.ensure(key,()=>{throw new Error('Do not recollect');});expect(load).toHaveBeenCalledTimes(1);
  await loader.retry();
  expect(load.mock.calls[1][0]).toEqual(['c']);
  expect(loader.read()).toMatchObject({canRetry:false,value:{references:{a:fact,b:null,c:fact}}});
});
it('exposes bounded continuation without silently dropping references',async()=>{
  const load=vi.fn(async tokens=>response(Object.fromEntries(tokens.map(t=>[t,fact]))));
  const loader=createMatrixEvidenceLoader({load,validate:vi.fn(),changed:vi.fn()});
  const tokens=Array.from({length:2001},(_,i)=>String(i));
  await loader.ensure({},tokens);
  expect(loader.read()).toMatchObject({remaining:1,canRetry:false});
  expect(loader.read().status).toContain('2000 / 2001');
  expect(load.mock.calls[0][0]).toHaveLength(2000);
  await loader.more();expect(load.mock.calls[1][0]).toEqual(['2000']);
  expect(Object.keys(loader.read().value.references)).toHaveLength(2001);
  expect(loader.read().status).toBe('');
});
it('recovers from a failed catalogue load even when there are no reference tokens',async()=>{
  const load=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response({}));
  const loader=createMatrixEvidenceLoader({load,validate:vi.fn(),changed:vi.fn()});
  await loader.ensure({},[]);expect(loader.read()).toMatchObject({canRetry:true,value:null});
  await loader.retry();expect(loader.read()).toMatchObject({canRetry:false,loading:false});
  expect(loader.read().value.types).toBeDefined();
});
it('ignores obsolete responses after source changes or reset, even when transport ignores abort',async()=>{
  const old=deferred(),fresh=deferred(),validate=vi.fn(),changed=vi.fn();
  const load=vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const loader=createMatrixEvidenceLoader({load,validate,changed});
  const first=loader.ensure({},['a']),second=loader.ensure({},['b']);
  expect(load.mock.calls[0][1].aborted).toBe(true);
  old.resolve(response({a:fact}));await first;expect(validate).not.toHaveBeenCalled();
  fresh.resolve(response({b:fact}));await second;
  expect(loader.read().value.references).toEqual({b:fact});
  loader.reset();expect(loader.read().value).toBeNull();
});
it('keeps previous evidence when validation of a continuation fails',async()=>{
  const load=vi.fn().mockResolvedValueOnce(response({a:fact})).mockResolvedValueOnce(response({b:fact}));
  const validate=vi.fn().mockImplementationOnce(()=>{}).mockImplementationOnce(()=>{throw new Error('invalid ancestry');});
  const loader=createMatrixEvidenceLoader({load,validate,changed:vi.fn(),batchSize:1});
  await loader.ensure({},['a','b']);await loader.more();
  expect(loader.read()).toMatchObject({canRetry:true,value:{references:{a:fact}}});
  expect(loader.read().value.references.b).toBeUndefined();
});
it('reports unsupported tokens without offering pointless retries',async()=>{
  const loader=createMatrixEvidenceLoader({load:async()=>({...response({}),unsupported:['x']}),validate:vi.fn(),changed:vi.fn()});
  await loader.ensure({},['x']);expect(loader.read()).toMatchObject({canRetry:false,status:'0 / 1 references resolved · 1 unsupported'});
});
