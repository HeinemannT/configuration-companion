import { expect, it } from 'vitest';
import { formatTraceMs, renderTestTiming } from './trace-timing';
it.each([[0,'0 ms'],[0.00001,'<0.01 ms'],[12.345,'12.35 ms'],[1234.5,'1,235 ms'],[undefined,'—'],[-1,'—']])('formats %s as %s', (input, expected) => {
  expect(formatTraceMs(input)).toBe(expected);
});
it('distinguishes server time from the wait for the test response and omits unavailable timings', () => {
  const html=renderTestTiming(0.001,280);
  expect(html).toContain('Engine '); expect(html).toContain('&lt;0.01 ms'); expect(html).toContain('Request 280 ms');
  expect(html).toContain('Parent and child times overlap');
  expect(renderTestTiming(undefined,20)).not.toContain('Engine');
  expect(renderTestTiming(undefined,undefined)).toBe('');
});
