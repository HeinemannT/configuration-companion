import { expect, it, vi } from 'vitest';
import { measurePerformance, performanceTypes, sampleObjectsQuery } from './performance';
import type { BmpClient } from '../bmp-client';
import type { AccessTraceNode } from '../types';
import { emptyModel, type AccessSnapshot } from './model';
const request={resource_rid:'9000000000000000001',subject_rid:'9000000000000000002',action:'READ' as const};
const node=(ms:number):AccessTraceNode=>({element:'TraceRequest',durationMs:ms,result:true,timedOut:false,details:{},children:[{element:'Subject',durationMs:ms/2,result:true,timedOut:false,details:{},children:[]}]});
it('warms both modes, alternates reads and retains one full median trace with every decision',async()=>{
  let calls=0;const fetchAccessTrace=vi.fn(async()=>node(++calls));
  const result=await measurePerformance({fetchAccessTrace} as unknown as BmpClient,request,()=>{});
  expect(fetchAccessTrace.mock.calls).toHaveLength(12);
  expect((fetchAccessTrace.mock.calls as unknown[][]).map(c=>c[5])).toEqual([false,true,true,false,false,true,true,false,false,true,true,false]);
  expect((fetchAccessTrace.mock.calls as unknown[][]).every(c=>c[0]===request.resource_rid&&c[1]===request.subject_rid)).toBe(true);
  expect(result.runs.map(r=>r.durationMs)).toEqual([4,5,8,9,12]);
  expect(result.runs.filter(r=>r.children.length).map(r=>r.durationMs)).toEqual([8]);
  expect(result.indexedRuns.map(r=>r.durationMs)).toEqual([3,6,7,10,11]);
  expect(result.serverStrategies).toEqual(Array(5).fill('indexed'));
});
it.each(['Statement','empty'])('does not claim indexed evaluation for %s server traces',async element=>{
  const trace=node(1);trace.children=element==='empty'?[]:[{...node(.5),element}];
  const result=await measurePerformance({fetchAccessTrace:async()=>trace} as unknown as BmpClient,request,()=>{});
  expect(result.serverStrategies).toEqual(Array(5).fill(element==='empty'?'unknown':'sequential'));
});
it.each([undefined,-1,NaN])('rejects unavailable timings (%s)',async ms=>{
  await expect(measurePerformance({fetchAccessTrace:async()=>({...node(1),durationMs:ms})} as unknown as BmpClient,request,()=>{})).rejects.toThrow('incomplete or untimed');
});
it('rejects incomplete nested traces and stops immediately on cancellation or environment change',async()=>{
  const partial=node(1);partial.children[0].timedOut=true;
  await expect(measurePerformance({fetchAccessTrace:async()=>partial} as unknown as BmpClient,request,()=>{})).rejects.toThrow('incomplete');
  const abort=new AbortController(),fetchAccessTrace=vi.fn(async()=>{abort.abort();return node(1);});
  await expect(measurePerformance({fetchAccessTrace} as unknown as BmpClient,request,()=>{},abort.signal)).rejects.toThrow();
  expect(fetchAccessTrace).toHaveBeenCalledTimes(1);
  let changed=false;const fetch=vi.fn(async()=>{changed=true;return node(1);});
  await expect(measurePerformance({fetchAccessTrace:fetch} as unknown as BmpClient,request,()=>{if(changed)throw Error('Environment changed');})).rejects.toThrow('Environment changed');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('samples both business and interface classes with bounded, identifier-checked queries',()=>{
  const snapshot:AccessSnapshot={environment:'test',name:'test',loadedAt:'',roots:{roles:'1',policies:'2'},classes:{CeTask:[],ActionButton:[]},users:[],groups:[],model:emptyModel()};
  snapshot.model.policies.push({rid:'3',id:'p',name:'p',parent:'',enabled:true,content:{Statement:[{Resource:{All:[{Condition:{Left:'resource.type',Comparison:'ContainsAny',Right:['CeTask','ActionButton']}}]}}]}});
  expect(performanceTypes(snapshot)).toEqual(['ActionButton','CeTask']);
  expect(sampleObjectsQuery('CeTask').code).toContain('root.ceTask.descendants');
  expect(sampleObjectsQuery('ActionButton').code).toContain('root.page.descendants');
  expect(sampleObjectsQuery('ActionButton').code).toContain('.first(2 - _count)');
  expect(()=>sampleObjectsQuery('CeTask; delete()')).toThrow();
  snapshot.model.policies[0].content={Statement:[{Resource:{All:[{Condition:{Left:'resource.type',Comparison:'=',Right:'CeTask'}},{Condition:{Left:'resource.type',Comparison:'NotEqual',Right:'ActionButton'}},{Not:{Condition:{Left:'resource.type',Comparison:'=',Right:'ActionButton'}}}],description:{Condition:{Left:'resource.type',Comparison:'=',Right:'ActionButton'}}}}]};
  expect(performanceTypes(snapshot)).toEqual(['CeTask']);
});
