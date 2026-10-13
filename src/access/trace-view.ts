import type { AccessTraceNode } from '../lib/types';
import { policyDestination } from '../lib/access-workspace/entry';
import { icon } from './icons';
import { renderTraceTiming } from './trace-timing';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const words = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const labels: Record<string, string> = {
  TraceRequest: 'Access test', All: 'All conditions', Any: 'Any condition', Not: 'Not',
  Equal: 'Equals', ContainsAny: 'Contains any', ContainsAll: 'Contains all',
  NotEmpty: 'Is not empty', Empty: 'Is empty', HasRole: 'Has role',
};
export function traceLabel(node: AccessTraceNode): string {
  const d = node.details;
  if (node.element === 'Statement') {
    const index = /^\d+$/.test(d.statementIndex ?? '') ? Number(d.statementIndex) + 1 : undefined;
    return [d.policyRid_name || d.policyRid || 'Policy', index === undefined ? 'Rule' : 'Rule ' + index, d.effect?.toLowerCase()].filter(Boolean).join(' · ');
  }
  if (node.element === 'TraceRequest') return [d.action, d.resource_name || d.resourceId].filter(Boolean).join(' · ') || 'Access test';
  return labels[node.element] ?? words(node.element);
}
export function traceDecision(node: AccessTraceNode): string {
  if (node.timedOut) return 'Timed out';
  if (node.result == null) return 'No result';
  // Nested booleans are predicate results, not separate allow/deny decisions.
  return node.element === 'TraceRequest' ? node.result ? 'Granted' : 'Denied' : node.result ? 'True' : 'False';
}

/** Never confuse nested permission checks, or a Deny rule's false return, with a
 * failed top-level predicate. Statement.resolve returns whether it grants access. */
export function selectedRuleTrace(trace: AccessTraceNode, policyRid: string, statementIndex: number) {
  function find(node: AccessTraceNode, path = ''): { node: AccessTraceNode; path: string } | undefined {
    if (node.element === 'Statement') return node.details.policyRid === policyRid && node.details.statementIndex === String(statementIndex) ? { node, path } : undefined;
    for (const [i, child] of node.children.entries()) {
      if (['TraceRequest', 'Access request'].includes(child.element)) continue;
      const found = find(child, path ? path + '.' + i : String(i));
      if (found) return found;
    }
  }
  const found = find(trace);
  if (!found) return { label: 'Not shown in this trace', failures: [] };
  const { node, path } = found;
  if (node.timedOut) return { label: 'Timed out', path, failures: [] };
  if (node.result === true) return { label: 'Granted access', path, failures: [] };
  const failures: Array<{ label: string; field?: string; path: string }> = [];
  function failed(current: AccessTraceNode, at: string) {
    if (current.result !== false || current.timedOut || current.element === 'TraceRequest') return;
    const operand = current.details.left ?? current.details.reference ?? current.details.original ?? '';
    const match = /^new\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(operand);
    const children = current.children.filter(c => c.element !== 'TraceRequest' && c.result === false);
    // Only descend boolean groups. HasAccessTo owns an independent nested
    // "Access request" with other policies; Not inverts its child's outcome.
    if (['All', 'Any'].includes(current.element) && children.length) {
      current.children.forEach((child, i) => failed(child, at + '.' + i));
    } else failures.push({ label: [current.element === 'HasAccessTo' ? `${current.details.action === 'Inherited' ? 'Required' : words((current.details.action || 'Required').toLowerCase())} access to related object` : traceLabel(current), operand].filter(Boolean).join(' · '), field: match?.[1], path: at });
  }
  node.children.forEach((child, i) => failed(child, path + '.' + i));
  const allMatched = node.children.length >= 3 && node.children.every(c => c.result === true && !c.timedOut);
  return { label: failures.length ? 'Did not match' : node.details.effect?.toUpperCase() === 'DENY' && allMatched ? 'Matched · Deny' : 'Did not grant access', path, failures };
}
const detailLabels: Record<string, string> = {
  userRid: 'User RID', userId: 'User ID', userRid_name: 'User', userGroups: 'Groups',
  roleId: 'Role ID', roleRid: 'Role RID', roleRid_name: 'Role',
  resource: 'Object RID', resourceId: 'Object ID', resource_name: 'Object', resourceType: 'Object type',
  policyRid: 'Policy RID', policyRid_name: 'Policy', statementIndex: 'Statement index (0-based)',
  globalUserRolesDirectlyAssigned: 'Direct global roles', globalUserRolesFromGroups: 'Global roles from groups',
  numberOfAccessChecks: 'Access checks', original: 'Expression', leftResolved: 'Resolved value', leftResolved_name: 'Resolved name',
  left: 'Left operand', right: 'Right operand', requestedAction: 'Requested action',
};
type CanOpenRule = (policyRid: string, statementIndex: number) => boolean;
const allowRule: CanOpenRule = () => true;
function contents(node: AccessTraceNode, path: string, canOpenRule: CanOpenRule): string {
  const details = Object.entries(node.details);
  const metadata = details.length ? '<dl class="trace-fields">' + details.map(([key, value]) => `<dt>${escape(detailLabels[key] ?? words(key))}</dt><dd>${escape(value)}</dd>`).join('') + '</dl>' : '';
  return (node.element === 'TraceRequest' ? `<details class="trace-metadata"><summary>${icon('down')}Test details · ${node.children.length} evaluated rules</summary>${metadata}</details>` : metadata) +
    (node.children.length?'<div class="trace-children">'+node.children.map((child, i) => branch(child, path ? path + '.' + i : String(i), canOpenRule)).join('')+'</div>':'');
}
function branch(node: AccessTraceNode, path: string, canOpenRule: CanOpenRule, root = false): string {
  const result = traceDecision(node);
  const target = node.element === 'Statement' ? policyDestination(node.details) : undefined;
  const disabled = target?.kind === 'policy' && !canOpenRule(target.rid, target.statement ?? 0);
  const link = target?.kind === 'policy' ? `<button type="button" class="trace-open" data-command="open-trace-policy" data-rid="${target.rid}" data-statement="${target.statement ?? 0}" aria-label="Open rule" ${disabled ? 'disabled title="This saved rule differs from the local draft"' : 'title="Open this rule in Access"'}>${icon('open')}</button>` : '';
  const known = !node.timedOut && node.result != null;
  return `<details class="trace-node" data-trace-path="${path}" ${root ? 'open data-trace-loaded="true"' : ''}><summary>${icon('down')}<span class="trace-title">${escape(traceLabel(node))}</span><span class="trace-decision" data-result="${known ? node.result : 'unknown'}" title="${root ? 'Access decision' : 'Evaluation result'}">${icon(known ? node.result ? 'valid' : 'close' : 'warning')}${result}</span>${renderTraceTiming(node.durationMs)}${link}</summary>${root ? contents(node, path, canOpenRule) : ''}</details>`;
}
export const renderTrace = (trace: AccessTraceNode, canOpenRule = allowRule): string => '<div class="trace-tree">' + branch(trace, '', canOpenRule, true) + '</div>';

/** Called on the native details toggle event; closed descendants have no DOM yet. */
export function expandTrace(element: HTMLDetailsElement, trace: AccessTraceNode, canOpenRule = allowRule): void {
  if (!element.open || element.dataset.traceLoaded) return;
  const path = element.dataset.tracePath;
  if (path === undefined) return;
  let node = trace;
  for (const index of path ? path.split('.') : []) {
    node = node.children[Number(index)];
    if (!node) return;
  }
  element.dataset.traceLoaded = 'true';
  element.insertAdjacentHTML('beforeend', contents(node, path, canOpenRule));
}
