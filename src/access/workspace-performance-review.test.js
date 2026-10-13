// @vitest-environment happy-dom
import { expect,it,vi } from 'vitest';
import html from './access.html?raw';
import {mountWorkspace} from './workspace.js';
import {clarityFixture} from './__fixtures__/clarity.js';
const settle=()=>new Promise(r=>setTimeout(r,0));
it('keeps measurements and selection across policy navigation, opens exact test inputs, and profiles only that check',async()=>{
 document.body.innerHTML=html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 window.history.replaceState(null,'');localStorage.clear();window.sessionStorage.clear();window.HTMLElement.prototype.scrollIntoView=vi.fn();
 const {snapshot,classes,object}=clarityFixture(),policy=snapshot.model.policies[0];
 const trace={element:'TraceRequest',durationMs:2,result:true,timedOut:false,details:{},children:[{element:'Statement',durationMs:1.5,result:true,details:{policyRid:policy.rid,statementIndex:'0',effect:'ALLOW'},children:[{element:'Subject',result:true,durationMs:1,details:{},children:[]}]}]};
 const result={runs:Array.from({length:5},()=>structuredClone(trace)),indexedRuns:Array.from({length:5},()=>({...trace,children:[]}))};
 const api=vi.fn(async r=>r.operation==='performanceDiscover'?{snapshot:structuredClone(snapshot),objects:[object],assignedUsers:[],scope:{unsampledTypes:[]},problems:[]}:r.operation==='load'?{snapshot:structuredClone(snapshot)}:r.operation==='schema'?classes[r.type]??[]:structuredClone(result));
 let stored;const workspace=mountWorkspace({snapshot,api,busy:vi.fn(),notice:vi.fn(),persist:async read=>{stored=read();}});
 const click=async selector=>{expect(document.querySelector(selector),selector).not.toBeNull();document.querySelector(selector).click();await settle();await workspace.flush();};
 await click('[data-command="performance"]');await click('[data-pr="analyze"]');
 await vi.waitFor(()=>expect(document.querySelector('.pr-status').textContent).toContain('checks measured'));
 expect(document.querySelector('.pr-context').textContent).toContain(object.id);
 const context=document.querySelector('.pr-context').textContent;
 await click('[data-pr-policy]:not(:disabled)');expect(stored.state.rid).toBe(policy.rid);
 await click('.doc-tab [data-command="performance"]');expect(document.querySelector('.pr-context').textContent).toBe(context);
 await click('[data-pr="test"]');expect(stored.state.check).toBeUndefined(); // Check state is kept in the keyed test map.
 const check=stored.state.tests.$map.at(-1)[1];expect(check.resource).toBe(object.rid);expect(check.subject).toBe(snapshot.model.roles[0].rid);
 await click('[data-command="profile-check"]');await vi.waitFor(()=>expect(document.querySelector('.pr-status').textContent).toContain('1 of 1 checks measured'));
 expect(api.mock.calls.filter(([r])=>r.operation==='performanceDiscover')).toHaveLength(1);
 expect(api.mock.calls.filter(([r])=>r.operation==='performanceMeasure')).toHaveLength(2);
 expect(JSON.stringify(stored.state.performance)).not.toContain('TraceRequest');
});
