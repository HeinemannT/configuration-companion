import type { ConnectionState, ServerProfile } from './types';
import type { AuthErrorCode } from './bmp-auth';
import { getCtx as baseCtx, type SwContext } from './sw-context';
import { hasHostAccess, HostAccessError } from './site-access';
import { BmpClient, type ConnectionResult } from './bmp-client';
import type { BmpTransportOutcome } from './bmp-transport';
import { log, errorMessage } from './logger';
import { CONNECTION_FRESHNESS_TARGET } from './constants';
import { updateBadge } from './badge';
import { incrementGeneration, registerConnectionDisplayFn, registerReachabilityRequestFn } from './enrichment';
import { environmentToken } from './environment';
import { probePortalIdentity } from './portal-identity';
import { unknownIdentityMap, withSameUser, type IdentityMap } from './identity-map';
import { setCurrentIdentities } from './command-actor';
import { createConnectionSnapshot, provisionalConnectionSnapshot, type ConnectionEvidenceSnapshot } from './connection-snapshot';
import { traceConnectionDiagnostic } from './connection-trace';
import { afterRecoveryCheck, clearRecovery, recoveryRecord, syncRecovery } from './connection-recovery';
import { transportActivity } from './transport-activity';

/** Timing for validation. One retry hides a single dropped probe; one overall
 *  deadline stops a cold validation from chaining several request timeouts
 *  (portal probe, ticket exchange, command probe, …) while the UI says Checking. */
const timing = {
  /** Pause before the single retry of a failed health or command probe. */
  retryDelayMs: 1_500,
  /** Upper bound for one complete auth/command validation. */
  validationDeadlineMs: 25_000,
  /** Minimum spacing of login-evidence revalidations (cookie, page load). */
  loginEvidenceGapMs: 2_000,
};
export function configureConnectionTiming(next: Partial<typeof timing>): void {
  Object.assign(timing, next);
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Normalize user-entered URL: add scheme if missing, ensure trailing slash */
export function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (url && !url.endsWith('/')) url += '/';
  return url;
}

/** In-memory copy of `crev_conn_snapshot_by_profile` (filled on restore). */
let snapshotsByProfile: Record<string, ConnectionEvidenceSnapshot> = {};

export type ConnectionValidationReason = 'explicit' | 'background' | 'evidence-change';

/**
 * One connection monitor per server profile. All state below belongs to one
 * profile; `getCtx` returns that profile's bound context (profile-scope.ts),
 * so focusing another window never resets or redirects it.
 */
