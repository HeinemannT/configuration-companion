// @vitest-environment happy-dom
import {expect,it,vi} from 'vitest';
import html from './access.html?raw';
import {mountWorkspace} from './workspace.js';
import {clarityFixture} from './__fixtures__/clarity.js';
it('profiles and reopens a prepared Create without relabeling its parent as the proposed type',async()=>{
 document.body.innerHTML=html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
 window.history.replaceState(null,'');window.sessionStorage.clear();localStorage.clear();window.HTMLElement.prototype.scrollIntoView=vi.fn();
 const {snapshot}=clarityFixture(),role=snapshot.model.roles[0],parent={rid:'8000000000000000050',id:'tasks',name:'Tasks folder',type:'Category'},key=`role:${role.rid}:0`;
 const proposed={type:'CeTask',parent_rid:parent.rid,properties:{name:'Prepared task'},references:{owner:['8000000000000000001']}};
 const root={element:'TraceRequest',durationMs:1,result:false,timedOut:false,details:{},children:[]};
 const api=vi.fn(async r=>r.operation==='load'?{snapshot:structuredClone(snapshot)}:r.operation==='performanceMeasure'?{runs:Array(5).fill(root),indexedRuns:Array(5).fill(root)}:[]);
 let stored;const workspace=mountWorkspace({snapshot,api,notice:vi.fn(),busy:vi.fn(),persist:async read=>{stored=read();},saved:{model:structuredClone(snapshot.model),baseline:snapshot.model,context:{objects:[parent],prototypes:[],users:[],groups:[]},state:{kind:'role',rid:role.rid,empty:false,tabs:[{kind:'role',rid:role.rid}],testOpen:{$set:[key]},tests:{$map:[[key,{mode:'role',subject:role.rid,resource:parent.rid,action:'Create',proposed:JSON.stringify(proposed),createInitialized:true}]]}}}});
 document.querySelector('[data-command="profile-check"]').click();
 await vi.waitFor(()=>expect(document.querySelector('.pr-status').textContent).toContain('1 checks measured'));
 expect(api.mock.calls.find(([r])=>r.operation==='performanceMeasure')[0].request).toEqual({resource_rid:parent.rid,subject_rid:role.rid,action:'CREATE',proposed});
 document.querySelector('[data-pr="test"]').click();await workspace.flush();
 expect(stored.context.objects.find(o=>o.rid===parent.rid)).toEqual(parent);
 const check=stored.state.tests.$map.at(-1)[1];expect(check.action).toBe('Create');expect(JSON.parse(check.proposed)).toEqual(proposed);
 expect(document.querySelector('#create-parent-picker').textContent).toContain('Tasks folder');
});
