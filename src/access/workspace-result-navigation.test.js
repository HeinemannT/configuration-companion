// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it.each([false,true])('returns from a contributing policy to the same test, prepared values and result (allowed: %s)', async allowed => {
  document.body.innerHTML=html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  window.history.replaceState(null,''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView=vi.fn();
  const {snapshot,classes,object}=clarityFixture(), role=snapshot.model.roles[0], policy=snapshot.model.policies[0];
  const key=`role:${role.rid}:0`, node=(element,result,children=[],details={})=>({element,result,children,details,timedOut:false});
  const trace=node('TraceRequest',allowed,[node('Statement',allowed,[node('Subject',true),node('Action',allowed),...(allowed?[node('Equal',true,[],{left:'resource.type',right:'CeTask'})]:[])],{policyRid:policy.rid,policyRid_name:policy.name,statementIndex:'0',effect:'ALLOW'})]);
  trace.durationMs=7.5;
  let stored;
  const api=vi.fn(async request=>request.operation==='schema'?classes[request.type]??[]:structuredClone(trace));
  const workspace=mountWorkspace({snapshot,api,notice:vi.fn(),busy:vi.fn(),persist:async read=>{stored=read();},
    saved:{model:structuredClone(snapshot.model),baseline:snapshot.model,context:{objects:[object],prototypes:[],users:[],groups:[]},
      state:{kind:'role',rid:role.rid,empty:false,tabs:[{kind:'role',rid:role.rid}],testOpen:{$set:[key]},tests:{$map:[[key,{mode:'role',subject:role.rid,resource:object.rid,action:'Update',rename:'Prepared name',proposed:'{}',result:null}]]}}}});
  const click=async selector=>{document.querySelector(selector).click();await new Promise(r=>setTimeout(r,0));await workspace.flush();};
  await click('[data-command="prepare-check"]');
  await click('[data-engine-toggle="0"]');
  expect(document.querySelector('.engine-review').textContent).toContain(allowed?'resource.type':'conditions not evaluated');
  expect(document.querySelector('.result-line strong').textContent).toBe(allowed?'Granted':'Denied');
  expect(document.querySelector('.test-timing').textContent).toContain('7.5 ms');
  const measured=stored.state.tests.$map.find(([k])=>k===key)[1].result.requestMs;
  expect(measured).toBeGreaterThanOrEqual(0);
  document.querySelector('.test-body').scrollTop = 420;
  await click('.engine-review [data-command="open-trace-policy"]');
  expect(stored.state.rid).toBe(policy.rid);
  expect(document.querySelector('#test-return')).not.toBeNull();
  await click('#test-return');
  expect(stored.state.rid).toBe(role.rid);
  expect(document.querySelector('[data-check="rename"]').value).toBe('Prepared name');
  expect(document.querySelector('.result-line').textContent).toContain(allowed?'Granted':'Denied');
  expect(document.querySelector('[data-engine-toggle="0"]').getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('.test-body').scrollTop).toBe(420);
  expect(stored.state.tests.$map.find(([k])=>k===key)[1].resource).toBe(object.rid);
  expect(stored.state.tests.$map.find(([k])=>k===key)[1].result.requestMs).toBe(measured);
  expect(api.mock.calls.filter(([r])=>r.operation==='trace')).toHaveLength(1);
});
