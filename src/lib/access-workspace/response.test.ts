import { expect, it } from 'vitest';
import { completedValue } from './response';

it('leads with the native error instead of successful preview log entries', () => {
  const log = 'Would add AccessPolicy\nInvalid policy: Test\nACCESS_PREVIEW_receipt';
  expect(() => completedValue({ ok: false, hasError: true, log, outputEntries: [
    { logType: 'MESSAGE', message: 'Would add AccessPolicy', result: false },
    { logType: 'ERROR', message: 'Invalid policy: Test', result: false },
    { logType: 'MESSAGE', message: 'ACCESS_PREVIEW_receipt', result: true },
  ] })).toThrow('Invalid policy: Test\n\n' + log);
});

it('reports warnings, transport errors and unstructured failures without losing their reason', () => {
  expect(() => completedValue({ ok: true, hasWarning: true, outputEntries: [
    { logType: 'WARNING', message: 'Reference not resolved', result: false },
  ] })).toThrow('Reference not resolved');
  expect(() => completedValue({ ok: false, error: 'Connection lost', log: 'Earlier output' }))
    .toThrow('Connection lost\n\nEarlier output');
  expect(() => completedValue({ ok: false, log: 'Legacy failure' })).toThrow('Legacy failure');
});
