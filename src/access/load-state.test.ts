import { expect, it } from 'vitest';
import { loadFailure } from './load-state';

it('words load failures with the shared connection sentences and keeps the detail apart', () => {
  expect(loadFailure(new Error('boom'), false, 'DEV')).toMatchObject({ title: 'No connection', sentence: 'This computer is offline. Companion reconnects when the network returns.', detail: 'boom' });
  expect(loadFailure(new TypeError('Failed to fetch'), true, 'DEV').sentence).toBe('The server does not answer. Check the address and your network or VPN; Companion checks again automatically.');
  const server = loadFailure('HTTP 500', true, 'DEV');
  expect(server).toMatchObject({ title: 'Server error', detail: 'HTTP 500' });
  expect(server.sentence).toContain('BMP commands fail');
});
