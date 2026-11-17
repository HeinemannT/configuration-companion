/** Plain-text labels for access-trace nodes, shared by the Access workspace
 *  and the object window's Access mode. */
import type { AccessTraceNode } from '../types';

export const words = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const labels: Record<string, string> = {
  TraceRequest: 'Access test', All: 'All conditions', Any: 'Any condition', Not: 'Not',
  Equal: 'Equals', ContainsAny: 'Contains any', ContainsAll: 'Contains all',
  NotEmpty: 'Is not empty', Empty: 'Is empty', HasRole: 'Has role',
};
export function traceLabel(node: AccessTraceNode): string {
  const d = node.details;
  if (node.element === 'Statement') {
    const index = /^\d+$/.test(d.statementIndex ?? '') ? Number(d.statementIndex) + 1 : undefined;
    return [d.policyRid_name || d.policyRid || 'Policy', index === undefined ? 'Statement' : 'Statement ' + index, d.effect?.toLowerCase()].filter(Boolean).join(' · ');
  }
  if (node.element === 'TraceRequest') return [d.action, d.resource_name || d.resourceId].filter(Boolean).join(' · ') || 'Access test';
  return labels[node.element] ?? words(node.element);
}
