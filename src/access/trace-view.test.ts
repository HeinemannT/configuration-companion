// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { AccessTraceNode } from '../lib/types';
import { expandTrace, renderTrace, traceDecision, traceLabel, selectedRuleTrace } from './trace-view';

const fixture = (): AccessTraceNode => ({ element: 'TraceRequest', result: false, timedOut: false, details: { action: 'READ', resource_name: 'Object' }, children: [{
  element: 'Statement', result: false, timedOut: false, details: { policyRid_name: '<Policy>', statementIndex: '0', effect: 'ALLOW' }, children: [{
    element: 'Subject', result: false, timedOut: false, details: { original: 'role:reader' }, children: [],
  }],
}] });
it('names the policy and one-based rule, with booleans distinct from the final decision', () => {
    const trace = fixture();
  expect(traceLabel(trace.children[0])).toBe('<Policy> · Rule 1 · allow');
  expect(traceDecision(trace)).toBe('Denied');
  expect(traceDecision(trace.children[0])).toBe('False');
  expect(traceDecision({ ...trace, timedOut: true })).toBe('Timed out');
});
it('escapes labels and loads descendants once, only when expanded', () => {
  const trace = fixture();
  const host = document.createElement('div'); host.innerHTML = renderTrace(trace);
  expect(host.querySelector('policy')).toBeNull();
  expect(host.querySelectorAll('.trace-node')).toHaveLength(2);
  const branch = host.querySelector<HTMLDetailsElement>('[data-trace-path="0"]')!;
  expandTrace(branch, trace); expect(host.querySelectorAll('.trace-node')).toHaveLength(2);
  branch.open = true; expandTrace(branch, trace); expandTrace(branch, trace);
  expect(host.querySelectorAll('.trace-node')).toHaveLength(3);
  expect(branch.textContent).toContain('Statement index (0-based)');
  expect(branch.textContent).not.toContain('role:reader');
  const leaf = host.querySelector<HTMLDetailsElement>('[data-trace-path="0.0"]')!;
  leaf.open = true; expandTrace(leaf, trace);
  expect(leaf.textContent).toContain('role:reader');
});
it('distinguishes grants, predicate failures, Deny matches and absent or nested rules', () => {
  const root = fixture(), rule = root.children[0];
  rule.details.policyRid = '9000000000000000001';
  expect(selectedRuleTrace(root, rule.details.policyRid, 0).label).toBe('Did not match');
  rule.details.effect = 'DENY';
  rule.children = Array.from({length:3},()=>({...rule.children[0],result:true}));
  expect(selectedRuleTrace(root, rule.details.policyRid, 0).label).toBe('Matched · Deny');
  rule.children = [];
  expect(selectedRuleTrace(root, rule.details.policyRid, 0).label).toBe('Did not grant access');
  rule.result = true;
  expect(selectedRuleTrace(root, rule.details.policyRid, 0).label).toBe('Granted access');
  expect(selectedRuleTrace({...root,children:[{...root,children:[rule]}]},rule.details.policyRid,0).label).toBe('Not shown in this trace');
  rule.result = false;
  rule.children = [{element:'HasAccessTo',result:false,timedOut:false,details:{reference:'new.commentOn',action:'UPDATE'},children:[{...fixture(),element:'Access request'}]}];
  expect(selectedRuleTrace(root,rule.details.policyRid,0).failures).toEqual([{field:'commentOn',label:'Update access to related object · new.commentOn',path:'0.0'}]);
});

it('blocks ambiguous rule destinations in both immediate and lazily expanded trace branches', () => {
  const trace = fixture(), rule = trace.children[0];
  rule.details.policyRid = '9000000000000000001';
  trace.children.push({ ...trace, children: [structuredClone(rule)] });
  const canOpen = (rid: string, index: number) => rid === rule.details.policyRid && index === 1;
  const host = document.createElement('div'); host.innerHTML = renderTrace(trace, canOpen);
  const direct = host.querySelector<HTMLButtonElement>('.trace-open')!;
  expect(direct.disabled).toBe(true);
  expect(direct.title).toContain('differs from the local draft');
  expect(host.textContent).toContain('Denied');
  const nested = host.querySelector<HTMLDetailsElement>('[data-trace-path="1"]')!;
  nested.open = true; expandTrace(nested, trace, canOpen);
  expect(nested.querySelector<HTMLButtonElement>('.trace-open')!.disabled).toBe(true);
  rule.details.statementIndex = '1';
  host.innerHTML = renderTrace(trace, canOpen);
  expect(host.querySelector<HTMLButtonElement>('.trace-open')!.disabled).toBe(false);
});
