/**
 * Access mode of the object window (src/objectview/window/access-*.ts).
 *
 * ACCESS_MODE_STATUS   — cached availability, no BMP request.
 * ACCESS_MODE_PREPARE  — subjects (once per environment and session; kept
 *                        here and in session storage so a reopened window
 *                        does not refetch) plus the availability probe.
 * ACCESS_MODE_DECIDE   — verdicts for up to 50 nodes × 4 actions.
 * ACCESS_MODE_TRACE    — the full trace for one node and action.
 *
 * Every request names its environment; the check runs before and after the
 * BMP call, as the Access workspace's `traceAccess` does, so an answer from
 * a switched connection is never returned as current.
 */
import { register } from '../handler-registry';
import { ctxOf, type SwContext } from '../sw-context';
import { errorMessage } from '../logger';
import { environmentToken } from '../environment';
import { AccessModeService } from '../access-mode-service';
import { UNAVAILABLE_REASON } from '../access-mode';
import type { AccessSubject } from '../types';

const service = new AccessModeService();
const SUBJECTS_KEY = 'crev_access_mode_subjects';
const CHANGED = 'The BMP connection changed. Reopen the object to test access on the current connection.';

function bind(environment: string, ctx: SwContext) {
  const client = ctx.client;
  const assertEnvironment = () => {
    if (!client || !environment || environmentToken(ctx) !== environment || ctx.client !== client) throw new Error(CHANGED);
  };
  return { ctx, client, assertEnvironment };
}

async function seedFromSession(environment: string): Promise<void> {
  if (service.cachedSubjects(environment)) return;
  try {
    const stored = (await chrome.storage.session.get(SUBJECTS_KEY))[SUBJECTS_KEY] as { environment?: string; subjects?: AccessSubject[] } | undefined;
    if (stored?.environment === environment && Array.isArray(stored.subjects)) service.seedSubjects(environment, stored.subjects);
  } catch { /* session storage unavailable: load again */ }
}

register('ACCESS_MODE_STATUS', (msg, respond, meta) => {
  const a = service.status(msg.environment);
  respond({ type: 'ACCESS_MODE_READY', environment: msg.environment, ok: true, ...(a ? { available: a.available, ...(a.reason ? { reason: a.reason } : {}) } : {}) });
});

register('ACCESS_MODE_PREPARE', async (msg, respond, meta) => {
  const { ctx, client, assertEnvironment } = bind(msg.environment, ctxOf(meta));
  try {
    assertEnvironment();
    await seedFromSession(msg.environment);
    const had = !!service.cachedSubjects(msg.environment);
    const res = await service.prepare(client!, msg.environment, assertEnvironment);
    if (!had && res.subjects.length) {
      void chrome.storage.session.set({ [SUBJECTS_KEY]: { environment: msg.environment, subjects: res.subjects } }).catch(() => { /* best effort */ });
    }
    const environmentName = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId)?.label ?? client?.serverUrl ?? '';
    respond({ type: 'ACCESS_MODE_READY', environment: msg.environment, ok: true, subjects: res.subjects, available: res.available, environmentName, ...(res.reason ? { reason: res.reason } : {}) });
  } catch (e) {
    respond({ type: 'ACCESS_MODE_READY', environment: msg.environment, ok: false, error: errorMessage(e) });
  }
});

register('ACCESS_MODE_DECIDE', async (msg, respond, meta) => {
  const { client, assertEnvironment } = bind(msg.environment, ctxOf(meta));
  const base = { type: 'ACCESS_MODE_DECISIONS' as const, requestId: msg.requestId, environment: msg.environment, subjectRid: msg.subjectRid };
  try {
    const res = await service.decide(client!, msg.environment, msg.subjectRid, msg.rids, assertEnvironment);
    respond({ ...base, ok: true, verdicts: res.verdicts, ...(res.unavailable ? { unavailable: true } : {}) });
  } catch (e) {
    respond({ ...base, ok: false, error: errorMessage(e) });
  }
});

register('ACCESS_MODE_TRACE', async (msg, respond, meta) => {
  const { client, assertEnvironment } = bind(msg.environment, ctxOf(meta));
  const base = { type: 'ACCESS_MODE_TRACE_DATA' as const, requestId: msg.requestId, environment: msg.environment, subjectRid: msg.subjectRid, rid: msg.rid, action: msg.action };
  try {
    const res = await service.trace(client!, msg.environment, msg.subjectRid, msg.rid, msg.action, assertEnvironment);
    respond({ ...base, ok: !!res.trace, ...(res.trace ? { trace: res.trace } : {}), ...(res.unavailable ? { unavailable: true, error: UNAVAILABLE_REASON } : {}) });
  } catch (e) {
    respond({ ...base, ok: false, error: errorMessage(e) });
  }
});