function createConnection(getCtx: () => SwContext) {
  /** Re-check reachability on demand while the state is Unreachable or Server
   *  down, at most once per REACHABILITY_EVIDENCE_GAP. */
  const REACHABILITY_EVIDENCE_GAP = 15_000;
  let lastReachabilityRequest = 0;
  function requestReachabilityEvidence(): void {
    const now = Date.now();
    if (now - lastReachabilityRequest < REACHABILITY_EVIDENCE_GAP) return;
    lastReachabilityRequest = now;
    void pollHealth(true);
  }

  let healthUp: 'unknown' | 'up' | 'down' | 'unreachable' | 'not-workspace' = 'unknown';
  /** Underlying reason for the latest failed health check (shown on request). */
  let healthDetail: string | null = null;
  let healthVersion: string | null = null;
  let healthResponseMs: number | null = null;
  let authResult: 'pending' | 'ok' | 'failed' = 'pending';
  let authError: string | null = null;
  /** `transport`: the sign-in request itself failed on the network, which is a
   *  reachability problem, not a rejected login. */
  let authErrorCode: AuthErrorCode | 'transport' | null = null;
  let identities: IdentityMap = unknownIdentityMap();
  let commandResult: 'unknown' | 'probing' | 'ok' | 'failed' = 'unknown';
  let commandError: string | null = null;
  let networkOffline = false;
  let needsAccess = false;
  let lastPollTime = 0;
  let connectionGeneration = 0;
  let authTestInFlight: Promise<void> | null = null;
  let authTestGeneration = -1;
  let authTestReason: ConnectionValidationReason = 'background';
  let healthPollInFlight: Promise<void> | null = null;
  let healthPollGeneration = -1;
  let validation: 'idle' | 'validating' = 'idle';
  let verifiedAt: number | null = null;
  let semanticRevision = 0;
  let lastSemanticUpdate = 0;
  let lastSemanticKey: string | null = null;
  let lastSnapshotSignature: string | null = null;
  let nextIncidentEpoch = 0;
  let activeIncidentEpoch = 0;
  let recoveryEpoch = 0;
  let identityMismatch = false;
  /** The last validation did not finish within the overall deadline. */
  let validationTimedOut = false;
  /** Ownership token for the running auth test: a test abandoned at its
   *  deadline must not write its late result. */
  let authRun = 0;
  /** When the latest auth test settled; command evidence never re-triggers a
   *  test more often than EVIDENCE_REVALIDATE_GAP. */
  let lastAuthTestEnd = 0;
  const EVIDENCE_REVALIDATE_GAP = 10_000;
  const identityReconcileKeys = new Set<string>();
  type VersionProbePhase = 'anonymous' | 'authenticated' | 'done';

  interface VersionProbeState {
    generation: number;
    client: BmpClient;
    phase: VersionProbePhase;
    inFlight: Promise<void> | null;
    jwt?: string;
    retryAfter: number;
  }

  let versionProbe: VersionProbeState | null = null;
  const VERSION_PROBE_RETRY_DELAY = 30_000;


  /**
   * Discover optional capability metadata without holding connection readiness
   * open. Health and command probes are authoritative; `/buildNum` only refines
   * feature flags. One generation-owned record coalesces the parallel health and
   * auth paths, remembers a JWT that arrives mid-probe, and retries only
   * transient failures. Endpoint absence leaves capability detection to the
   * client's EC probe; an anonymous authorization response can retry with JWT.
   */
  function ensureVersionDetection(
    bmpUrl: string,
    client: BmpClient,
    generationAtStart: number,
    jwt?: string,
  ): void {
    const ctx = getCtx();
    if (connectionGeneration !== generationAtStart || ctx.client !== client) return;
    if (healthVersion) {
      applyVersionFlags(healthVersion);
      return;
    }

    if (!versionProbe
      || versionProbe.generation !== generationAtStart
      || versionProbe.client !== client) {
      versionProbe = {
        generation: generationAtStart,
        client,
        phase: 'anonymous',
        inFlight: null,
        retryAfter: 0,
      };
    }
    const probe = versionProbe;
    if (jwt) {
      probe.jwt = jwt;
      if (!probe.inFlight && probe.phase === 'anonymous') probe.phase = 'authenticated';
    }
    if (probe.phase === 'done' || probe.inFlight || Date.now() < probe.retryAfter) return;
    if (probe.phase === 'authenticated' && !probe.jwt) return;

    const attempt = probe.phase;
    const attemptJwt = attempt === 'authenticated' ? probe.jwt : undefined;

    const task = (async () => {
      try {
        const result = await BmpClient.getBuildNumber(bmpUrl, attemptJwt);
        if (versionProbe !== probe
          || connectionGeneration !== generationAtStart
          || getCtx().client !== client) return;

        if (result.status === 'known') {
          probe.phase = 'done';
          healthVersion = result.version;
          applyVersionFlags(result.version);
        } else if (result.status === 'transient') {
          probe.retryAfter = Date.now() + VERSION_PROBE_RETRY_DELAY;
          log.info('connection:versionProbe', 'Version detection failed transiently — retrying later');
        } else if (result.status === 'auth-required' && attempt === 'anonymous') {
          probe.phase = 'authenticated';
        } else {
          probe.phase = 'done';
          applyVersionFlags(null, '/buildNum not available');
        }
        pushConnectionState();
      } catch (e) {
        if (versionProbe === probe
          && connectionGeneration === generationAtStart
          && getCtx().client === client) {
          probe.retryAfter = Date.now() + VERSION_PROBE_RETRY_DELAY;
        }
        log.swallow('connection:versionProbe', e);
      } finally {
        if (versionProbe === probe) {
          probe.inFlight = null;
          if (connectionGeneration === generationAtStart
            && getCtx().client === client
            && probe.jwt
            && probe.phase === 'authenticated'
            && Date.now() >= probe.retryAfter) {
            ensureVersionDetection(bmpUrl, client, generationAtStart, probe.jwt);
          }
        }
      }
    })();
    probe.inFlight = task;
  }

  /** Move the connection into the existing repairable access state after a
   * feature-level HTTP guard detects a revoked or stale grant. */
  function markHostAccessRequired(): void {
    needsAccess = true;
    authResult = 'pending';
    commandResult = 'unknown';
    commandError = null;
    validation = 'idle';
    verifiedAt = Date.now();
    pushConnectionState();
  }

  /** Browser logout affects the portal actor even when commands use an
   * independent stored ticket. It must not tear that command ticket down. */
  function markPortalSignedOut(): void {
    identities = withSameUser({
      portal: {
        status: 'unavailable',
        user: null,
        source: 'portal-session',
        error: 'No active BMP portal login.',
      },
      command: identities.command,
    });
    setCurrentIdentities(identities, getCtx().profileId);
    pushConnectionState();
  }

  /** Missing version metadata must not overwrite an actual capability result. */
  function applyVersionFlags(version: string | null, reason?: string) {
    const ctx = getCtx();
    if (!ctx.client) return;
    if (!version) {
      log.info('connection:versionFlags', reason
        ? `Version detection: ${reason} — EC capability probe required`
        : 'Version detection failed — EC capability probe required');
      return;
    }
    ctx.client.applyVersionFlags(version);
  }


  function resetConnectionState() {
    connectionGeneration++;
    healthUp = 'unknown';
    healthDetail = null;
    healthVersion = null;
    healthResponseMs = null;
    validationTimedOut = false;
    authRun++;
    authResult = 'pending';
    authError = null;
    authErrorCode = null;
    const profile = getCtx().settings.profiles.find(p => p.id === getCtx().settings.activeProfileId);
    identities = unknownIdentityMap(profile?.commandAuthMode ?? 'portal');
    setCurrentIdentities(identities, getCtx().profileId);
    commandResult = 'unknown';
    commandError = null;
    needsAccess = false;
    lastPollTime = 0;
    validation = 'idle';
    verifiedAt = null;
    semanticRevision = 0;
    lastSemanticUpdate = 0;
    lastSemanticKey = null;
    lastSnapshotSignature = null;
    nextIncidentEpoch = 0;
    activeIncidentEpoch = 0;
    recoveryEpoch = 0;
    identityMismatch = false;
    identityReconcileKeys.clear();
    versionProbe = null;
    // Reset version flags — will be re-evaluated when version is detected
    const ctx = getCtx();
    if (ctx.client) {
      ctx.client.resetCapabilities();
    }
  }

  function computeConnectionState(): ConnectionState {
    const ctx = getCtx();
    const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
    // A URL alone configures a profile now — `session` profiles have no username.
    if (!profile?.bmpUrl) {
      return { display: 'not-configured', identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null, workspace: null, authError: null, detail: null, networkOffline: false, lastUpdate: lastSemanticUpdate, validation, verifiedAt, semanticRevision, incidentEpoch: activeIncidentEpoch, recoveryEpoch, environment: environmentToken(ctx) };
    }

    let display: ConnectionState['display'];
    let detail: string | null = null;
    if (needsAccess) display = 'needs-access';
    else if (needsPasswordEntry(profile)) display = 'needs-password';
    else if (healthUp === 'unreachable') { display = 'unreachable'; detail = healthDetail; }
    else if (healthUp === 'down') { display = 'server-down'; detail = healthDetail; }
    else if (healthUp === 'not-workspace') { display = 'not-workspace'; detail = healthDetail; }
    else if (identityMismatch) display = 'identity-mismatch';
    else if (validationTimedOut) display = 'command-failed';
    else if (authResult === 'ok' && commandResult === 'ok') display = 'connected';
    else if (authResult === 'ok' && commandResult === 'probing') display = 'reconnecting';
    else if (authResult === 'ok' && commandResult === 'failed') display = 'command-failed';
    else if (authResult === 'failed') {
      if (authErrorCode === 'needs-login') display = 'needs-login';
      else if (authErrorCode === 'no-config-access') display = 'no-config-access';
      else if (authErrorCode === 'transport') display = healthUp === 'up' ? 'command-failed' : 'unreachable';
      else display = 'auth-failed';
    }
    else if (healthUp === 'up') display = 'online';
    else display = 'checking';

    let workspace: string | null = null;
    if (profile?.bmpUrl) {
      try {
        const pathname = new URL(normalizeUrl(profile.bmpUrl)).pathname.replace(/\/+$/, '');
        if (pathname && pathname !== '/') {
          const lastSlash = pathname.lastIndexOf('/');
          workspace = pathname.substring(lastSlash + 1) || null;
        }
      } catch (e) { log.warn('connection:parseUrl', e, 'invalid BMP URL — workspace extraction skipped'); }
    }

    const authDetail = authResult === 'failed' ? authError : (commandResult === 'failed' || validationTimedOut) ? commandError : null;
    return {
      display,
      version: healthVersion || null,
      blueprintSupported: ctx.client?.supportsLookup !== false,
      responseMs: healthResponseMs,
      profileLabel: profile.label,
      identities,
      workspace,
      authError: authDetail,
      detail: detail ?? authDetail,
      networkOffline,
      lastUpdate: lastSemanticUpdate,
      validation,
      verifiedAt,
      semanticRevision,
      incidentEpoch: activeIncidentEpoch,
      recoveryEpoch,
      environment: environmentToken(ctx),
    };
  }

  /** Connection events are user-visible activity, not diagnostics. */
  const CONNECTION_META = { category: 'connection', action: 'connection' } as const;

  /** "Connected to DEV as admin" for the Log. */
  function connectedSentence(label: string, state: ConnectionState): string {
    const actor = state.identities?.command;
    const user = actor?.status === 'connected' ? actor.user : null;
    return `Connected to ${label}${user ? ` as ${user}` : ''}`;
  }

  /** A stored-login profile whose saved password could not be decrypted. */
  function needsPasswordEntry(profile: ServerProfile): boolean {
    return (profile.commandAuthMode ?? 'portal') === 'stored' && !!profile.passwordUnreadable && !profile.bmpPass;
  }

  function isConfirmedIncident(display: ConnectionState['display']): boolean {
    return !['not-configured', 'checking', 'reconnecting', 'connected', 'online'].includes(display);
  }

  /** Bind command outcomes from the active pooled client to connection state.
   *  The profile/client identity check prevents a late result from an inactive
   *  warm client from changing the current profile's status. */
  function bindConnectionClient(client: BmpClient, profileId: string): void {
    client.setTransportOutcomeObserver((outcome: BmpTransportOutcome) => {
      const ctx = getCtx();
      if (ctx.client !== client || ctx.settings.activeProfileId !== profileId) return;
      // A failed request is a problem; a slow, large or retried one that still
      // answered is a diagnostic (see transport-activity.ts).
      const entry = transportActivity(outcome);
      if (entry) ctx.logActivity(entry.level, entry.message, entry.detail, entry.meta);
      if (outcome.ok) {
        // A command that completed is proof that the server is up and the
        // command channel works, whatever the last health probe said.
        const healed = markServerAnswered();
        commandResult = 'ok';
        commandError = null;
        validationTimedOut = false;
        verifiedAt = Date.now();
        pushConnectionState();
        // Identity and sign-in state are owned by the auth test. When they are
        // not confirmed yet, let the evidence drive one (bounded) validation.
        if ((healed || authResult !== 'ok') && !authTestInFlight
          && Date.now() - lastAuthTestEnd >= EVIDENCE_REVALIDATE_GAP) void runAuthTest('evidence-change');
        return;
      }
      if (outcome.error.kind === 'cancelled') return;
      // The restart check is an extra question of Companion's own: a server
      // that does not answer it is not a failed connection.
      if (outcome.feature === 'restart-check') return;
      // A permission response (and other non-5xx HTTP rejection) proves the
      // command channel is alive. It is an operation result, not a connection
      // failure, so a denied edit must not turn the global status red.
      if (outcome.error.kind === 'permission'
        || (outcome.error.kind === 'http' && (outcome.error.status ?? 0) < 500)) {
        if (markServerAnswered()) pushConnectionState();
        return;
      }
      commandResult = 'failed';
      commandError = outcome.error.message;
      verifiedAt = Date.now();
      pushConnectionState();
      // The overlay works without the side panel, so a failure is re-checked
      // whether or not a panel is open.
      if (!authTestInFlight && healthUp !== 'down' && healthUp !== 'unreachable') {
        void runAuthTest('evidence-change');
      }
    });
  }

  /** The server answered a real request: clear a stale reachability failure.
   *  Returns true when a failure was cleared. */
  function markServerAnswered(): boolean {
    if (healthUp === 'up') return false;
    const wasFailure = healthUp === 'down' || healthUp === 'unreachable' || healthUp === 'not-workspace';
    healthUp = 'up';
    healthDetail = null;
    networkOffline = false;
    return wasFailure;
  }

  function pushConnectionState(): { incidentStarted: boolean; recovered: boolean } {
    let state = computeConnectionState();
    let incidentStarted = false;
    let recovered = false;
    if (isConfirmedIncident(state.display) && activeIncidentEpoch === 0) {
      activeIncidentEpoch = ++nextIncidentEpoch;
      incidentStarted = true;
    } else if (state.display === 'connected' && activeIncidentEpoch > 0) {
      recoveryEpoch = activeIncidentEpoch;
      activeIncidentEpoch = 0;
      recovered = true;
      // A confirmed command recovery can invalidate cached enrichment. Routine
      // Port repair and connected revalidation never reach this branch.
      incrementGeneration();
      getCtx().broadcastToContent({ type: 'RE_ENRICH' });
    }
    state = computeConnectionState();
    const semanticKey = JSON.stringify({
      display: state.display,
      identities: state.identities,
      version: state.version,
      blueprintSupported: state.blueprintSupported,
      responseMs: state.responseMs,
      profileLabel: state.profileLabel,
      workspace: state.workspace,
      authError: state.authError,
      networkOffline: state.networkOffline,
      validation: state.validation,
      incidentEpoch: state.incidentEpoch,
      recoveryEpoch: state.recoveryEpoch,
      environment: state.environment,
    });
    if (semanticKey === lastSemanticKey) {
      persistConnectionSnapshot(state);
      return { incidentStarted, recovered };
    }
    lastSemanticKey = semanticKey;
    semanticRevision++;
    lastSemanticUpdate = Date.now();
    state = computeConnectionState();
    publishBadge(getCtx(), state.display);
    const ctx = getCtx();
    traceConnectionDiagnostic({
      source: 'worker-state',
      profileId: ctx.settings.activeProfileId,
      semanticRevision: state.semanticRevision,
      decision: `publish:${state.display}:incident=${state.incidentEpoch ?? 0}:recovery=${state.recoveryEpoch ?? 0}`,
    });
    ctx.sendToPanel({ type: 'CONNECTION_STATE', state });
    persistConnectionSnapshot(state);
    ctx.broadcastToContent({ type: 'CONNECTION_STATE', state });
    void syncRecovery(state.display, ctx.settings.activeProfileId).catch(e => log.swallow('conn:recovery', e));
    return { incidentStarted, recovered };
  }

  /** Persist newly verified evidence even when its user-visible semantics did
   * not change. Quiet command successes intentionally avoid a panel broadcast,
   * but their fresher timestamp still needs to survive a worker restart. */
  function persistConnectionSnapshot(state: ConnectionState): void {
    const ctx = getCtx();
    const snapshot = createConnectionSnapshot(state, ctx.settings);
    if (!snapshot) return;
    const signature = `${state.semanticRevision}:${state.verifiedAt}`;
    if (signature === lastSnapshotSignature) return;
    lastSnapshotSignature = signature;
    // The active slot serves panel boot; the per-profile map keeps each
    // profile's last evidence so switching back does not start from Checking.
    snapshotsByProfile[snapshot.profileId] = snapshot;
    chrome.storage.session.set({ crev_conn_snapshot: snapshot, crev_conn_snapshot_by_profile: { ...snapshotsByProfile } }).catch(e => {
      if (lastSnapshotSignature === signature) lastSnapshotSignature = null;
      log.swallow('conn:snapshot', e);
    });
  }



  function runAuthTest(reason: ConnectionValidationReason = 'explicit'): Promise<void> {
    const generationAtStart = connectionGeneration;
    if (authTestInFlight && authTestGeneration === generationAtStart) {
      if (reason === 'explicit' && authTestReason !== 'explicit') {
        // Reconnect must clear a paused login even if a background check already
        // owns the slot. Coalesce clicks into one explicit follow-up validation.
        return authTestInFlight.then(() => {
          if (connectionGeneration === generationAtStart) return runAuthTest('explicit');
        });
      }
      return authTestInFlight;
    }
    const clientAtStart = getCtx().client;
    const run = ++authRun;
    const task = withValidationDeadline(
      runAuthTestInternal(generationAtStart, clientAtStart, reason, run),
      () => abandonAuthTest(generationAtStart, clientAtStart, run, reason),
    );
    authTestInFlight = task;
    authTestGeneration = generationAtStart;
    authTestReason = reason;
    const clear = () => {
      lastAuthTestEnd = Date.now();
      if (authTestInFlight === task) authTestInFlight = null;
    };
    void task.then(clear, clear);
    return task;
  }

  /** Resolve when the validation settles or its overall deadline passes,
   *  whichever is first. On the deadline `onTimeout` publishes the verdict. */
  function withValidationDeadline(task: Promise<void>, onTimeout: () => void): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => { onTimeout(); resolve(); }, timing.validationDeadlineMs);
    });
    return Promise.race([task.finally(() => clearTimeout(timer)), deadline]);
  }

  /** The auth test did not settle in time. Stop it from writing later, and say
   *  so instead of leaving the panel on Checking. */
  function abandonAuthTest(
    generationAtStart: number,
    clientAtStart: BmpClient | null,
    run: number,
    reason: ConnectionValidationReason,
  ): void {
    if (authRun !== run || connectionGeneration !== generationAtStart || getCtx().client !== clientAtStart) return;
    authRun++;
    validationTimedOut = true;
    commandError = `BMP did not complete the connection check within ${Math.round(timing.validationDeadlineMs / 1000)} seconds.`;
    validation = 'idle';
    verifiedAt = Date.now();
    const transition = pushConnectionState();
    if (reason === 'explicit') getCtx().logActivity('warn', 'Connection check failed', commandError, CONNECTION_META);
    else if (transition.incidentStarted) getCtx().logActivity('warn', 'Lost the connection to the server', commandError, CONNECTION_META);
  }

  async function runAuthTestInternal(
    generationAtStart: number,
    clientAtStart: BmpClient | null,
    reason: ConnectionValidationReason,
    run: number,
  ): Promise<void> {
    const ctx = getCtx();
    // Superseded by a newer generation/client, or abandoned at the deadline.
    const stale = (): boolean => connectionGeneration !== generationAtStart || ctx.client !== clientAtStart || authRun !== run;
    const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
    if (!profile?.bmpUrl) {
      authResult = 'pending';
      authError = null;
      authErrorCode = null;
      commandResult = 'unknown';
      commandError = null;
      pushConnectionState();
      return;
    }

    if (needsPasswordEntry(profile)) {
      // Never sign in with an empty or unreadable password; the state already
      // tells the user to enter it again.
      authResult = 'pending';
      commandResult = 'unknown';
      validation = 'idle';
      verifiedAt = Date.now();
      pushConnectionState();
      return;
    }

    const bmpUrl = normalizeUrl(profile.bmpUrl);
    if (!(await hasHostAccess(bmpUrl))) {
      if (stale()) return;
      markHostAccessRequired(); // no grant → command/identity probes would CORS-fail
      return;
    }
    if (stale()) return;
    needsAccess = false;
    if (!clientAtStart || ctx.client !== clientAtStart) {
      authResult = 'failed';
      authError = 'Connection client is not ready';
      authErrorCode = null;
      commandResult = 'unknown';
      validation = 'idle';
      verifiedAt = Date.now();
      pushConnectionState();
      return;
    }

    const retainConfirmed = authResult === 'ok' && commandResult === 'ok';
    validation = 'validating';
    if (!retainConfirmed) {
      authResult = 'pending';
      authError = null;
      authErrorCode = null;
      commandResult = 'probing';
      commandError = null;
    }
    pushConnectionState();
    if (reason === 'explicit') ctx.logActivity('info', 'Checking the connection\u2026', undefined, { category: 'system', action: 'connection-check' });
    const hadIncident = activeIncidentEpoch > 0;
    try {
      if (reason === 'explicit') await clientAtStart.retryAuthentication();
      // A fresh worker starts with an unbound in-memory actor. Restore the
      // workspace-scoped envelope before deciding whether that actor changed.
      if (profile.commandAuthMode === 'portal') await clientAtStart.auth.restoreFromSession();
      if (stale()) return;
      // Resolve the browser actor before validating the command channel. When a
      // borrowed chain is unbound (legacy state) or belongs to another actor,
      // discard it first so this validation performs exactly one command login.
      let portalActor = await probePortalIdentity(bmpUrl);
      if (stale()) return;
      let reconcileKey: string | null = null;
      if (profile.commandAuthMode === 'portal' && portalActor.status === 'connected' && portalActor.user
        && clientAtStart.portalActor !== portalActor.user) {
        const previousActor = clientAtStart.portalActor ?? 'unbound';
        const candidateKey = `${generationAtStart}|${profile.id}|${previousActor}|${portalActor.user}`;
        if (reason === 'explicit' || !identityReconcileKeys.has(candidateKey)) {
          identityReconcileKeys.add(candidateKey);
          reconcileKey = candidateKey;
          clientAtStart.logout();
        }
      }

      let result: ConnectionResult;
      if (profile.commandAuthMode === 'portal' && portalActor.status === 'unavailable') {
        const signoutKey = `${profile.id}|signed-out`;
        if (!identityReconcileKeys.has(signoutKey)) {
          identityReconcileKeys.add(signoutKey);
          clientAtStart.logout();
        }
        result = {
          ok: false,
          authenticated: false,
          code: 'needs-login',
          message: portalActor.error ?? 'No active BMP portal login.',
        };
      } else {
        if (portalActor.status === 'connected') identityReconcileKeys.delete(`${profile.id}|signed-out`);
        result = await clientAtStart.testConnection({ background: reason !== 'explicit' });
        if (stale()) return;
        // One dropped request must not turn the status red: retry a network or
        // command-probe failure once. Definite answers (rejected login, missing
        // role, no portal session) are not retried.
        if (!result.ok && (!result.code || result.code === 'transport')) {
          await sleep(timing.retryDelayMs);
          if (stale()) return;
          result = await clientAtStart.testConnection({ background: reason !== 'explicit' });
          if (stale()) return;
        }
      }

      // Re-probe after minting before binding. This prevents a browser actor
      // switch during the login operation from attaching stale evidence.
      if (reconcileKey && result.authenticated) {
        const actorBeforeLogin = portalActor.status === 'connected' ? portalActor.user : null;
        portalActor = await probePortalIdentity(bmpUrl);
        if (stale()) return;
        if (actorBeforeLogin && portalActor.status === 'connected' && portalActor.user === actorBeforeLogin) {
          clientAtStart.bindPortalActor(portalActor.user);
          // Suppress only an unresolved reconciliation. A completed A -> B
          // transition must not prevent a later A -> B after switching back.
          if (clientAtStart.portalActor === portalActor.user) identityReconcileKeys.delete(reconcileKey);
        } else {
          identityReconcileKeys.delete(reconcileKey);
          // The command chain was minted while the browser actor changed (or
          // became unverifiable). It is not evidence for the actor visible now.
          // Retire it immediately and require a later bounded validation rather
          // than publishing Connected with sameUser=null.
          clientAtStart.logout();
          result = {
            ok: false,
            authenticated: false,
            code: 'auth-failed',
            message: 'The BMP portal user changed during authentication. Retry the connection.',
          };
        }
      } else if (reconcileKey) {
        identityReconcileKeys.delete(reconcileKey);
      }
      const commandSource = profile.commandAuthMode === 'stored' ? 'stored-login' : 'portal-session';
      const mapIdentity = () => {
        const commandUser = clientAtStart.commandUser
          ?? (profile.commandAuthMode !== 'stored' && portalActor.status === 'connected' ? portalActor.user : null);
        const mapped = withSameUser({
          portal: portalActor,
          command: result.authenticated && commandUser
            ? { status: 'connected' as const, user: commandUser, source: commandSource }
            : {
                status: result.authenticated ? 'failed' as const : 'unavailable' as const,
                user: null,
                source: commandSource,
                error: result.ok ? undefined : result.message,
              },
        });
        // The portal endpoint reports an actor RID while LoginTicket reports a
        // principal name (for example RID 366… versus "admin"). In borrowed
        // portal mode, compare the portal actor to the actor bound when the
        // command chain was minted; raw string equality is not meaningful.
        if (profile.commandAuthMode === 'portal') {
          const boundActor = clientAtStart.portalActor;
          return {
            ...mapped,
            sameUser: portalActor.status === 'connected' && result.authenticated && boundActor
              ? boundActor === portalActor.user
              : null,
          };
        }
        return mapped;
      };
      identities = mapIdentity();
      identityMismatch = profile.commandAuthMode === 'portal' && identities.sameUser === false;
      setCurrentIdentities(identities, getCtx().profileId);
      authResult = result.authenticated ? 'ok' : 'failed';
      authError = result.ok ? null : result.message;
      // `transport`: the sign-in request got no answer, which is reported as a
      // reachability problem rather than "Sign-in failed".
      authErrorCode = result.authenticated ? null : (result.code ?? null);
      validationTimedOut = false;
      commandResult = result.ok ? 'ok' : result.authenticated ? 'failed' : 'unknown';
      commandError = result.ok ? null : result.authenticated ? result.message : null;
      // Command readiness and actor identity are definitive now. Optional
      // version discovery must not keep the editor or panel on Checking.
      if (result.ok) ensureVersionDetection(
        bmpUrl,
        clientAtStart,
        generationAtStart,
        clientAtStart.jwt ?? undefined,
      );
    } catch (e) {
      if (stale()) return;
      if (e instanceof HostAccessError) {
        markHostAccessRequired();
        return;
      }
      authResult = 'failed';
      authError = errorMessage(e);
      authErrorCode = e instanceof TypeError ? 'transport' : null;
      identities = withSameUser({
        portal: identities.portal,
        command: {
          status: 'failed',
          user: null,
          source: profile.commandAuthMode === 'stored' ? 'stored-login' : 'portal-session',
          error: errorMessage(e),
        },
      });
      setCurrentIdentities(identities, getCtx().profileId);
      commandResult = 'unknown';
      commandError = null;
    }
    validation = 'idle';
    verifiedAt = Date.now();
    const transition = pushConnectionState();
    if (reason === 'explicit') {
      const state = computeConnectionState();
      ctx.logActivity(state.display === 'connected' ? 'success' : 'warn',
        state.display === 'connected' ? connectedSentence(profile.label, state) : 'Connection check failed',
        state.authError ?? undefined, CONNECTION_META);
    }
    if (hadIncident && transition.recovered) {
      ctx.logActivity('success', `Connected to ${profile.label} again`, undefined, CONNECTION_META);
    } else if (transition.incidentStarted && reason !== 'explicit') {
      ctx.logActivity('warn', 'Lost the connection to the server', computeConnectionState().authError ?? undefined, CONNECTION_META);
    }
  }

  function pollHealth(force = false): Promise<void> {
    const generationAtStart = connectionGeneration;
    if (healthPollInFlight && healthPollGeneration === generationAtStart) return healthPollInFlight;
    // Skip if recently polled (prevents double-polls from online event + timer)
    const now = Date.now();
    if (!force && now - lastPollTime < CONNECTION_FRESHNESS_TARGET * 0.8) return Promise.resolve();
    lastPollTime = now;
    const clientAtStart = getCtx().client;
    const task = pollHealthInternal(generationAtStart, clientAtStart);
    healthPollInFlight = task;
    healthPollGeneration = generationAtStart;
    const clear = () => {
      if (healthPollInFlight === task) healthPollInFlight = null;
    };
    void task.then(clear, clear);
    return task;
  }

  async function pollHealthInternal(generationAtStart: number, clientAtStart: BmpClient | null): Promise<void> {
    const ctx = getCtx();
    const stale = () => connectionGeneration !== generationAtStart || ctx.client !== clientAtStart;
    const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
    if (!profile?.bmpUrl) {
      healthUp = 'unknown';
      healthDetail = null;
      healthVersion = null;
      healthResponseMs = null;
      pushConnectionState();
      return;
    }

    // Check browser network state before attempting fetch
    if (!navigator.onLine) {
      healthUp = 'unreachable';
      healthDetail = 'The browser reports that this computer is offline.';
      healthResponseMs = null;
      networkOffline = true;
      pushConnectionState();
      return;
    }
    networkOffline = false;

    const bmpUrl = normalizeUrl(profile.bmpUrl);
    if (!(await hasHostAccess(bmpUrl))) {
      if (stale()) return;
      needsAccess = true; // no host permission → the fetch would CORS-fail; don't even try
      healthUp = 'unknown';
      healthResponseMs = null;
      pushConnectionState();
      return;
    }
    if (stale()) return;
    needsAccess = false;
    const wasFailing = healthUp === 'down' || healthUp === 'unreachable' || healthUp === 'not-workspace';
    try {
      let result = await BmpClient.checkHealth(bmpUrl);
      if (stale()) return;
      // A single failed probe is not evidence of an outage: retry once.
      if (!result.up && !result.notWorkspace) {
        await sleep(timing.retryDelayMs);
        if (stale()) return;
        result = await BmpClient.checkHealth(bmpUrl);
        if (stale()) return;
      }
      if (result.up) {
        // Reachability is useful evidence on its own. Publish Online immediately
        // instead of holding the UI on Checking while the optional build-number
        // endpoint spends up to another health timeout responding.
        healthUp = 'up';
        healthDetail = null;
        healthResponseMs = result.responseMs;
        pushConnectionState();
        if (clientAtStart) ensureVersionDetection(
          bmpUrl,
          clientAtStart,
          generationAtStart,
          clientAtStart.jwt ?? undefined,
        );
        // The server is back. A sign-in that failed while it was away (or never
        // ran) must be redone now, or the state would stay red after recovery.
        // Only when the earlier failure can be explained by the outage; a
        // definite answer (rejected login, no role) is not repeated.
        if (wasFailing || authErrorCode === 'transport' || validationTimedOut) void runAuthTest('evidence-change');
        return;
      } else if (result.notWorkspace) {
        healthUp = 'not-workspace';
        healthDetail = result.detail ?? null;
        healthResponseMs = result.responseMs;
      } else if (result.reachable) {
        healthUp = 'down';
        healthDetail = result.detail ?? null;
        healthResponseMs = result.responseMs;
      } else {
        healthUp = 'unreachable';
        healthDetail = result.detail ?? null;
        healthResponseMs = null;
      }
    } catch (e) {
      if (stale()) return;
      if (e instanceof HostAccessError) {
        markHostAccessRequired();
        return;
      }
      log.swallow('connection:pollHealth', e);
      healthUp = 'unreachable';
      healthDetail = errorMessage(e);
      healthResponseMs = null;
    }
    pushConnectionState();
  }

  /** Login evidence: a new BMP session cookie or a BMP page load for the active
   *  server. When the state says the user must sign in (or signed in as someone
   *  else), revalidate so a fresh login reconnects without a click. */
  const LOGIN_RECOVERABLE = new Set<ConnectionState['display']>(['needs-login', 'identity-mismatch', 'online', 'auth-failed']);
  let lastLoginEvidence = 0;
  let loginEvidenceQueued = false;
  function noteLoginEvidence(): void {
    const ctx = getCtx();
    const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
    // A stored login does not depend on the browser session.
    if (!profile?.bmpUrl || (profile.commandAuthMode ?? 'portal') !== 'portal') return;
    if (!LOGIN_RECOVERABLE.has(computeConnectionState().display)) return;
    if (authTestInFlight) {
      // The running test may have read the old session. Check once more after it.
      if (loginEvidenceQueued) return;
      loginEvidenceQueued = true;
      void authTestInFlight.finally(() => setTimeout(() => {
        loginEvidenceQueued = false;
        noteLoginEvidence();
      }, 0));
      return;
    }
    const now = Date.now();
    if (now - lastLoginEvidence < timing.loginEvidenceGapMs) return;
    lastLoginEvidence = now;
    void runAuthTest('evidence-change');
  }

  /** One alarm-driven recovery check (see connection-recovery.ts). Reachability
   *  first; the command check runs only when it can change the verdict. */
  async function runRecoveryCheck(): Promise<void> {
    const ctx = getCtx();
    await ctx.settingsReady;
    const profileId = ctx.settings.activeProfileId;
    const record = await recoveryRecord();
    if (!record || record.profileId !== profileId) {
      await clearRecovery();
      return;
    }
    if (computeConnectionState().display === 'command-failed') {
      await runAuthTest('background');
    } else {
      await pollHealth(true);
    }
    // pollHealth may have started a sign-in check; the verdict includes it.
    if (authTestInFlight) await authTestInFlight;
    await afterRecoveryCheck(computeConnectionState().display, profileId);
  }

  /** Start the panel-owned connection monitor without disturbing a monitor or
   *  verified command channel that is already live. A newly opened second panel
   *  and a replacement panel both use the existing state; only the first panel
   *  after an idle/no-panel period needs to resume monitoring. */
  function ensureConnectionMonitoring() {
    if (validation !== 'validating'
      && verifiedAt && Date.now() - verifiedAt < CONNECTION_FRESHNESS_TARGET) {
      pushConnectionState();
      return;
    }
    void validateConnection('background');
  }

  /** Coalesced event-driven validation. Reachability stays pure and identity is
   * reconciled only in the explicit auth operation. */
  async function validateConnection(reason: ConnectionValidationReason = 'background'): Promise<void> {
    await Promise.all([pollHealth(true), runAuthTest(reason)]);
  }

  /** Restore scope-matching confirmed evidence before the first publication of
   * a rebuilt worker/client. The next attach validates it quietly. */
  async function restoreConnectionEvidence(): Promise<void> {
    const ctx = getCtx();
    const raw = await chrome.storage.session.get(['crev_conn_snapshot', 'crev_conn_snapshot_by_profile'])
      .catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
    const byProfile = raw.crev_conn_snapshot_by_profile;
    if (byProfile && typeof byProfile === 'object') {
      snapshotsByProfile = { ...(byProfile as typeof snapshotsByProfile), ...snapshotsByProfile };
    }
    const state = provisionalConnectionSnapshot(snapshotsByProfile[ctx.settings.activeProfileId], ctx.settings)
      ?? provisionalConnectionSnapshot(raw.crev_conn_snapshot, ctx.settings);
    if (!state) return;
    identities = state.identities;
    setCurrentIdentities(identities, getCtx().profileId);
    healthVersion = state.version;
    if (healthVersion) applyVersionFlags(healthVersion);
    healthResponseMs = state.responseMs;
    networkOffline = state.networkOffline;
    needsAccess = state.display === 'needs-access';
    healthUp = state.display === 'server-down' ? 'down'
      : state.display === 'unreachable' ? 'unreachable'
        : state.display === 'not-workspace' ? 'not-workspace'
        : state.display === 'connected' || state.display === 'online' || state.display === 'identity-mismatch' ? 'up' : 'unknown';
    authResult = ['connected', 'command-failed', 'identity-mismatch'].includes(state.display) ? 'ok'
      : ['auth-failed', 'needs-login', 'no-config-access'].includes(state.display) ? 'failed' : 'pending';
    authErrorCode = state.display === 'needs-login' ? 'needs-login'
      : state.display === 'no-config-access' ? 'no-config-access' : null;
    commandResult = state.display === 'connected' || state.display === 'identity-mismatch' ? 'ok'
      : state.display === 'command-failed' ? 'failed' : 'unknown';
    authError = state.authError;
    healthDetail = ['server-down', 'unreachable', 'not-workspace'].includes(state.display) ? state.detail ?? null : null;
    commandError = state.display === 'command-failed' || state.display === 'identity-mismatch' ? state.authError : null;
    identityMismatch = state.display === 'identity-mismatch';
    validation = 'validating';
    verifiedAt = state.verifiedAt ?? null;
    semanticRevision = state.semanticRevision ?? 0;
    lastSemanticUpdate = state.lastUpdate;
    nextIncidentEpoch = Math.max(state.incidentEpoch ?? 0, state.recoveryEpoch ?? 0);
    activeIncidentEpoch = state.incidentEpoch ?? 0;
    recoveryEpoch = state.recoveryEpoch ?? 0;
    lastSemanticKey = null;
    lastSnapshotSignature = `${state.semanticRevision}:${state.verifiedAt}`;
  }


  /** Granting host access (site-access strip or Chrome's site settings): clear
   *  the gate and re-probe at once so a 'needs-access' connection flips to
   *  connected without waiting for the next poll. */
  function onHostAccessGranted(): void {
    needsAccess = false;
    lastPollTime = 0; // bypass the poll throttle
    void validateConnection('evidence-change');
  }

  function onHostAccessRevoked(): void {
    lastPollTime = 0;
    markHostAccessRequired();
  }

  return {
    requestReachabilityEvidence,
    markHostAccessRequired,
    markPortalSignedOut,
    resetConnectionState,
    computeConnectionState,
    bindConnectionClient,
    pushConnectionState,
    runAuthTest,
    pollHealth,
    noteLoginEvidence,
    runRecoveryCheck,
    ensureConnectionMonitoring,
    validateConnection,
    restoreConnectionEvidence,
    onHostAccessGranted,
    onHostAccessRevoked,
    authTestRunning: () => authTestInFlight,
  };
}

