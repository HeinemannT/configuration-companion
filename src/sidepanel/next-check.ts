/**
 * "Next check in 28 s" for the connection band. The time comes from the real
 * recovery alarm (chrome.alarms keeps it across worker sleeps), never from a
 * local guess. The clock ticks only while the panel is visible: a hidden panel
 * keeps no timer, and becoming visible re-reads the alarm.
 */
import { RECOVERY_ALARM } from '../lib/connection-recovery';

/** Words for the time until `scheduledTime`; null when there is no check. */
export function nextCheckText(scheduledTime: number | null | undefined, now: number): string | null {
  if (scheduledTime == null || !Number.isFinite(scheduledTime)) return null;
  const seconds = Math.ceil((scheduledTime - now) / 1000);
  if (seconds <= 0) return 'Checking now';
  if (seconds < 60) return `Next check in ${seconds} s`;
  return `Next check in ${Math.round(seconds / 60)} min`;
}

/** Milliseconds until the text can next change. */
export function nextTickDelay(scheduledTime: number, now: number): number {
  const remain = scheduledTime - now;
  // Past due: the check runs and re-arms the alarm; read it again shortly.
  if (remain <= 0) return 2_000;
  if (remain <= 60_000) return Math.max(50, remain % 1_000 || 1_000);
  // Minutes only change once a minute; land just after the next boundary.
  return Math.max(1_000, Math.min(30_000, remain - 60_000 + 50));
}

export interface NextCheckDeps {
  getAlarm(): Promise<{ scheduledTime: number } | undefined>;
  onText(text: string | null): void;
  isVisible(): boolean;
  onVisibilityChange(cb: () => void): void;
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export function chromeNextCheckDeps(onText: (text: string | null) => void, doc: Document = document): NextCheckDeps {
  return {
    getAlarm: async () => {
      try { return await chrome.alarms.get(RECOVERY_ALARM); } catch { return undefined; }
    },
    onText,
    isVisible: () => doc.visibilityState !== 'hidden',
    onVisibilityChange: (cb) => doc.addEventListener('visibilitychange', cb),
    now: () => Date.now(),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Keeps one text up to date while `setActive(true)` and the panel is visible. */
export class NextCheckClock {
  private active = false;
  private timer: unknown = null;
  private scheduled: number | null = null;
  private generation = 0;
  private lastText: string | null = null;

  constructor(private readonly deps: NextCheckDeps) {
    deps.onVisibilityChange(() => {
      if (!this.active) return;
      if (this.deps.isVisible()) void this.refresh();
      else this.stopTimer();
    });
  }

  /** Turn the clock on for a recoverable state, off otherwise. */
  setActive(active: boolean): void {
    if (active === this.active) {
      if (active) void this.refresh();
      return;
    }
    this.active = active;
    if (active) void this.refresh();
    else {
      this.stopTimer();
      this.scheduled = null;
      this.emit(null);
    }
  }

  /** Re-read the alarm (state changed, panel became visible, check came due). */
  async refresh(): Promise<void> {
    if (!this.active) return;
    const generation = ++this.generation;
    const alarm = await this.deps.getAlarm();
    if (!this.active || generation !== this.generation) return;
    this.scheduled = alarm?.scheduledTime ?? null;
    this.tick();
  }

  private tick(): void {
    this.stopTimer();
    if (!this.active) return;
    const now = this.deps.now();
    this.emit(nextCheckText(this.scheduled, now));
    if (!this.deps.isVisible()) return;
    if (this.scheduled == null) {
      // A fired one-shot alarm is gone until the worker re-arms it after the
      // check; look again shortly rather than showing nothing for good.
      this.timer = this.deps.setTimer(() => { this.timer = null; void this.refresh(); }, 5_000);
      return;
    }
    const due = this.scheduled <= now;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      if (due) void this.refresh();
      else this.tick();
    }, nextTickDelay(this.scheduled, now));
  }

  private stopTimer(): void {
    if (this.timer != null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private emit(text: string | null): void {
    if (text === this.lastText) return;
    this.lastText = text;
    this.deps.onText(text);
  }
}
