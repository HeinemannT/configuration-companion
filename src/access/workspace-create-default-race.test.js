// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('keeps the latest default read when initial fields are added rapidly', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  localStorage.clear(); window.history.replaceState(null, '');
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot } = clarityFixture(), policy = snapshot.model.policies[0];
  const source = {rid:'8000000000000000001',id:'default_risk',name:'Default risk',type:'CeRiskAssessment'};
  const fields = ['name','first','second','third','fourth'].map(accessor => ({accessor,label:accessor,configClass:'TextMethodConfig'}));
  policy.content.Statement = [{Effect:'Allow',Subject:'*',Action:['Create'],Resource:{Condition:{Left:'new.type',Comparison:'=',Right:source.type}}}];
  const requests = [];
  const api = vi.fn(request => {
    if (request.operation === 'schema') return Promise.resolve(fields);
    if (request.operation === 'search') return Promise.resolve([source]);
    if (request.operation === 'creation') return request.source
      ? new Promise((resolve,reject) => requests.push({fields:request.fields,resolve,reject}))
      : Promise.resolve({root:{rid:'8000000000000000002',id:'root',name:'Risk root',type:'Category'}});
    throw Error('Unexpected request: '+request.operation);
  });
  let saved;
  const workspace = mountWorkspace({snapshot,api,notice:vi.fn(),busy:vi.fn(),persist:async read => {saved=read();}});
  const tick = async (delay=0) => {await new Promise(resolve => setTimeout(resolve,delay));await workspace.flush();};
  const click = async selector => {const el=document.querySelector(selector);expect(el,selector).not.toBeNull();el.click();await tick();};
  const choose = async label => {
    await tick(260);
    const el=[...document.querySelectorAll('#picker-results [role="option"]')].find(row=>row.querySelector('strong')?.textContent===label);
    expect(el,label).toBeTruthy();el.click();await tick();
  };
  const check = () => saved.state.tests.$map.find(([key])=>key==='policy:'+policy.rid+':0')[1];
  const resolve = async (index) => {
    requests[index].resolve({source,values:{type:source.type,properties:Object.fromEntries(requests[index].fields.map(f=>[f,'Default '+f]))}});
    await tick();
  };
  const add = async name => {await click('[data-command="create-add-field"]');await choose(name);};
  await workspace.enter({kind:'policy',rid:policy.rid});await tick();await click('[data-command="check"]');
  await click('[data-command="create-default"]');await choose(source.name);await resolve(0);
  await add('first');await add('second');
  expect(requests).toHaveLength(3);
  await resolve(2);await resolve(1);
  expect(JSON.parse(check().proposed).properties).toMatchObject({first:'Default first',second:'Default second'});
  expect(check().defaultReadFields).toContain('second');
  // An obsolete failure must not clear the newer request's busy state or show an error.
  await add('third');await add('fourth');
  requests[3].reject(Error('Old read failed'));await tick();
  expect(document.querySelector('#create-default-picker').disabled).toBe(true);
  expect(document.querySelector('#dock').textContent).not.toContain('Old read failed');
  await resolve(4);
  expect(document.querySelector('#create-default-picker').disabled).toBe(false);
  expect(JSON.parse(check().proposed).properties).toHaveProperty('fourth','Default fourth');
});