type Connection = ReturnType<typeof createConnection>;

/** Monitors of profile-bound contexts, by profile id. */
const monitors = new Map<string, { ctx: SwContext; conn: Connection }>();
/** The monitor of an unbound context: unit tests that install one mock
 *  context. The worker always passes a profile-bound context. */
let unbound: Connection | null = null;

function connectionFor(ctx?: SwContext): Connection {
  if (ctx?.profileId) {
    let entry = monitors.get(ctx.profileId);
    if (!entry || entry.ctx !== ctx) {
      const bound = ctx;
      entry = { ctx: bound, conn: createConnection(() => bound) };
      monitors.set(ctx.profileId, entry);
    }
    return entry.conn;
  }
  return unbound ??= createConnection(() => baseCtx());
}

/** Forget a profile's monitor (the profile was deleted). */
export function disposeConnection(profileId: string): void {
  monitors.delete(profileId);
}

/** Decides whether a profile's state drives the toolbar badge (the profile
 *  shown in the focused window). Installed by the worker; tests leave it on. */
let badgeOwner: (profileId: string | undefined) => boolean = () => true;
export function setBadgeOwner(fn: (profileId: string | undefined) => boolean): void { badgeOwner = fn; }
function publishBadge(ctx: SwContext, display: ConnectionState['display']): void {
  if (badgeOwner(ctx.profileId)) updateBadge(display);
}

