/**
 * Self-healing connection states (audit items 2, 3, 4, 5, 7, 10).
 *
 * The harness drives connection.ts through its public functions with mocked
 * health and command probes, and a chrome.alarms mock that records the
 * recovery schedule (alarms survive MV3 worker sleep; timers do not).
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { ObjectCache } from '../object-cache';
import type { InspectorSettings } from '../types';
import type { HealthCheckResult } from '../bmp-client';
import type { BmpTransportOutcome } from '../bmp-transport';

type TestConn = { ok: boolean; message: string; authenticated: boolean; code?: 'needs-login' | 'auth-failed' | 'transport' };

async function harness(opts: { commandAuthMode?: 'portal' | 'stored' } = {}) {
  vi.resetModules();
  vi.restoreAllMocks();
  mockChromeStorage();
  vi.stubGlobal('navigator', { onLine: true });
  const alarms = new Map<string, { delayInMinutes?: number }>();
  (globalThis.chrome as any).alarms = {
    create: vi.fn(async (name: string, info: { delayInMinutes?: number }) => { alarms.set(name, info); }),
    clear: vi.fn(async (name: string) => alarms.delete(name)),
    get: vi.fn(async (name: string) => (alarms.has(name) ? { name, scheduledTime: 0 } : undefined)),
  };

  let health: HealthCheckResult = { up: true, reachable: true, responseMs: 5 };
  const healthQueue: HealthCheckResult[] = [];
  let conn: TestConn = { ok: true, message: 'ok', authenticated: true };
  const connQueue: TestConn[] = [];

  const bmp = await import('../bmp-client');
  const checkHealth = vi.spyOn(bmp.BmpClient, 'checkHealth').mockImplementation(async () => healthQueue.shift() ?? health);
  vi.spyOn(bmp.BmpClient, 'getBuildNumber').mockResolvedValue({ status: 'unavailable' });
  const portal = await import('../portal-identity');
  let portalUser: string | null = 'admin';
  vi.spyOn(portal, 'probePortalIdentity').mockImplementation(async () => (portalUser
    ? { status: 'connected', user: portalUser, source: 'portal-session' }
    : { status: 'unavailable', user: null, source: 'portal-session', error: 'No active BMP portal login.' }));

  const client = new bmp.BmpClient('https://bmp.test/Ws/', 'admin', 'pw', 'p1', opts.commandAuthMode ?? 'portal');
  const fakeAuth: any = {
    retryAuthentication: vi.fn(async () => {}),
    restoreFromSession: vi.fn(async () => false),
    logout: vi.fn(() => { fakeAuth.portalActor = null; }),
    bindPortalActor: vi.fn((actor: string) => { fakeAuth.portalActor = actor; }),
    commandUser: 'admin',
    portalActor: 'admin',
    jwt: null,
  };
  (client as any).auth = fakeAuth;
  const testConnection = vi.spyOn(bmp.BmpClient.prototype, 'testConnection').mockImplementation(async () => connQueue.shift() ?? conn);
  let observer: ((o: BmpTransportOutcome) => void) | null = null;
  vi.spyOn(client, 'setTransportOutcomeObserver').mockImplementation((fn: any) => { observer = fn; });

  const settings: InspectorSettings = {
    schemaVersion: 4,
    profiles: [{ id: 'p1', label: 'P1', bmpUrl: 'https://bmp.test/Ws/', bmpUser: 'admin', bmpPass: 'pw', commandAuthMode: opts.commandAuthMode ?? 'portal' }],
    activeProfileId: 'p1', autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
  };
  const ctx: any = {
    client, hasPanel: false, panelPortByWindow: new Map(), contentPorts: new Map(), cache: new ObjectCache(),
    settings, settingsReady: Promise.resolve(), logActivity: vi.fn(), sendToPanel: vi.fn(),
    sendToPanelByWindow: vi.fn(), sendToPanelByTab: vi.fn(), broadcastToContent: vi.fn(), toast: vi.fn(),
  };
  (await import('../sw-context')).setSwContext(ctx);
  const c = await import('../connection');
  c.configureConnectionTiming({ retryDelayMs: 1, validationDeadlineMs: 2_000, loginEvidenceGapMs: 0 });
  c.resetConnectionState();
  c.bindConnectionClient(client, 'p1');
  const recovery = await import('../connection-recovery');
  recovery.resetRecoveryMemory();

  return {
    ctx, c, recovery, alarms, checkHealth, testConnection,
    setHealth: (r: HealthCheckResult) => { health = r; },
    queueHealth: (...r: HealthCheckResult[]) => { healthQueue.push(...r); },
    setConn: (r: TestConn) => { conn = r; },
    queueConn: (...r: TestConn[]) => { connQueue.push(...r); },
    setPortalUser: (u: string | null) => { portalUser = u; },
    outcome: (o: Partial<BmpTransportOutcome> & { ok: boolean }) => observer!({
      operation: 'ec', intent: 'read', durationMs: 5, queueWaitMs: 0, queueDepth: 0, attempts: 1,
      requestBytes: 1, responseBytes: 1, ...o,
    } as BmpTransportOutcome),
    settle: () => new Promise(r => setTimeout(r, 20)),
  };
}

const DOWN: HealthCheckResult = { up: false, reachable: false, responseMs: 0, detail: 'No answer within 5 seconds.' };
const UP: HealthCheckResult = { up: true, reachable: true, responseMs: 5 };

describe('retry once before declaring a failure (item 3)', () => {
  it('one dropped health probe does not turn the state red', async () => {
    const h = await harness();
    h.queueHealth(DOWN);
    await h.c.validateConnection('background');
    expect(h.checkHealth).toHaveBeenCalledTimes(2);
    expect(h.c.computeConnectionState().display).toBe('connected');
  });

  it('two failed probes are an outage, with the reason kept as detail', async () => {
    const h = await harness();
    h.setHealth(DOWN);
    h.setConn({ ok: false, message: 'fetch failed', authenticated: false, code: 'transport' });
    await h.c.validateConnection('background');
    const s = h.c.computeConnectionState();
    expect(s.display).toBe('unreachable');
    expect(s.detail).toBe('No answer within 5 seconds.');
  });

  it('one dropped command probe is retried before "Commands failing"', async () => {
    const h = await harness();
    h.queueConn({ ok: false, message: 'socket closed', authenticated: true });
    await h.c.runAuthTest('background');
    expect(h.testConnection).toHaveBeenCalledTimes(2);
    expect(h.c.computeConnectionState().display).toBe('connected');
  });

  it('a definite sign-in answer is not retried', async () => {
    const h = await harness();
    h.setConn({ ok: false, message: 'rejected', authenticated: false, code: 'auth-failed' });
    await h.c.runAuthTest('background');
    expect(h.testConnection).toHaveBeenCalledTimes(1);
  });

  it('bounds a hanging validation with one overall deadline instead of staying on Checking', async () => {
    const h = await harness();
    h.c.configureConnectionTiming({ validationDeadlineMs: 50 });
    h.testConnection.mockImplementation(() => new Promise(() => { /* never answers */ }));
    await h.c.runAuthTest('background');
    const s = h.c.computeConnectionState();
    expect(s.display).toBe('command-failed');
    expect(s.validation).toBe('idle');
    expect(s.authError).toMatch(/did not complete the connection check/);
  });
});

