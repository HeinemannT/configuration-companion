// @vitest-environment happy-dom
import { expect,it,vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('ignores an old destination failure and resumes a pending lookup when returning to its type',async()=>{
  document.body.innerHTML=html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  localStorage.clear();window.history.replaceState(null,'');
  window.HTMLElement.prototype.scrollIntoView=vi.fn();
  const {snapshot}=clarityFixture(),policy=snapshot.model.policies[0];
  snapshot.classes.CeComment=[];
  policy.content.Statement=[{Effect:'Allow',Subject:'*',Action:['Create'],Resource:{Condition:{Left:'new.type',Comparison:'=',Right:'CeComment'}}}];
  const requests=[];
  const api=vi.fn(request=>{
    if(request.operation==='schema')return Promise.resolve([]);
    if(request.operation==='creation')return new Promise((resolve,reject)=>requests.push({type:request.type,resolve,reject}));
    throw Error('Unexpected request: '+request.operation);
  });
  let saved;
  const workspace=mountWorkspace({snapshot,api,notice:vi.fn(),busy:vi.fn(),persist:async read=>{saved=read();}});
  const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await workspace.flush();};
  const click=async selector=>{const el=document.querySelector(selector);expect(el,selector).not.toBeNull();el.click();await tick();};
  const type=async value=>{
    await click('[data-command="create-type"]');
    const choice=[...document.querySelectorAll('#picker-results [role="option"]')].find(el=>el.textContent.includes(value));
    expect(choice,value).toBeTruthy();choice.click();await tick();
  };
  await workspace.enter({kind:'policy',rid:policy.rid});await tick();await click('[data-command="check"]');
  expect(requests.map(r=>r.type)).toEqual(['CeComment']);
  await type('CeRiskAssessment');
  requests[0].reject(Error('Old comment lookup failed'));await tick();
  expect(document.querySelector('#dock').textContent).not.toContain('Old comment lookup failed');
  await type('CeComment');
  await type('CeRiskAssessment'); // Reattach to the same pending request.
  expect(requests.map(r=>r.type)).toEqual(['CeComment','CeRiskAssessment','CeComment']);
  requests[1].resolve({root:{rid:'9000000000000000001',id:'RISKROOT',name:'Risk root',type:'Category'}});await tick();
  expect(document.querySelector('#create-parent-picker').textContent).toContain('Risk root');
  requests[2].resolve({root:{rid:'9000000000000000002',id:'COMMENTROOT',name:'Comment root',type:'Category'}});await tick();
  expect(document.querySelector('#create-parent-picker').textContent).toContain('Risk root');
  const check=saved.state.tests.$map.find(([key])=>key==='policy:'+policy.rid+':0')[1];
  expect(JSON.parse(check.proposed).parent_rid).toBe('9000000000000000001');
  await type('CeComment');
  expect(document.querySelector('#create-parent-picker').textContent).toContain('Comment root');
});
