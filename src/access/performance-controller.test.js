import {expect,it,vi} from 'vitest';
import {clarityFixture} from './__fixtures__/clarity.js';
import {createPerformanceController,PERFORMANCE_BUDGET_MS} from './performance-controller.js';
const fixture=()=>{const {snapshot,object}=clarityFixture();return {snapshot,objects:[object],assignedUsers:[],scope:{unsampledTypes:[]},problems:[]};};
const result=()=>({runs:Array(5).fill({durationMs:1,result:true}),indexedRuns:Array(5).fill({durationMs:1,result:true})});
it('retains a finished baseline across edits and reruns the exact same requests',async()=>{
 let d=fixture();const api=vi.fn(async r=>r.operation==='performanceDiscover'?structuredClone(d):r.operation==='load'?{snapshot:structuredClone(d.snapshot)}:result());
 const c=createPerformanceController({api,getSnapshot:()=>d.snapshot});await c.run();
 expect(c.state.current.complete).toBe(true);const before=c.state.current,requests=api.mock.calls.filter(([r])=>r.operation==='performanceMeasure').map(([r])=>r.request);
 c.invalidate();d=structuredClone(d);d.snapshot.model.policies[0].name='Edited';await c.run(true);
 expect(c.state.previous).toBe(before);expect(before.historical).toBe(true);expect(before.stale).toBe(false);
 expect(api.mock.calls.filter(([r])=>r.operation==='performanceMeasure').slice(requests.length).map(([r])=>r.request)).toEqual(requests);
});
it('profiles a prepared request without discovering or adding other contexts',async()=>{
 const d=fixture(),api=vi.fn(async r=>r.operation==='load'?{snapshot:d.snapshot}:result()),actor={...d.snapshot.model.roles[0],kind:'role'};
 const c=createPerformanceController({api,getSnapshot:()=>d.snapshot});const request={resource_rid:'1',subject_rid:actor.rid,action:'CREATE',proposed:{type:'CeTask',parent_rid:'1',properties:{name:'draft'}}};
 await c.run(false,{id:'prepared',actor,object:{...d.objects[0],type:'CeTask'},action:'CREATE',request});
 expect(api.mock.calls.map(([r])=>r.operation)).toEqual(['load','performanceMeasure','load']);
 expect(api.mock.calls[1][0].request).toBe(request);
});
it('discards late results after Stop and does not let an old run overwrite a newer one',async()=>{
 const d=fixture();let finish,signal;const api=vi.fn(async(r,o)=>{if(r.operation==='performanceDiscover')return d;if(r.operation==='load')return {snapshot:d.snapshot};signal=o.signal;return new Promise(resolve=>{finish=resolve;});});
 const c=createPerformanceController({api,getSnapshot:()=>d.snapshot});const running=c.run();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
 c.stop();expect(signal.aborted).toBe(true);finish(result());await running;expect(c.state.current.checks).toHaveLength(0);expect(c.state.current.complete).toBe(false);
});
it('marks measurements invalid if configuration changes during the run, or refuses another environment',async()=>{
 const d=fixture(),changed=structuredClone(d.snapshot);changed.model.policies[0].enabled=false;
 const api=vi.fn(async r=>r.operation==='performanceDiscover'?d:r.operation==='load'?{snapshot:changed}:result());
 const c=createPerformanceController({api,getSnapshot:()=>d.snapshot});await c.run();expect(c.state.current.stale).toBe(true);
 const wrong=createPerformanceController({api,getSnapshot:()=>({...d.snapshot,environment:'other'})});await wrong.run();expect(wrong.state.error).toContain('different environment');expect(wrong.state.current).toBeNull();
});
it.each(['performanceDiscover','performanceMeasure','load'])('aborts a pending %s at the run deadline and releases the controller',async pending=>{
 vi.useFakeTimers();
 try {
  const d=fixture();let signal;
  const api=vi.fn(async(r,o)=>{if(r.operation===pending){signal=o.signal;return new Promise(()=>{});}return r.operation==='performanceDiscover'?d:r.operation==='load'?{snapshot:d.snapshot}:result();});
  const c=createPerformanceController({api,getSnapshot:()=>d.snapshot});const running=c.run();
  await vi.advanceTimersByTimeAsync(PERFORMANCE_BUDGET_MS);await running;
  expect(signal.aborted).toBe(true);expect(c.state.running).toBe(false);expect(c.state.error).toContain('eight-minute');
  if(pending==='load')expect(c.state.current.checks.length).toBeGreaterThan(0);
  expect(vi.getTimerCount()).toBe(0);
 } finally {vi.useRealTimers();}
});
it('keeps a completed baseline and every planned context across a stopped rerun and a failed retry',async()=>{
 const d=fixture();d.objects.push({...d.objects[0],rid:'123',id:'second'});
 let mode='ok',measure=0;
 const api=vi.fn(async r=>{if(r.operation==='performanceDiscover')return structuredClone(d);if(r.operation==='load')return {snapshot:d.snapshot};measure++;if(mode==='stop')return new Promise(()=>{});if(mode==='fail'&&measure===2)throw Error('Object unavailable');return result();});
 const c=createPerformanceController({api,getSnapshot:()=>d.snapshot});await c.run();const baseline=c.state.current;
 mode='stop';const stopped=c.run(true);await vi.waitFor(()=>expect(c.state.current).not.toBe(baseline));c.stop();await stopped;
 mode='fail';measure=0;await c.run(true);
 expect(c.state.previous).toBe(baseline);expect(measure).toBe(baseline.plan.checks.length);expect(c.state.current.failures).toHaveLength(1);
 mode='ok';measure=0;await c.run(true);
 expect(c.state.previous).toBe(baseline);expect(measure).toBe(baseline.plan.checks.length);expect(c.state.current.checks).toHaveLength(measure);
});
