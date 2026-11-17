import {prepareChecks, policyTotals} from './performance-model.js';
import {performanceFindings} from './performance-findings.js';

/** One recording owns immutable snapshots/checks; progress and UI state do not
 * invalidate their analysis. Appended measurements are projected exactly once. */
export function createPerformanceProjection() {
  let snapshot, findings, cache, checks = [], totals = [];
  return (recording, nextSnapshot) => {
    if (snapshot !== nextSnapshot) {
      snapshot = nextSnapshot;
      findings = performanceFindings(snapshot);
      cache = new WeakMap();
      checks = [];
    }
    const next = (recording?.checks || []).map(check => {
      if (!cache.has(check)) cache.set(check, prepareChecks({checks:[check]}, snapshot)[0]);
      return cache.get(check);
    }).filter(Boolean);
    if (next.length !== checks.length || next.some((check,i)=>check!==checks[i])) {
      checks = next;
      totals = policyTotals(checks);
    } else if (!next.length) totals = [];
    return {checks, findings, totals};
  };
}
