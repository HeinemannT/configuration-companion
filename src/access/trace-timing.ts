const precise = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatTraceMs(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms > 0 && ms < 0.01) return '<0.01 ms';
  return (ms < 100 ? precise : whole).format(ms) + ' ms';
}

export function renderTraceTiming(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  return `<span class="trace-timing" title="BMP diagnostic elapsed time, including nested evaluations. This trace is sequential and uncached; normal access checks may use indexing and caching. Parent and child times overlap.">${formatTraceMs(ms).replace('<','&lt;')}</span>`;
}

export function renderTestTiming(engineMs: unknown, requestMs: unknown): string {
  const engine = renderTraceTiming(engineMs);
  const request = typeof requestMs === 'number' && Number.isFinite(requestMs) && requestMs >= 0
    ? `<span class="trace-timing" title="Time waiting for the complete test response, including preparation, transport and polling; excludes rendering.">Request ${formatTraceMs(requestMs).replace('<','&lt;')}</span>` : '';
  return engine || request ? `<span class="test-timing">${engine ? 'Engine '+engine : ''}${engine && request ? '<span>·</span>' : ''}${request}</span>` : '';
}
