// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import html from './access.html?raw';
import { mountWorkspace } from './workspace.js';
import { clarityFixture } from './__fixtures__/clarity.js';

it('filters types locally, retains object context, recovers search failures and rejects late responses', async () => {
  document.body.innerHTML = html.split('<body>')[1].split('</body>')[0].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  window.history.replaceState(null, ''); localStorage.clear();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  const {snapshot, classes, object} = clarityFixture();
  for (let i=0; i<40; i++) snapshot.classes['CeExample'+i] = [];
  let fail = false, hold = false, release;
  const api = vi.fn(async request => {
    if (request.operation === 'schema') return classes[request.type] ?? [];
    if (request.operation === 'search') {
      if (hold) { hold=false; return new Promise(resolve => {release=resolve;}); }
      if (fail) throw Error('Connection lost');
      return !request.type || request.type === object.type ? [object] : [];
    }
    throw Error('Unexpected operation: '+request.operation);
  });
  const workspace = mountWorkspace({snapshot,api,persist:async()=>{},busy:()=>{},notice:vi.fn()});
  const $ = selector => document.querySelector(selector);
  const tick = () => new Promise(resolve => setTimeout(resolve,0));
  const click = async selector => {expect($(selector),selector).not.toBeNull();$(selector).click();await tick();};
  const key = async (key,more={}) => {$('#picker-query').dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...more}));await tick();};
  const input = async value => {$('#picker-query').value=value;$('#picker-query').dispatchEvent(new Event('input',{bubbles:true}));await tick();};
  const searches = () => api.mock.calls.filter(([r])=>r.operation === 'search');
  const settle = () => vi.waitFor(() => expect($('#picker-footer').textContent).not.toContain('Searching…'));
  await workspace.enter({kind:'role',rid:snapshot.model.roles[0].rid});
  await click('[data-command="check"]'); await click('[data-command="choose-object"]'); await settle();
  expect($('#picker-types').querySelectorAll('button')).toHaveLength(1);
  await input('Quarterly');
  $('[data-command="picker-browse-types"]').focus(); await settle();
  expect(document.activeElement).toBe($('[data-command="picker-browse-types"]'));
  const count = searches().length;
  $('#picker-results').scrollTop = 28;
  await key('ArrowDown',{altKey:true});
  expect($('#picker-query').getAttribute('aria-label')).toBe('Search object types');
  expect($('#picker-results').querySelectorAll('[role="option"]').length).toBeGreaterThan(40);
  await input('risk'); await new Promise(resolve => setTimeout(resolve,260));
  expect(searches()).toHaveLength(count); // type lookup is entirely local
  expect($('#picker-results').textContent).toContain('Risk assessments');
  await key('Escape');
  expect($('#picker-query').value).toBe('Quarterly');
  expect($('#picker-results').scrollTop).toBe(28);
  expect($('#picker-types').textContent).toContain('All types');
  expect(searches()).toHaveLength(count);

  await click('[data-command="picker-browse-types"]'); await input('CeTask'); await key('Enter'); await settle();
  expect($('#picker-query').value).toBe('Quarterly');
  expect(searches().at(-1)[0]).toMatchObject({query:'Quarterly',type:'CeTask'});
  expect($('#picker-results').textContent).toContain('No objects');
  expect($('#picker-results').textContent).toContain('Search all types');
  await click('#picker-results [data-command="picker-type"]'); await settle();
  expect($('#picker-query').value).toBe('Quarterly');
  expect($('#picker-results').textContent).toContain(object.name);

  // A failed search is retryable, keeps the query and never exposes stale choices.
  fail=true; await input('risk_01'); await settle();
  expect($('#picker-results').textContent).toContain('Connection lost');
  expect($('#picker-results [role="option"]')).toBeNull();
  expect($('#picker-footer').textContent).toContain('Search failed');
  fail=false; await click('[data-command="picker-retry-search"]'); await settle();
  expect($('#picker-query').value).toBe('risk_01');
  expect($('#picker-results').textContent).toContain(object.name);

  // Cancellation must also work when an old API promise ignores AbortSignal.
  hold=true; await input('Quarterly');
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  await click('[data-command="picker-browse-types"]');
  const activeRequest = searches().at(-1);
  expect(activeRequest[1].signal.aborted).toBe(true);
  await key('Escape'); await settle(); // starts the same query again
  release([{...object,id:'stale',name:'Quarterly obsolete response'}]); await tick();
  expect($('#picker-results').textContent).toContain(object.name);
  expect($('#picker-results').textContent).not.toContain('obsolete');
  await key('Enter'); await tick();
  expect($('#picker')).toBeNull();
  expect($('[data-command="choose-object"]').textContent).toContain(object.name);
  expect(document.activeElement).toBe($('[data-command="choose-object"]'));
});