describe('recovery without a click (item 2)', () => {
  it('schedules an alarm with backoff while unreachable, and recovers to Connected on the alarm', async () => {
    const h = await harness();
    h.setHealth(DOWN);
    h.setConn({ ok: false, message: 'fetch failed', authenticated: false, code: 'transport' });
    await h.c.validateConnection('background');
    await h.settle();
    expect(h.alarms.get('crev-connection-recovery')?.delayInMinutes).toBe(0.5);

    // Still down at the first alarm: the next one is further away.
    await h.c.runRecoveryCheck();
    expect(h.alarms.get('crev-connection-recovery')?.delayInMinutes).toBe(1);

    // The server is back: reachability heals and the sign-in is redone.
    h.setHealth(UP);
    h.setConn({ ok: true, message: 'ok', authenticated: true });
    await h.c.runRecoveryCheck();
    await h.settle();
    expect(h.c.computeConnectionState().display).toBe('connected');
    expect(h.alarms.has('crev-connection-recovery')).toBe(false);
  });

  it('keeps the schedule in session storage so a woken worker continues it', async () => {
    const h = await harness();
    h.setHealth(DOWN);
    await h.c.pollHealth(true);
    await h.settle();
    const stored = await chrome.storage.session.get('crev_conn_recovery');
    expect(stored.crev_conn_recovery).toEqual({ profileId: 'p1', attempt: 0 });
  });

  it('treats a successful command as proof that the server is up', async () => {
    const h = await harness();
    await h.c.runAuthTest('background');
    h.setHealth({ up: false, reachable: true, responseMs: 3, detail: 'HTTP 503' });
    await h.c.pollHealth(true);
    expect(h.c.computeConnectionState().display).toBe('server-down');

    h.outcome({ ok: true });
    expect(h.c.computeConnectionState().display).toBe('connected');
  });

  it('re-checks after a command failure even with the side panel closed (item 5)', async () => {
    const h = await harness();
    await h.c.runAuthTest('background');
    h.ctx.hasPanel = false;
    h.testConnection.mockClear();
    h.outcome({ ok: false, error: { kind: 'network', message: 'reset' } } as any);
    await h.settle();
    expect(h.testConnection).toHaveBeenCalled();
  });
});

describe('reconnect after signing in again (item 4)', () => {
  it('login evidence reconnects a "Sign in to BMP" state', async () => {
    const h = await harness();
    h.setPortalUser(null);
    await h.c.runAuthTest('background');
    expect(h.c.computeConnectionState().display).toBe('needs-login');

    h.setPortalUser('admin');
    h.c.noteLoginEvidence();
    await h.settle();
    expect(h.c.computeConnectionState().display).toBe('connected');
  });

  it('ignores login evidence when the connection works', async () => {
    const h = await harness();
    await h.c.runAuthTest('background');
    h.testConnection.mockClear();
    h.c.noteLoginEvidence();
    await h.settle();
    expect(h.testConnection).not.toHaveBeenCalled();
  });
});

describe('not a BMP workspace (item 10)', () => {
  it('is its own state with an edit fix, not Online', async () => {
    const h = await harness();
    h.setHealth({ up: false, reachable: true, notWorkspace: true, responseMs: 4, detail: 'cs/authentication answered HTTP 404.' });
    await h.c.pollHealth(true);
    const s = h.c.computeConnectionState();
    expect(s.display).toBe('not-workspace');
    expect(s.detail).toMatch(/HTTP 404/);
    // A definite answer: one probe, no retry.
    expect(h.checkHealth).toHaveBeenCalledTimes(1);
  });
});

describe('unreadable stored password (item 8)', () => {
  it('shows "Password needed" and never tries to sign in', async () => {
    const h = await harness({ commandAuthMode: 'stored' });
    h.ctx.settings.profiles[0] = { ...h.ctx.settings.profiles[0], bmpPass: '', passwordUnreadable: true };
    await h.c.runAuthTest('explicit');
    expect(h.c.computeConnectionState().display).toBe('needs-password');
    expect(h.testConnection).not.toHaveBeenCalled();
  });
});
