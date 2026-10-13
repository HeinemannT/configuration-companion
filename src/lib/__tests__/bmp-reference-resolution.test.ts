import { expect,it,vi } from 'vitest';
import { BmpClient } from '../bmp-client';

const identity = {$entries:[['getRid',{identifier:'9000000000000000001'}],['getTypeKey',{typeId:'Scorecard'}],['getModel',{name:'TEMPLATECATEGORY'}]]};
const refs = (count:number) => Array.from({length:count},(_,i)=>({token:'Scorecard:'+i,space:'TEMPLATECATEGORY',id:String(i)}));
function harness(sendCommands=vi.fn(async()=>new ArrayBuffer(0)), values:unknown[]=Array(32).fill(identity)) {
  const transport={sendCommands,deserializeStream:vi.fn(()=>[{$elements:values.map(response=>({response}))}])};
  const client=Object.assign(Object.create(BmpClient.prototype),{transport}) as BmpClient;
  return {client,transport};
}
it('retains 64 successful identities when the third batch fails and stops further dispatch',async()=>{
  const send=vi.fn().mockResolvedValueOnce(new ArrayBuffer(0)).mockResolvedValueOnce(new ArrayBuffer(0)).mockRejectedValueOnce(new Error('offline'));
  const {client}=harness(send);
  const result=await client.resolvePolicyReferences(refs(100));
  expect(send).toHaveBeenCalledTimes(3);
  expect(Object.keys(result.references)).toHaveLength(64);
  expect(result.unavailable).toEqual(refs(100).slice(64).map(r=>r.token));
  expect(result.references['Scorecard:64']).toBeUndefined();
});
it('isolates malformed identities without losing neighbours or confusing missing with failed',async()=>{
  const {client}=harness(undefined,[identity,{},null]);
  const result=await client.resolvePolicyReferences(refs(3));
  expect(result.references).toEqual({'Scorecard:0':{rid:'9000000000000000001',type:'Scorecard',model:'TEMPLATECATEGORY'},'Scorecard:2':null});
  expect(result.unavailable).toEqual(['Scorecard:1']);
});
it('propagates cancellation instead of publishing a partial result',async()=>{
  const abort=new AbortController();
  const send=vi.fn().mockResolvedValueOnce(new ArrayBuffer(0)).mockImplementationOnce(()=>{abort.abort();throw new Error('cancelled');});
  const {client}=harness(send);
  await expect(client.resolvePolicyReferences(refs(33),abort.signal)).rejects.toMatchObject({name:'AbortError'});
});
