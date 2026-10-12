// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { AccessTraceNode } from '../lib/types';
import { traceRules, traceOutcome } from './trace-summary';
const node = (element: string, result: boolean | null, children: AccessTraceNode[] = [], details = {}): AccessTraceNode => ({ element, result, children, details, timedOut: false });
it('shows unevaluated conditions as skipped after an action mismatch, without claiming they matched', () => {
  const trace = node('TraceRequest', false, [node('Statement', false, [node('Subject', true), node('Action', false)],
    { policyRid:'9223372036854775800', policyRid_name:'<Read policy>', statementIndex:'2', effect:'ALLOW' })]);
  expect(traceRules(trace)[0]).toMatchObject({ subject:'matched', action:'failed', resource:'skipped' });
  expect(traceRules(trace)[0].node.details.policyRid).toBe('9223372036854775800');
});
it('keeps related-object requests out of the current decision summary and reports incomplete results', () => {
  const nested = node('Statement', true, [], { policyRid:'2', statementIndex:'0' });
  const trace = node('TraceRequest', null, [node('HasAccessTo', false, [node('Access request', true, [nested])])]);
  expect(traceRules(trace)).toEqual([]);
  expect(traceOutcome(trace)).toMatchObject({ tone:'unknown' });
  expect(traceOutcome({ ...trace, result:true, timedOut:true })).toMatchObject({ tone:'unknown', label:'Timed out' });
});
it('uses a consistent outcome vocabulary without mistaking timeouts for grants', () => {
  expect(traceOutcome(node('TraceRequest',true))).toMatchObject({tone:'allowed',label:'Granted'});
  expect(traceOutcome(node('TraceRequest',false))).toMatchObject({tone:'denied',label:'Denied'});
  const timedOut={...node('Subject',true),timedOut:true};
  expect(traceRules(node('TraceRequest',null,[node('Statement',null,[timedOut])]))[0]).toMatchObject({subject:'unknown',action:'skipped'});
});
