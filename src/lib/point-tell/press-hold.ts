/**
 * Point and tell: what one press on the page is, the pure part. A press that moves past STILL_PX is a stroke; one
 * that is let go before that is a click. When the press may start voice (voice comments are on), a press that stays
 * still for HOLD_TO_TALK_MS is a hold: voice starts, and from then on movement is ignored until it is let go.
 * The DOM (pointer events, capture, the window losing focus) is in content-pointtell/pointer.
 */

/**
 * How long a still press waits before voice starts (ms). Long enough that an ordinary click never gets there and
 * a short pause before drawing rarely does; short enough not to feel like waiting. The common long-press time is
 * about 500 ms; a little more here, because a pen often rests a moment before a stroke.
 */
export const HOLD_TO_TALK_MS = 600;
/**
 * How far a press may move (CSS px) and still be still: the same distance that makes a press a stroke and not a
 * click. Hand tremor on a mouse, pen or finger stays under it; a stroke started slowly passes it well before
 * HOLD_TO_TALK_MS (it would have to move slower than 7 px a second not to).
 */
export const STILL_PX = 4;
/** The quiet cue around the press waits this long (ms), so a click never shows it. */
export const HOLD_CUE_DELAY_MS = 180;

export type PressPhase = 'press' | 'stroke' | 'held';

export interface PressOptions {
  /** Whether this press may become a hold (voice comments are on, the pen is the tool). */
  holdable: boolean;
  /** The press stayed still long enough. True when the hold was taken (voice is starting); false: the press goes on as before. */
  onHold: () => boolean;
  ms?: number;
  slop?: number;
}

/** One press, from pointer down to pointer up. */
export class Press {
  phase: PressPhase = 'press';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly slop: number;

  constructor(readonly x: number, readonly y: number, private readonly opts: PressOptions) {
    this.slop = opts.slop ?? STILL_PX;
    if (opts.holdable) this.timer = setTimeout(() => { this.timer = null; this.fire(); }, opts.ms ?? HOLD_TO_TALK_MS);
  }

  /** Whether the hold may still come (still, holdable, time not up). */
  get charging(): boolean { return this.timer !== null; }

  private fire(): void {
    if (this.phase !== 'press') return;
    if (this.opts.onHold()) this.phase = 'held';
  }

  private disarm(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  /** The pointer moved. 'stroke' once, when the press becomes a stroke; null otherwise (also for every move of a hold). */
  move(x: number, y: number): 'stroke' | null {
    if (this.phase !== 'press') return null;
    if (Math.hypot(x - this.x, y - this.y) < this.slop) return null;
    this.disarm();
    this.phase = 'stroke';
    return 'stroke';
  }

  /** The pointer went up: what the press was. */
  up(): 'click' | 'stroke' | 'held' {
    this.disarm();
    const was = this.phase;
    return was === 'press' ? 'click' : was;
  }

  /** The press was lost (cancelled, the window lost focus): what it had become. */
  cancel(): PressPhase {
    this.disarm();
    return this.phase;
  }
}