export const requestReachabilityEvidence = (ctx?: SwContext): void => connectionFor(ctx).requestReachabilityEvidence();
export const markHostAccessRequired = (ctx?: SwContext): void => connectionFor(ctx).markHostAccessRequired();
export const markPortalSignedOut = (ctx?: SwContext): void => connectionFor(ctx).markPortalSignedOut();
export const resetConnectionState = (ctx?: SwContext): void => connectionFor(ctx).resetConnectionState();
export const computeConnectionState = (ctx?: SwContext): ConnectionState => connectionFor(ctx).computeConnectionState();
export const bindConnectionClient = (client: BmpClient, profileId: string, ctx?: SwContext): void => connectionFor(ctx).bindConnectionClient(client, profileId);
export const pushConnectionState = (ctx?: SwContext): { incidentStarted: boolean; recovered: boolean } => connectionFor(ctx).pushConnectionState();
export const runAuthTest = (reason: ConnectionValidationReason = 'explicit', ctx?: SwContext): Promise<void> => connectionFor(ctx).runAuthTest(reason);
export const pollHealth = (force = false, ctx?: SwContext): Promise<void> => connectionFor(ctx).pollHealth(force);
export const noteLoginEvidence = (ctx?: SwContext): void => connectionFor(ctx).noteLoginEvidence();
export const ensureConnectionMonitoring = (ctx?: SwContext): void => connectionFor(ctx).ensureConnectionMonitoring();
export const validateConnection = (reason: ConnectionValidationReason = 'background', ctx?: SwContext): Promise<void> => connectionFor(ctx).validateConnection(reason);
export const restoreConnectionEvidence = (ctx?: SwContext): Promise<void> => connectionFor(ctx).restoreConnectionEvidence();

