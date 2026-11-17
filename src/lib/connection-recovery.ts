/**
 * Self-healing for connection states that clear on their own when the server
 * comes back: Unreachable, Server down, and Commands failing.
 *
 * Scheduling uses `chrome.alarms`, not timers. An MV3 service worker is put to
 * sleep after about 30 seconds without events and loses every `setTimeout`;
 * an alarm is stored by the browser, survives that sleep (and a browser
 * restart), and wakes the worker when it fires. The attempt counter lives in
 * `chrome.storage.session` for the same reason.
 *
 * Backoff: 30 s, 1 min, 2 min, then every 5 min while the state persists.
 * Plan 021 allows `chrome.alarms` for background observation at a
 * conservative cadence; the check it runs is reachability first, and the
 * command check only after reachability changed (see connection.ts).
 */
import { log } from './logger';

export const RECOVERY_ALARM = 'crev-connection-recovery';
const RECOVERY_KEY = 'crev_conn_recovery';
/** Minutes until the next check, by attempt number (the last value repeats). */
export const RECOVERY_DELAYS_MIN = [0.5, 1, 2, 5] as const;

/** Displays that may heal without user action and are therefore re-checked. */
const RECOVERABLE = new Set(['unreachable', 'server-down', 'command-failed']);
/** Transitional displays keep an existing schedule; everything else clears it. */
const TRANSITIONAL = new Set(['checking', 'reconnecting']);

export interface RecoveryRecord {
  profileId: string;
  attempt: number;
}

export function isRecoverableDisplay(display: string): boolean {
  return RECOVERABLE.has(display);
}

export function recoveryDelayMinutes(attempt: number): number {
  return RECOVERY_DELAYS_MIN[Math.min(Math.max(attempt, 0), RECOVERY_DELAYS_MIN.length - 1)];
}

function alarmsAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.alarms?.create;
}

let current: RecoveryRecord | null = null;
let loaded = false;

async function readRecord(): Promise<RecoveryRecord | null> {
  if (loaded) return current;
  try {
    const raw = await chrome.storage.session.get(RECOVERY_KEY);
    const value = raw[RECOVERY_KEY] as RecoveryRecord | undefined;
    current = value && typeof value.profileId === 'string' && typeof value.attempt === 'number' ? value : null;
  } catch (e) {
    log.swallow('recovery:read', e);
    current = null;
  }
  loaded = true;
  return current;
}

async function writeRecord(record: RecoveryRecord | null): Promise<void> {
  current = record;
  loaded = true;
  try {
    if (record) await chrome.storage.session.set({ [RECOVERY_KEY]: record });
    else await chrome.storage.session.remove(RECOVERY_KEY);
  } catch (e) { log.swallow('recovery:write', e); }
}

async function schedule(record: RecoveryRecord): Promise<void> {
  await writeRecord(record);
  if (!alarmsAvailable()) return;
  try {
    await chrome.alarms.create(RECOVERY_ALARM, { delayInMinutes: recoveryDelayMinutes(record.attempt) });
  } catch (e) { log.swallow('recovery:create', e); }
}

export async function clearRecovery(): Promise<void> {
  if (!(await readRecord())) return;
  await writeRecord(null);
  if (!alarmsAvailable()) return;
  try { await chrome.alarms.clear(RECOVERY_ALARM); } catch (e) { log.swallow('recovery:clear', e); }
}

let tail: Promise<void> = Promise.resolve();
/** Serialise schedule changes: publications can arrive in bursts. */
function serial(task: () => Promise<void>): Promise<void> {
  tail = tail.then(task, task);
  return tail;
}

/** Called on every connection publication. Starts a schedule when a
 *  recoverable state begins, and clears it when the state is resolved. */
export function syncRecovery(display: string, profileId: string): Promise<void> {
  return serial(async () => {
    const record = await readRecord();
    if (!profileId || !isRecoverableDisplay(display)) {
      if (TRANSITIONAL.has(display) && record?.profileId === profileId) return;
      // Every profile has its own connection; a healthy one must not end
      // another profile's recovery schedule.
      if (profileId && record && record.profileId !== profileId) return;
      await clearRecovery();
      return;
    }
    if (record?.profileId === profileId) {
      // Keep the running schedule, but re-arm it if the alarm was lost
      // (for example the extension was reloaded).
      if (alarmsAvailable()) {
        const alarm = await chrome.alarms.get(RECOVERY_ALARM).catch(() => undefined);
        if (!alarm) await schedule(record);
      }
      return;
    }
    await schedule({ profileId, attempt: 0 });
  });
}

/** After an alarm-driven check: schedule the next attempt when the state is
 *  still recoverable, otherwise clear. Returns the record that was used. */
export function afterRecoveryCheck(display: string, profileId: string): Promise<void> {
  return serial(async () => {
    const record = await readRecord();
    if (!record || record.profileId !== profileId || !isRecoverableDisplay(display)) {
      await clearRecovery();
      return;
    }
    await schedule({ profileId, attempt: record.attempt + 1 });
  });
}

export function recoveryRecord(): Promise<RecoveryRecord | null> {
  return readRecord();
}

/** Test hook: forget the in-memory copy so the next read comes from storage. */
export function resetRecoveryMemory(): void {
  current = null;
  loaded = false;
  tail = Promise.resolve();
}
