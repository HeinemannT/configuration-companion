// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import {mountPerformance,performanceViewState} from './performance-view.js';
import {createPerformanceProjection} from './performance-projection.js';
import * as findingsModule from './performance-findings.js';
import {clarityFixture} from './__fixtures__/clarity.js';

function recording() {
 const {snapshot,object}=clarityFixture(),policy=snapshot.model.policies[0];
 const trace={element:'TraceRequest',durationMs:2,result:true,children:[{element:'Statement',durationMs:1,result:true,details:{policyRid:policy.rid,statementIndex:'0',effect:'ALLOW'},children:[{element:'Subject',durationMs:.8,result:true,details:{},children:[]}]}]};
 const check={id:'check',request:{resource_rid:object.rid,subject_rid:'1',action:'READ'},actor:{id:'role',name:'Role',kind:'role'},object,action:'READ',runs:Array(5).fill(trace),indexedRuns:Array(5).fill({...trace,children:[]})};
 return {snapshot,checks:[check],complete:true,plan:{needsCreate:0},scope:{unsampledTypes:[]},problems:[],failures:[]};
}
function mount(current=recording()) {
 document.body.innerHTML='<main></main>';let notify;
 const controller={state:{current,running:true,total:2,completed:1,progress:'Measuring'},subscribe(fn){notify=fn;return()=>{};}};
 const view=mountPerformance(document.querySelector('main'),{controller,state:performanceViewState(),getSnapshot:()=>current.snapshot,hasDraftChanges:()=>false,canOpen:()=>true,openRule:vi.fn(),openRole:vi.fn(),test:vi.fn()});
 return {controller,notify:()=>notify(),view};
}
it('does not rebuild unchanged analysis on UI/progress updates or revisit old trace trees',()=>{
 const spy=vi.spyOn(findingsModule,'performanceFindings'),r=recording(),project=createPerformanceProjection();
 try {
  const first=project(r,r.snapshot);expect(spy).toHaveBeenCalledTimes(1);
  expect(project(r,r.snapshot)).toMatchObject(first);expect(project(r,r.snapshot).checks).toBe(first.checks);
  r.checks.push({...r.checks[0],id:'second'});
  const next=project(r,r.snapshot);expect(next.checks).toHaveLength(2);expect(next.checks[0]).toBe(first.checks[0]);expect(spy).toHaveBeenCalledTimes(1);
  const changed=structuredClone(r.snapshot);changed.model.policies[0].enabled=false;
  project(r,changed);expect(spy).toHaveBeenCalledTimes(2);
 } finally {spy.mockRestore();}
});
it('keeps controls mounted for progress and retains focus/disclosures when a measurement arrives',()=>{
 const {controller,notify,view}=mount();
 try {
  const stop=document.querySelector('[data-pr="stop"]');stop.focus();controller.state.progress='Next check';notify();
  expect(document.activeElement).toBe(stop);expect(document.querySelector('.pr-status').textContent).toContain('Next check');
  const details=document.querySelector('details'),key=details.dataset.disclosure;details.open=true;details.querySelector('summary').focus();
  controller.state.current.checks.push({...controller.state.current.checks[0],id:'second'});notify();
  expect(document.activeElement.tagName).toBe('SUMMARY');expect(document.activeElement.parentElement.dataset.disclosure).toBe(key);expect(document.activeElement.parentElement.open).toBe(true);
  const select=document.querySelector('[data-pr-result]');select.focus();controller.state.current.failures.push({error:'failed'});notify();expect(document.activeElement).toBe(document.querySelector('[data-pr-result]'));
 } finally {view.destroy();}
});
it('never presents an inconsistent server decision as a clean grant',()=>{
 const r=recording();r.checks[0].indexedRuns=[...r.checks[0].indexedRuns];r.checks[0].indexedRuns[0]={...r.checks[0].indexedRuns[0],result:false};
 const {view}=mount(r);
 try {
  expect(document.querySelector('.pr-context .pr-decision').textContent).toBe('Inconsistent');
  expect(document.querySelector('.pr-metrics').textContent).toContain('0 granted · 0 denied · 1 inconsistent');
  expect(document.querySelector('.pr-check-footer').textContent).not.toContain('Granted by');
 } finally {view.destroy();}
});
it('shows missing comparison contexts without claiming unchanged access',()=>{
 const r=recording(),before=structuredClone(r);r.checks=[];r.failures=[{...before.checks[0],error:'Object missing'}];
 const {controller,notify,view}=mount(r);
 try {
  controller.state.running=false;controller.state.previous=before;notify();document.querySelector('[data-pr-view="comparison"]').click();
  expect(document.querySelector('.pr-main').textContent).toContain('0 of 1 contexts compared');
  expect(document.querySelector('.pr-main').textContent).toContain('Measurement failed');
  expect(document.querySelector('.pr-main').textContent).not.toContain('Unchanged');
 } finally {view.destroy();}
});
