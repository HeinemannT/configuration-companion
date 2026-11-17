/** Optional, saved-snapshot evidence. Failures are explicit and retryable;
 * successful identities survive a partial response. No data enters undo state. */
export function createMatrixEvidenceLoader({ load, validate, changed, batchSize = 2000 }) {
  let source, value = null, pending = [], failed = new Set(), unsupported = new Set(), total = 0;
  let request = null, attempted = false, error = '';
  function reset() {
    request?.controller.abort(); request = null; source = undefined; value = null;
    pending = []; failed = new Set(); unsupported = new Set(); total = 0; attempted = false; error = '';
  }
  function read() {
    const resolved = Object.keys(value?.references ?? {}).length;
    const parts = [];
    if (request) parts.push('Loading evidence…');
    else if (!value && error) parts.push('Type evidence unavailable');
    if (total && (pending.length || failed.size || unsupported.size || request)) parts.push(`${resolved} / ${total} references resolved`);
    if (failed.size) parts.push(`${failed.size} unavailable`);
    if (unsupported.size) parts.push(`${unsupported.size} unsupported`);
    if (pending.length) parts.push(`${pending.length} not loaded`);
    return { value, loading:!!request, status:parts.join(' · '), canRetry:!request && (!!failed.size || !!error), remaining:pending.length };
  }
  async function run(retry = false) {
    if (request || !source) return;
    const tokens = retry ? [...failed].slice(0,batchSize) : pending.slice(0,batchSize);
    if (!tokens.length && attempted && !error) return;
    const job = { source, tokens, controller:new globalThis.AbortController() }; request = job; attempted = true;
    try {
      const incoming = await load(tokens,job.controller.signal);
      if (request !== job || source !== job.source || job.controller.signal.aborted) return;
      if (!incoming?.types || !incoming.references) throw new Error('Incomplete matrix evidence response.');
      const merged = { ...incoming, references:{...value?.references,...incoming.references} };
      validate(merged);
      value = merged; error = '';
      const submitted = new Set(tokens);
      pending = pending.filter(t=>!submitted.has(t));
      for (const token of tokens) {
        failed.delete(token); unsupported.delete(token);
        if (incoming.unsupported?.includes(token)) unsupported.add(token);
        else if (!Object.hasOwn(incoming.references,token)) failed.add(token);
      }
    } catch (failure) {
      if (request !== job || source !== job.source || job.controller.signal.aborted) return;
      error = failure instanceof Error ? failure.message : String(failure);
      const submitted = new Set(tokens); pending = pending.filter(t=>!submitted.has(t));
      for (const token of tokens) failed.add(token);
    } finally {
      if (request === job) { request = null; changed(); }
    }
  }
  return {
    read, reset,
    ensure(key,tokens) {
      if (source === key) return;
      reset(); source = key; pending = [...new Set(typeof tokens === 'function' ? tokens() : tokens)]; total = pending.length;
      return run();
    },
    retry() { const promise = run(true); changed(); return promise; },
    more() { const promise = run(); changed(); return promise; },
  };
}
