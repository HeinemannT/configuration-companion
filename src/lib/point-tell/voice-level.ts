/**
 * Point and tell: the level of the voice, the pure part. While listening, the caret and the listener's
 * ripples follow what the microphone hears: one level per frame from the input's samples (an analyser beside the
 * recogniser) or, when a second stream is not possible, from the recogniser's own events. Numbers in, numbers out; the
 * DOM is in content-pointtell/voice-view and listener.
 */

/** The root mean square of byte time-domain samples (128 is silence): 0 for silence, about 0.3 for loud speech. */
export function rmsOf(bytes: ArrayLike<number>): number {
  if (!bytes.length) return 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) { const v = (bytes[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / bytes.length);
}

/** An rms as a level of 0..1: a noise floor under it counts as silence, ordinary speech fills most of the range. */
export function levelOf(rms: number): number {
  const v = Math.max(0, rms - 0.012) / 0.16;
  return Math.min(1, Math.pow(Math.min(1, v), 0.7));
}

/** Quick to rise, slower to fall, so a word reads as a swell and not as flicker; `dtMs` is the time since the last level. */
export function smooth(prev: number, next: number, dtMs = 16): number {
  const tau = next > prev ? 40 : 130;
  return prev + (next - prev) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
}

/**
 * The fallback level, from the recogniser's events alone (no input samples): sound starts, speech starts, a result
 * arrives, speech ends. It is a drive for the caret and the ripples, not a measurement: a swell while speech is going on,
 * a lift at each result, and a small movement so they do not stand still.
 */
export class EventLevel {
  private target = 0;
  private bump = 0;
  event(kind: 'soundstart' | 'speechstart' | 'result' | 'speechend' | 'soundend'): void {
    if (kind === 'soundstart') this.target = Math.max(this.target, 0.25);
    else if (kind === 'speechstart') this.target = 0.55;
    else if (kind === 'result') { this.target = Math.max(this.target, 0.5); this.bump = 0.45; }
    else this.target = kind === 'speechend' ? 0.12 : 0;
  }
  /** One tick; `rand` is in 0..1. */
  next(rand: number): number {
    this.bump = this.bump < 0.01 ? 0 : this.bump * 0.7;
    const wobble = this.target > 0.2 ? (rand - 0.5) * 0.5 : 0;
    return Math.max(0, Math.min(1, this.target + this.bump + wobble));
  }
}
