// @vitest-environment happy-dom
import { expect,it,vi } from 'vitest';
import { renderEngineTrace,mountEngineTrace,type TraceReviewState } from './trace-review';
import type { AccessTraceNode } from '../lib/types';
const node=(element:string,result:boolean|null,children:AccessTraceNode[]=[],details:Record<string,string>={}):AccessTraceNode=>({element,result,children,details,timedOut:false});
const rule=(id:string,subject:boolean,action?:boolean)=>node('Statement',action===true,[node('Subject',subject),...(action===undefined?[]:[node('Action',action),...(action?[node('All',true,[node('Equal',true,[],{left:'resource.type',leftResolved:'CeTask',right:'CeTask'})])]:[])])],{policyRid:id,policyRid_name:'Policy '+id,statementIndex:'2',effect:'ALLOW'});
it('keeps engine order, groups unmatched subjects and expands all predicate detail',()=>{
  const trace=node('TraceRequest',true,[rule('1',false),rule('2',false),rule('3',true,false),rule('4',true,true)]),state:TraceReviewState={};
  document.body.innerHTML=renderEngineTrace(trace,()=>true,state);
  mountEngineTrace(document.body,trace,()=>true,state,()=>{});
  expect(document.querySelector('.er-grants .er-rule')?.textContent).toContain('Policy 4');
  expect(document.querySelectorAll('[data-engine-section="all"] .er-rule')).toHaveLength(2);
  document.querySelector<HTMLButtonElement>('[data-engine-group="0"]')!.click();
  expect([...document.querySelectorAll('[data-engine-section="all"] .er-rule')].map(el=>el.getAttribute('data-engine-row'))).toEqual(['0','1','2','3']);
  expect(document.querySelector('[data-engine-row="0"] td:nth-child(4)')?.textContent).toContain('Not evaluated');
  document.querySelector<HTMLButtonElement>('[data-engine-toggle="3"]')!.click();
  expect(document.querySelector('.er-detail')?.textContent).toContain('resource.type');
  expect(document.querySelectorAll('.er-detail details')).toHaveLength(0);
  expect(document.querySelectorAll('[data-engine-toggle="3"][aria-expanded="true"]')).toHaveLength(2);
  expect(document.activeElement?.closest('[data-engine-section]')?.getAttribute('data-engine-section')).toBe('grants');
  document.querySelector<HTMLButtonElement>('[data-engine-section="all"] [data-engine-toggle="3"]')!.click();
  expect(document.querySelectorAll('.er-detail')).toHaveLength(0);
  expect(document.activeElement?.closest('[data-engine-section]')?.getAttribute('data-engine-section')).toBe('all');
  const search=document.querySelector<HTMLInputElement>('[data-engine-search]')!;
  search.value='Policy 3';search.dispatchEvent(new Event('input'));
  expect(document.querySelectorAll('[data-engine-section="all"] .er-rule')).toHaveLength(1);
  document.querySelector<HTMLButtonElement>('.er-grants [data-engine-toggle="3"]')!.click();
  expect(document.querySelector('.er-grants .er-detail')?.textContent).toContain('resource.type');
  expect(state.query).toBe('Policy 3');
});
it('never identifies a nested permission grant as the request grant and disables changed statement links',()=>{
  const nested=node('Access request',true,[rule('9',true,true)]);
  const outer=rule('3',true,false);outer.children.push(node('HasAccessTo',false,[nested]));
  document.body.innerHTML=renderEngineTrace(node('TraceRequest',false,[outer]),()=>false);
  expect(document.querySelector('.er-grants')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('.er-open')?.disabled).toBe(true);
  expect(document.querySelectorAll('.er-rule')).toHaveLength(1);
});

it('collapses a group with open children and lets the user disable grouping without losing detail state',()=>{
  const trace=node('TraceRequest',false,[rule('1',false),rule('2',false)]),state:TraceReviewState={open:['0']};
  document.body.innerHTML=renderEngineTrace(trace,()=>true,state);
  mountEngineTrace(document.body,trace,()=>true,state,()=>{});
  expect(document.querySelectorAll('.er-rule.er-group-child')).toHaveLength(2);
  document.querySelector<HTMLButtonElement>('[data-engine-group="0"]')!.click();
  expect(document.querySelectorAll('.er-rule')).toHaveLength(0);
  document.querySelector<HTMLButtonElement>('[data-engine-group="0"]')!.click();
  expect(document.querySelector('[data-engine-toggle="0"]')?.getAttribute('aria-expanded')).toBe('true');
  const grouping=document.querySelector<HTMLInputElement>('[data-engine-grouping]')!;
  grouping.checked=false;grouping.dispatchEvent(new Event('change'));
  expect(document.querySelector('.er-group')).toBeNull();
  expect(document.querySelectorAll('.er-rule')).toHaveLength(2);
  expect(document.querySelectorAll('.er-rule.er-group-child')).toHaveLength(0);
  expect(state.groupUnmatched).toBe(false);
  expect(state.open).toEqual(['0']);
});

it('keeps the clicked rule at the same scroll position when its granting copy also expands',()=>{
  const trace=node('TraceRequest',true,[rule('1',true,true)]),state:TraceReviewState={};
  document.body.innerHTML='<div class="test-body">'+renderEngineTrace(trace,()=>true,state)+'</div>';
  const host=document.querySelector<HTMLElement>('.test-body')!;host.scrollTop=100;
  mountEngineTrace(host,trace,()=>true,state,()=>{});
  const rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    return {top:state.open?.length?220:100} as DOMRect;
  });
  document.querySelector<HTMLButtonElement>('[data-engine-section="all"] [data-engine-toggle]')!.click();
  expect(host.scrollTop).toBe(220);
  expect(document.activeElement?.closest('[data-engine-section]')?.getAttribute('data-engine-section')).toBe('all');
  document.querySelector<HTMLButtonElement>('[data-engine-section="all"] [data-engine-toggle]')!.click();
  expect(host.scrollTop).toBe(100);
  rect.mockRestore();
});

it('shows comparison evidence without calling a forbidden value expected and safely escapes policy text',()=>{
  const trace=node('TraceRequest',false,[node('Statement',false,[node('Subject',true),node('Action',true),node('NotEqual',false,[],{left:'resource.name',leftResolved:'<x>',right:'<x>'})],{policyRid:'9223372036854775800',policyRid_name:'<Read policy>',statementIndex:'0'})]);
  document.body.innerHTML=renderEngineTrace(trace,()=>false,{open:['0']});
  expect(document.querySelector('.er-detail')?.textContent).toContain('Actual<x>Compared with<x>');
  expect(document.querySelector('x,read')).toBeNull();
  expect(document.querySelector<HTMLButtonElement>('.er-open')!.disabled).toBe(true);
  expect(document.querySelector('[data-rid]')?.getAttribute('data-rid')).toBe('9223372036854775800');
});

it('does not describe a timed-out trace as having stopped at a final grant',()=>{
  document.body.innerHTML=renderEngineTrace({...node('TraceRequest',true,[rule('1',true,true)]),timedOut:true},()=>true);
  expect(document.querySelector('.er-note')?.textContent).toContain('incomplete');
  expect(document.querySelector('.er-note')?.textContent).not.toContain('first grant');
});
