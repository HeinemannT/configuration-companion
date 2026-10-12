import type { AccessTraceNode } from '../lib/types';
import { traceLabel } from './trace-view';

type Stage = 'matched' | 'failed' | 'skipped' | 'unknown';
const stage = (node?: AccessTraceNode): Stage => !node ? 'skipped' : node.timedOut || node.result == null ? 'unknown' : node.result ? 'matched' : 'failed';

/** Only statements in this request. A HasAccessTo child is a different decision. */
export function traceRules(trace: AccessTraceNode) {
  const rules: Array<{ node: AccessTraceNode; path: string; subject: Stage; action: Stage; resource: Stage }> = [];
  function walk(node: AccessTraceNode, path: string) {
    if (node.element === 'Statement') {
      rules.push({ node, path, subject: stage(node.children.find(c => c.element === 'Subject')),
        action: stage(node.children.find(c => c.element === 'Action')),
        resource: stage(node.children.find(c => !['Subject', 'Action'].includes(c.element))) });
      return;
    }
    node.children.forEach((child, index) => {
      if (!['TraceRequest', 'Access request'].includes(child.element)) walk(child, path ? path + '.' + index : String(index));
    });
  }
  walk(trace, '');
  return rules;
}

export function traceOutcome(trace: AccessTraceNode): { tone: string; label: string; glyph: string } {
  if (trace.timedOut || trace.result == null) return { tone: 'unknown', label: trace.timedOut ? 'Timed out' : 'No access decision', glyph: 'warning' };
  return trace.result ? { tone: 'allowed', label: 'Granted', glyph: 'valid' } : { tone: 'denied', label: 'Denied', glyph: 'close' };
}

export function traceRequestLabel(trace: AccessTraceNode): string {
  return traceLabel(trace) + (trace.details.roleId ? ' · ' + trace.details.roleId : trace.details.userId ? ' · ' + trace.details.userId : '');
}
