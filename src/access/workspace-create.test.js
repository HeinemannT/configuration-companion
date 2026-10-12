// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('authors and tests a Create request with typed pickers, negative cases and remembered context', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const { snapshot, classes, object } = clarityFixture(), policy = snapshot.model.policies[0];
  const destination = {rid:'8000000000000000010',id:'comments',name:'Comments',type:'Category'},
    selected = '9000000000000000904';
  classes.CeComment = [
    {accessor:'commentOn',label:'Comment on',reference:true,configClass:'ReferenceMethodConfig',targets:'[CeRiskAssessment]'},
    {...classes.CeRiskAssessment[1],multiselect:true},
    {accessor:'name',label:'Name',configClass:'TextMethodConfig'},
    {accessor:'active',label:'Active',configClass:'BooleanMethodConfig'},
    {accessor:'count',label:'Count',configClass:'NumberMethodConfig'},
    {accessor:'owners',label:'Owners',configClass:'ReferenceMethodConfig',reference:true,multiselect:true,targets:'[User, Group]'},
  ];
  snapshot.classes.CeComment = [];
  policy.content.Statement = [{Effect:'Allow',Subject:['role:risk_review'],Action:['Create'],Resource:{All:[
    {Condition:{Left:'new.type',Comparison:'=',Right:'CeComment'}},
    {HasAccessTo:{Reference:'new.commentOn',Action:'Update'}},
    {Condition:{Left:'new.scope',Comparison:'NotEmpty'}},
    {Condition:{Left:'new.name',Comparison:'NotEmpty'}},
    {Condition:{Left:'new.active',Comparison:'=',Right:true}}
  ]}}];
  const trace = {element:'TraceRequest',result:true,timedOut:false,details:{},children:[{element:'Statement',result:false,timedOut:false,details:{policyRid:policy.rid,statementIndex:'0',effect:'ALLOW'},children:[{element:'NotEmpty',result:false,timedOut:false,details:{left:'new.name',leftResolved:''},children:[]}]}]};
  let deferTrace = false, resolveTrace;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type] || [];
    if (request.operation === 'search') return request.containers ? [destination] : [object];
    if (request.operation === 'trace') return deferTrace ? new Promise(resolve => {resolveTrace=resolve;}) : trace;
    if (request.operation === 'principals') return { choices:[{rid:request.kind === 'User' ? '7000000000000000001' : '7000000000000000002',id:request.kind.toLowerCase() + '_review',name:'Review ' + request.kind.toLowerCase(),type:request.kind}],hasMore:false };
    throw Error('Unexpected operation: ' + request.operation);
  });
  let saved;
  const notice = vi.fn(), workspace = mountWorkspace({snapshot,api,persist:async factory => {saved=factory();},busy:()=>{},notice});
  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const tick = async (delay=0) => {await new Promise(resolve=>setTimeout(resolve,delay)); await workspace.flush();};
  const click = async selector => {expect($(selector),selector).not.toBeNull();$(selector).click();await tick();};
  const choose = async label => {await tick(260); const option = $$('#picker-results [role="option"]').find(el => el.textContent.includes(label));expect(option,label).toBeTruthy();option.click();await tick();};
  const check = () => saved.state.tests.$map.find(([key])=>key === 'policy:'+policy.rid+':0')[1];
  const input = async (selector,value) => {const el=$(selector);el.focus();el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));await tick();};
  await workspace.enter({kind:'policy',rid:policy.rid});await tick();

  // Source-only edits retain comparisons and values, including a false boolean.
  await click('[data-command="schema-source"][data-path=\'["All",4]\']');await choose('Current saved object');
  expect(saved.model.policies[0].content.Statement[0].Resource.All[4].Condition).toEqual({Left:'resource.active',Comparison:'=',Right:true});
  await click('[data-command="undo"]');
  await click('[data-command="check"]');await tick();
  expect($('#dock').textContent).not.toContain('Prototype');
  expect(JSON.parse(check().proposed)).toEqual({type:'CeComment'});
  expect($('[data-command="prepare-check"]').disabled).toBe(true);
  expect($('[data-create-row="commentOn"]').textContent).toContain('Not supplied');
  await click('[data-command="create-destination"]');await choose('Comments');
  expect(api.mock.calls.find(([r])=>r.containers)?.[0]).toMatchObject({operation:'search',prototypes:false,containers:true});
  expect(JSON.parse(check().proposed).parent_rid).toBe(destination.rid);
  await click('[data-command="create-reference"][data-field="commentOn"]');await choose('Quarterly risk');
  expect(JSON.parse(check().proposed).references.commentOn).toBe(object.rid);
  await click('[data-command="create-reference"][data-field="scope"]');await choose('Central');
  await click('[data-command="schema-apply"]');
  expect(JSON.parse(check().proposed).references.scope).toEqual([selected]);
  await click('[data-command="create-boolean"][data-field="active"]');await choose('false');
  expect(JSON.parse(check().proposed).properties.active).toBe(false);
  await input('[data-create-value="name"]','Example');
  expect(document.activeElement).toBe($('[data-create-value="name"]'));
  await click('[data-command="create-omit"][data-field="name"]');
  expect(JSON.parse(check().proposed).properties).not.toHaveProperty('name');
  expect($('[data-command="prepare-check"]').disabled).toBe(false); // missing policy inputs are testable
  await click('[data-command="prepare-check"]');
  expect(api.mock.calls.find(([r])=>r.operation==='trace')[0].request).toMatchObject({action:'CREATE',resource_rid:destination.rid,proposed:{type:'CeComment',parent_rid:destination.rid,references:{commentOn:object.rid,scope:[selected]},properties:{active:false}}});
  expect($('#check-result').textContent).toContain('Allowed');
  expect($('#check-result').textContent).toContain('Did not match');
  await click('[data-command="focus-test-failure"]');
  expect(document.activeElement).toBe($('[data-create-value="name"]'));
  await input('[data-create-value="name"]','Revised');
  expect($('#check-result').textContent).toContain('changed');
  $('[data-create-value="name"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));await tick();
  expect(api.mock.calls.filter(([r])=>r.operation==='trace')).toHaveLength(2);

  await click('[data-command="create-view"][data-create-view="json"]');
  const before = JSON.parse(check().proposed);
  await input('[data-check="proposed"]',JSON.stringify({...before,properties:{...before.properties,count:0,empty:'',nullable:null}}));
  await click('[data-command="create-view"][data-create-view="fields"]');
  expect(JSON.parse(check().proposed).properties).toMatchObject({count:0,empty:'',nullable:null,active:false});
  await input('[data-create-value="count"]','1e');
  expect(check().createNumberDrafts.count).toBe('1e');
  expect(JSON.parse(check().proposed).properties.count).toBe(0);
  expect($('[data-create-value="count"]').getAttribute('aria-invalid')).toBe('true');
  expect($('[data-command="prepare-check"]').disabled).toBe(true);
  await click('[data-command="create-view"][data-create-view="json"]');
  expect(document.activeElement).toBe($('[data-create-value="count"]'));
  expect($('#dock [data-check="proposed"]')).toBeNull();
  await click('[data-command="test-action"][data-action-value="Read"]');
  await click('[data-command="test-action"][data-action-value="Create"]');
  expect($('[data-create-value="count"]').value).toBe('1e');
  $('[data-create-value="count"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));await tick();
  expect(api.mock.calls.filter(([r])=>r.operation==='trace')).toHaveLength(2);
  await input('[data-create-value="count"]','1e2');
  expect(JSON.parse(check().proposed).properties.count).toBe(100);
  expect($('[data-command="prepare-check"]').disabled).toBe(false);
  deferTrace=true; await click('[data-command="prepare-check"]');
  await input('[data-create-value="count"]','-');
  resolveTrace(trace); await tick(); deferTrace=false;
  expect(check().result.stale).toBe(true); // pending text also invalidates an in-flight result
  expect($('[data-create-value="count"]').value).toBe('-');
  await click('[data-command="create-field-menu"][data-field="count"]');
  await click('[data-command="create-remove-field"]');
  expect($('[data-create-row="count"]')).toBeNull();
  expect(JSON.parse(check().proposed).properties).not.toHaveProperty('count');
  expect(document.activeElement).toBe($('[data-command="create-add-field"]'));
  expect(JSON.parse(check().proposed).properties.name).toBe('Revised');
  await click('[data-command="create-add-field"]');await choose('Owners');
  await click('[data-command="create-reference"][data-field="owners"]');await choose('Review user');
  await click('[data-command="create-principal-kind"][data-kind="Group"]');await choose('Review group');
  await click('[data-command="schema-apply"]');
  expect(JSON.parse(check().proposed).references.owners).toEqual(['7000000000000000001','7000000000000000002']);
  await click('[data-command="test-action"][data-action-value="Read"]');
  await click('[data-command="test-action"][data-action-value="Create"]');
  expect(check().resource).toBe(destination.rid);
  expect($('#dock').textContent).toContain('Quarterly risk assessment');
  expect(JSON.parse(check().proposed).properties.name).toBe('Revised');
  expect(check().createLabels[selected]).toContain('scope_global');
  expect($('#dock').textContent).toContain('Review group');
  expect(check().result.stale).toBe(true);
  await click('[data-command="create-view"][data-create-view="json"]');
  await input('[data-check="proposed"]','{invalid');
  await click('[data-command="create-view"][data-create-view="fields"]');
  expect(check().proposed).toBe('{invalid');
  expect($('#dock textarea').value).toBe('{invalid');
  expect($('[data-command="prepare-check"]').disabled).toBe(true);
  expect($('#dock .field-error').textContent).toContain('Fix the request JSON');
});
