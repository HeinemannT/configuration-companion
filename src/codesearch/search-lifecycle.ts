/**
 * How a code search window's server search ends. Every search ends with a
 * visible state: results, an error, "Stopped.", "Stopped: another search
 * started in <window>" or "No answer from the server." The last one comes
 * from the watchdog, which asks the worker about a search that has gone quiet.
 */

export const STOPPED_TEXT = 'Stopped.';
export const NO_ANSWER_TEXT = 'No answer from the server.';
/** A search with no hit, progress or done message for this long is checked. */
export const QUIET_MS = 45_000;
/** The worker answers a status check at once; this long without a reply
 *  means it is gone. */
export const STATUS_TIMEOUT_MS = 5_000;

/** The wording of a search that ended without an outcome or error. A stop is
 *  not a failure: callers show it as a plain note, not as an error. */
export function cancelledText(cancelled: 'superseded' | 'stopped', byOtherWindow = false): string {
  if (cancelled === 'stopped') return STOPPED_TEXT;
  return byOtherWindow ? 'Stopped: another search started in another code search window.' : 'Stopped: another search started in this window.';
}

/** Whether an end text is one of the plain "ended, run it again" states. */
export function isQuietEnd(text: string | undefined): boolean {
  return !!text && (text === STOPPED_TEXT || text === NO_ANSWER_TEXT || text.startsWith('Stopped: another search'));
}

export interface Watchdog {
  /** A message of the search arrived: the quiet time starts again. */
  touch(): void;
  /** Stop watching (the search ended). */
  stop(): void;
}

export interface WatchdogOptions {
  quietMs?: number;
  /** Asks the worker whether it still runs the search. Throwing or
   *  resolving to undefined means no answer. */
  ask: () => Promise<boolean | undefined>;
  /** The worker does not know the search, or did not answer. */
  onDead: () => void;
}

/** Start watching a search. After `quietMs` without `touch()` the worker is
 *  asked; a running search keeps being watched, an unknown one ends. */
export function startWatchdog(o: WatchdogOptions): Watchdog {
  const quietMs = o.quietMs ?? QUIET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = (): void => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => { void check(); }, quietMs);
  };
  const check = async (): Promise<void> => {
    let running: boolean | undefined;
    try { running = await o.ask(); } catch { running = undefined; }
    if (stopped) return;
    if (running === true) { arm(); return; }
    stopped = true;
    clearTimeout(timer);
    o.onDead();
  };
  arm();
  return {
    touch: arm,
    stop: () => { stopped = true; clearTimeout(timer); },
  };
}
