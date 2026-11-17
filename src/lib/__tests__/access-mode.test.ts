import { describe, expect, it } from 'vitest';
import type { AccessTraceNode } from '../types';
import {
  actionWords, addChildUpdates, isTraceUnavailable, notGrantingSummary, matchDecisionTraces, planDecisionCommands, statementOutcome, topStatements, verdictFromTrace,
} from '../access-mode';
import { extractAccessTraceLists } from '../bmp-client';

const node = (element: string, result: boolean | null, details: Record<string, string> = {}, children: AccessTraceNode[] = [], timedOut = false): AccessTraceNode =>
  ({ element, result, timedOut, details, children });

const stmt = (policy: string, index: number, result: boolean, parts: { subject?: boolean; action?: boolean; cond?: boolean } = {}, effect = 'ALLOW', via = 'role:roleBasic') =>
  node('Statement', result, { policyRid: '11', policyRid_name: policy, statementIndex: String(index), effect }, [
    node('Subject', parts.subject ?? true, { original: `[${via}]`, globalMatchEntity: via }),
    ...(parts.action === undefined ? [] : [node('Action', parts.action, { actions: '[READ]', requestedAction: 'READ' })]),
    ...(parts.cond === undefined ? [] : [node('All', parts.cond, {}, [node('Equal', parts.cond, { left: 'resource.type' })])]),
  ]);

const trace = (result: boolean | null, children: AccessTraceNode[], resource = '1', action = 'READ'): AccessTraceNode =>
  node('TraceRequest', result, { resource, action }, children);

describe('verdict derivation from a trace tree', () => {
  it('allowed names the granting statement and how it reached the subject', () => {
    const v = verdictFromTrace(trace(true, [stmt('Other', 0, false, { subject: false }), stmt('Portal objects', 0, true, { action: true, cond: true })]));
    expect(v).toEqual({ state: 'allowed', evaluated: 2, by: [{ policyRid: '11', policyName: 'Portal objects', index: 0, effect: 'ALLOW', via: 'role:roleBasic' }] });
  });

  it('denied counts evaluated statements and reports a matched deny without ranking it', () => {
    const deny = stmt('Archive lock', 1, false, { action: true, cond: true }, 'DENY');
    const v = verdictFromTrace(trace(false, [stmt('A', 0, false, { subject: false }), deny]));
    expect(v.state).toBe('denied');
    if (v.state !== 'denied') return;
    expect(v.evaluated).toBe(2);
    expect(v.denyMatched.map(d => d.policyName)).toEqual(['Archive lock']);
  });

  it('the server result decides, even when a deny matched next to a grant', () => {
    const v = verdictFromTrace(trace(true, [stmt('Lock', 0, false, { action: true, cond: true }, 'DENY'), stmt('Grant', 0, true, { action: true })]));
    expect(v.state).toBe('allowed');
  });

  it('a missing trace, a null result or a timeout is "could not evaluate", never denied', () => {
    expect(verdictFromTrace(undefined).state).toBe('unknown');
    expect(verdictFromTrace(trace(null, [])).state).toBe('unknown');
    const t = trace(false, []); t.timedOut = true;
    const v = verdictFromTrace(t);
    expect(v.state).toBe('unknown');
    expect(v.state === 'unknown' && v.reason).toMatch(/timed out/);
  });

  it('statements of a nested HasAccessTo request are not top-level statements', () => {
    const nested = node('HasAccessTo', true, {}, [node('TraceRequest', true, {}, [stmt('Nested', 0, true)])]);
    const outer = stmt('Outer', 0, true, { action: true });
    outer.children.push(nested);
    expect(topStatements(trace(true, [outer])).map(s => s.details.policyRid_name)).toEqual(['Outer']);
  });

  it('explains why a statement did not grant', () => {
    expect(statementOutcome(stmt('A', 0, false, { subject: false })).why).toBe('Subject does not match');
    expect(statementOutcome(stmt('A', 0, false, { action: false })).why).toBe('Action does not match');
    expect(statementOutcome(stmt('A', 0, false, { action: true, cond: false })).why).toBe('Condition false');
    expect(statementOutcome(stmt('A', 0, true)).grants).toBe(true);
  });
});

