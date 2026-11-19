/**
 * Point and tell: the motion, defined once. The response tag, the number badge and the mark share these
 * curves and durations (the badge's pop in content-pointtell.css repeats `EASE.pop` and `MS.pop` by value).
 * Only transform and opacity are ever animated. Under prefers-reduced-motion nothing moves: `animate`
 * returns null and the callers show the end state.
 */
export const EASE = {
  /** Things arriving and settling. */
  out: 'ease-out',
  /** Things going back and forth. */
  inOut: 'ease-in-out',
  /** Springy arrivals: the badge's pop, the mark's curious tilt. */
  pop: 'cubic-bezier(.3,1.5,.5,1)',
  /** The tag leaving for its badge: slow start, quick end. */
  fly: 'cubic-bezier(.5,0,.75,.4)',
  /** Spinning down (the dizzy spiral). */
  spin: 'cubic-bezier(.2,.6,.4,1)',
} as const;

export const MS = {
  /** The tag fades in. */
  tagIn: 160,
  /** The tag stays this long before it flies. */
  tagHold: 1050,
  /** The tag's flight into the badge. */
  tagFly: 300,
  /** Without motion the tag stays a little longer and fades in place. */
  tagStill: 1250,
  tagFade: 200,
  /** The badge's pulse as the tag lands. */
  pulse: 360,
  pop: 260,
} as const;

const query = (): MediaQueryList | null => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null);
let rm: MediaQueryList | null | undefined;

/** The user asked for less motion. */
export function reducedMotion(): boolean {
  if (rm === undefined) rm = query();
  return !!rm?.matches;
}

/** `el.animate`, or null when motion is off or the element cannot animate (then the end state is shown at once). */
export function animate(el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation | null {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return null;
  return el.animate(keyframes, options);
}

/** A fade: opacity only, so it is also what remains under reduced motion (a tag appears and fades in place). */
export function fade(el: Element, from: number, to: number, ms: number): Animation | null {
  return typeof el.animate === 'function' ? el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: EASE.out, fill: 'forwards' }) : null;
}
