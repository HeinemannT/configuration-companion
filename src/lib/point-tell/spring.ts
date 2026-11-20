/**
 * A damped spring as a CSS `linear()` easing: the step response of a mass on a spring, sampled, so a Web Animation
 * can rise with a light overshoot and settle without a bounce, with no script running while it plays.
 */

/** The damping ratio that gives `overshoot` (a fraction of the distance; 0.05 is five percent). */
export function dampingFor(overshoot: number): number {
  const l = Math.log(Math.min(0.9, Math.max(0.0005, overshoot)));
  return -l / Math.sqrt(Math.PI * Math.PI + l * l);
}

/** The spring's position at `t` (0..1 of the animation): 0 at the start, 1 at the end, past 1 by `overshoot` once. */
export function springAt(t: number, overshoot: number, settle = 0.004): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const z = dampingFor(overshoot);
  // The envelope e^(-z w t) falls to `settle` at t = 1.
  const w = -Math.log(settle) / z;
  const wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

/** `linear(...)`: `n` samples of the spring, exactly 0 first and exactly 1 last. */
export function springEasing(overshoot = 0.05, n = 36): string {
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) pts.push(String(+springAt(i / n, overshoot).toFixed(4)));
  return `linear(${pts.join(', ')})`;
}
