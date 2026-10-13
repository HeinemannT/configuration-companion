import { performancePlan, performanceRevision } from './performance-plan.js';

export const PERFORMANCE_BUDGET_MS = 8 * 60 * 1000;
const reusable = run => run?.complete && !run.stale && run.checks.length && !run.failures?.length;

// A transport that fails to settle after cancellation must not hold the run open.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once:true});
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Owns the live run independently of the mounted view. Never writes policies. */
export function createPerformanceController({api, getSnapshot, getSeeds=()=>[]}) {
  const listeners = new Set();
  const state = {running:false, progress:'', current:null, previous:null, error:'', completed:0, total:0};
  let controller = null, generation = 0;
  const notify = () => listeners.forEach(fn => fn(state));
  function stop() {
    generation++;
    controller?.abort();
    controller = null;
    state.running = false;
    state.progress = 'Stopped · completed checks retained';
    notify();
  }
  function invalidate() {
    stop();
    if (state.current) state.current.historical = true;
    state.progress = 'Configuration changed · rerun to compare';
    notify();
  }
  async function run(reuse=false, seed=null) {
    if (state.running) return;
    const token = ++generation, abort = new globalThis.AbortController();
    controller = abort;
    const before = state.current;
    const baseline = reusable(before) ? before : state.previous;
    const request = r => abortable(api(r, {signal:abort.signal}), abort.signal);
    const owned = () => token === generation;
    const active = () => owned() && !abort.signal.aborted;
    const timer = globalThis.setTimeout(() => abort.abort(new Error('Analysis reached its eight-minute budget. Completed checks are retained. Profile a smaller set of prepared tests.')), PERFORMANCE_BUDGET_MS);
    state.running = true;
    state.error = '';
    state.progress = seed ? 'Preparing access check…' : 'Discovering policies and sample objects…';
    state.completed = 0;
    state.total = 0;
    notify();
    try {
      // Refresh schema facts on a full rerun. Old cardinality must not support
      // overlap suggestions about a new configuration.
      const discovery = seed
        ? {...await request({operation:'load'}), objects:[], assignedUsers:[], problems:[], scope:{prepared:true, sampledTypes:[seed.object.type], unsampledTypes:[]}}
        : await request({operation:'performanceDiscover'});
      if (!active()) return;
      if (discovery.snapshot.environment !== getSnapshot().environment) throw Error('The analysis belongs to a different environment.');
      const previousContexts = before?.plan?.checks || before?.checks.map(({runs,indexedRuns,...c})=>c);
      const plan = seed ? {checks:[seed], capped:false, needsCreate:0}
        : reuse && previousContexts?.length ? {...before.plan, checks:previousContexts}
        : performancePlan(discovery, getSeeds());
      const current = {snapshot:discovery.snapshot, checks:[], failures:[], plan, scope:discovery.scope, problems:[...discovery.problems], complete:false, stale:false, recordedAt:new Date().toISOString()};
      state.previous = baseline?.snapshot.environment === discovery.snapshot.environment ? baseline : null;
      state.current = current;
      state.total = plan.checks.length;
      notify();
      for (const c of plan.checks) {
        if (!active()) return;
        state.progress = `Measuring ${state.completed+1} of ${state.total} · ${c.actor.name||c.actor.id} · ${c.action} · ${c.object.id}`;
        notify();
        try {
          const result = await request({operation:'performanceMeasure', request:c.request});
          if (!active()) return;
          if (!Array.isArray(result.runs) || !Array.isArray(result.indexedRuns) || result.runs.length !== 5 || result.indexedRuns.length !== 5) throw Error('Incomplete measurement response.');
          current.checks.push({...c,...result});
        } catch (error) {
          if (abort.signal.aborted) throw abort.signal.reason;
          if (!owned()) return;
          const message = error.message || String(error);
          current.failures.push({...c, error:message});
          current.problems.push(`${c.actor.id} · ${c.object.id} · ${c.action}: ${message}`);
        }
        state.completed++;
        notify();
      }
      if (!active()) return;
      state.progress = 'Checking configuration revision…';
      notify();
      const after = await request({operation:'load'});
      if (!active()) return;
      current.stale = performanceRevision(current.snapshot) !== performanceRevision(after.snapshot);
      current.complete = true;
      state.progress = current.stale ? 'Configuration changed during measurement · analyze again'
        : `${current.checks.length} of ${plan.checks.length} checks measured${current.problems.length?' · some contexts need attention':''}`;
    } catch (error) {
      if (owned()) {
        state.error = error.message || String(error);
        state.progress = 'Analysis interrupted · completed checks retained';
      }
    } finally {
      globalThis.clearTimeout(timer);
      if (owned()) { state.running = false; controller = null; notify(); }
    }
  }
  return {state, run, stop, invalidate, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }};
}