describe('batched decision requests', () => {
  it('plans READ, UPDATE and DELETE for all nodes, and one CREATE per node naming it as parent', () => {
    const plan = planDecisionCommands(['1', '2']);
    expect(plan.map(c => `${c.action}:${c.rids.join('+')}`)).toEqual(['READ:1+2', 'UPDATE:1+2', 'DELETE:1+2', 'CREATE:1', 'CREATE:2']);
    expect(plan[3].updates).toEqual(addChildUpdates('1'));
    expect(addChildUpdates('1')).toEqual({ type: '', parent_rid: '1' });
  });

  it('matches multi-resource traces by reported resource, not by position', () => {
    const plan = planDecisionCommands(['1', '2']);
    const lists = [
      [trace(true, [], '2'), trace(false, [], '1')],
      [trace(false, [], '1'), trace(false, [], '2')],
      [trace(false, [], '1'), trace(false, [], '2')],
      [trace(true, [], '')],
      [trace(false, [], '')],
    ];
    const out = matchDecisionTraces(plan, lists);
    expect(out['1'].READ?.state).toBe('denied');
    expect(out['2'].READ?.state).toBe('allowed');
    expect(out['1'].CREATE?.state).toBe('allowed');
    expect(out['2'].CREATE?.state).toBe('denied');
  });

  it('a node the server left out is "could not evaluate"; a short answer is an error', () => {
    const plan = planDecisionCommands(['1', '2']);
    const lists = [[trace(true, [], '1')], [], [], [trace(true, [])], [trace(true, [])]];
    const out = matchDecisionTraces(plan, lists);
    expect(out['2'].READ?.state).toBe('unknown');
    expect(out['2'].UPDATE?.state).toBe('unknown');
    expect(() => matchDecisionTraces(plan, lists.slice(0, 4))).toThrow(/4 of 5/);
  });

  it('unwraps one response per command and rejects a server exception', () => {
    const dto = (result: boolean, resource: string) => ({ element: 'TraceRequest', result: { value: result }, details: { $map: { resource } }, childrenDTOs: { $elements: [] } });
    const objects = [{ $class: 'java.util.ArrayList', $elements: [
      { response: { traces: { $elements: [dto(true, '1'), dto(false, '2')] } } },
      { response: { traces: { $elements: [dto(false, '1')] } } },
    ] }];
    const lists = extractAccessTraceLists(objects, 2);
    expect(lists.map(l => l.map(t => `${t.details.resource}=${t.result}`))).toEqual([['1=true', '2=false'], ['1=false']]);
    expect(() => extractAccessTraceLists(objects, 3)).toThrow(/2 of 3/);
    expect(() => extractAccessTraceLists([{ $class: 'x.ServerExceptionResponse', message: 'no' }], 1)).toThrow('no');
  });

  it('recognises an older server that does not know the command', () => {
    expect(isTraceUnavailable(new Error('java.lang.ClassNotFoundException: com.corporater.bmp.dto.command.access.AccessTraceCommand'))).toBe(true);
    expect(isTraceUnavailable(new Error('local class incompatible: stream classdesc serialVersionUID = 1'))).toBe(true);
    expect(isTraceUnavailable(new Error('Access denied for this session'))).toBe(false);
    expect(isTraceUnavailable(new Error('BMP at x timed out'))).toBe(false);
  });
});

describe('trace words', () => {
  it('BMP action names read as the actions of the window', () => {
    expect(actionWords('CREATE')).toBe('Add child');
    expect(actionWords('READ, UPDATE')).toBe('Read, Write');
    expect(actionWords('EXECUTE')).toBe('EXECUTE');
  });

  it('summarises why statements did not grant, most common reason first', () => {
    const list = [
      stmt('A', 0, false, { subject: false }), stmt('B', 0, false, { subject: false }), stmt('C', 0, false, { subject: false }),
      stmt('D', 0, false, { action: false }), stmt('E', 0, false, { action: true, cond: false }),
    ];
    expect(notGrantingSummary(list)).toBe('3 for other subjects · 1 for another action · 1 failed a condition');
    expect(notGrantingSummary(list, 2)).toBe('3 for other subjects · 2 other');
  });
});