/** One alarm-driven recovery check, for the profile the schedule belongs to. */
export async function runRecoveryCheck(ctx?: SwContext): Promise<void> {
  if (ctx) return connectionFor(ctx).runRecoveryCheck();
  const record = await recoveryRecord();
  const base = baseCtx();
  const bound = record?.profileId && base.scopeFor ? base.scopeFor(record.profileId) : null;
  return connectionFor(bound ?? undefined).runRecoveryCheck();
}

/** Every monitor (or the unbound one in tests). */
function everyConnection(): Connection[] {
  const list = [...monitors.values()].map(entry => entry.conn);
  return list.length ? list : [connectionFor()];
}

// Register connection display accessor for enrichment module (breaks circular dependency)
registerConnectionDisplayFn((ctx) => computeConnectionState(ctx).display);
registerReachabilityRequestFn((ctx) => requestReachabilityEvidence(ctx));

if (typeof chrome !== 'undefined' && chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    for (const conn of everyConnection()) conn.onHostAccessGranted();
  });
}

if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => {
    for (const conn of everyConnection()) conn.onHostAccessRevoked();
  });
}

/** The state of a surface that belongs to no stored profile (a page Companion
 *  is not set up for, or no profile at all). */
export function notConfiguredConnectionState(): ConnectionState {
  return {
    display: 'not-configured', identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null,
    workspace: null, authError: null, detail: null, networkOffline: false, lastUpdate: 0, validation: 'idle',
    verifiedAt: null, semanticRevision: 0, incidentEpoch: 0, recoveryEpoch: 0, environment: '',
  };
}
