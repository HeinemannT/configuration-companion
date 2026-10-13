// @vitest-environment happy-dom
import { expect,it,vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('recovers matrix evidence in place without reloading the workspace or losing selection',async()=>{
  document.body.innerHTML=html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
  window.history.replaceState(null,'');localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView=vi.fn();
  const {snapshot,classes}=clarityFixture();
  const metadata={types:{Identifiable:{parents:[],concrete:false},...Object.fromEntries(Object.keys(classes).map(type=>[type,{parents:['Identifiable'],concrete:true}]))},models:{},references:{},unsupported:[],unavailable:[]};
  let attempts=0;
  const api=vi.fn(async req=>{if(req.operation==='matrixMetadata'){if(++attempts===1)throw new Error('offline');return {...metadata,unsupported:req.references};}return [];});
  const workspace=mountWorkspace({snapshot,api,notice:vi.fn(),busy:vi.fn(),persist:async()=>{}});
  const click=async selector=>{document.querySelector(selector).click();await new Promise(r=>setTimeout(r,0));await workspace.flush();};
  await click('[data-command="matrix"]');
  expect(document.querySelector('[data-matrix-retry]')).not.toBeNull();
  const filter=document.querySelector('[data-matrix-input="typeQ"]');filter.value='CeRiskAssessment';filter.dispatchEvent(new Event('input',{bubbles:true}));
  await click('.am-cell');const selected=document.querySelector('.am-cell[aria-pressed="true"]').dataset.gridKey;
  await click('[data-matrix-retry]');
  expect(document.querySelector('[data-matrix-retry]')).toBeNull();
  expect(document.querySelector('[data-matrix-input="typeQ"]').value).toBe('CeRiskAssessment');
  expect(document.querySelector('.am-cell[aria-pressed="true"]').dataset.gridKey).toBe(selected);
  expect(api.mock.calls.every(([req])=>req.operation==='matrixMetadata')).toBe(true);
  expect(attempts).toBe(2);
});
