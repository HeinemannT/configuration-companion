import type { BmpClient } from '../bmp-client';

type EcResult = Awaited<ReturnType<BmpClient['executeEc']>>;

/** A log line or successful HTTP status is not proof that EC reached its end. */
export function completedValue(result: EcResult): string {
  if (!result.ok || result.hasError || result.hasWarning) {
    const entries = result.outputEntries ?? [];
    const errors = entries.filter(entry => entry.logType === 'ERROR');
    const issues = errors.length ? errors : entries.filter(entry => entry.logType === 'WARNING');
    const summary = result.error || issues.map(entry => entry.message).join('\n');
    // Preview logs begin with ordinary "Would write" entries. Lead with the
    // reason the operation stopped; retain the complete log under UI Details.
    throw new Error(summary ? summary + (result.log && result.log !== summary ? '\n\n' + result.log : '')
      : result.log || 'BMP did not complete the request.');
  }
  const values = result.outputEntries?.filter(entry => entry.result);
  if (values?.length !== 1) throw new Error('BMP returned an incomplete result. Reload before retrying a write.');
  return values[0].message;
}

export function requireReceipt(result: EcResult, receipt: string): void {
  if (completedValue(result) !== receipt) throw new Error('BMP did not confirm completion. Reload before retrying a write.');
}
