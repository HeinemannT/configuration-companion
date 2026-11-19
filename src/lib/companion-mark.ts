/**
 * The Companion mark (`icons/mark-28.svg`) as markup with its eyes ready to
 * move, shared by the side panel header and the pages in their own tab.
 *
 * The host element carries the class `crev-mark`; the rules are in
 * styles/mark.css and use transforms only: a blink now and then
 * (every 13 s), reading left to right while work runs
 * (`data-mood="read"`), a glance at the page (`data-look="page"`), a look at
 * a point (`data-look="point"` with `--look-x` / `--look-y`, see
 * `setMarkLook`). Nothing moves under reduced motion. The markup never
 * changes with the state.
 */
import markSource from '../../icons/mark-28.svg?raw';

const MARK = markSource
  .replace(/\s(?:role|aria-label)="[^"]*"/g, '')
  .trim()
  // The eyes get two groups to move by: the glance (outer) and reading (inner).
  .replace(/<g fill="#1c1033">(.*?)<\/g>/, '<g class="mark-look"><g class="mark-eyes" fill="#1c1033">$1</g></g>');

/** The mark as an SVG fragment; `at` places it inside a larger SVG (the
 *  side panel's ring), left out it is a standalone 28 px SVG. */
export function markSvg(at?: { x: number; y: number }): string {
  return at ? MARK.replace('<svg ', `<svg x="${at.x}" y="${at.y}" `) : MARK;
}

/** The eyes of `host` (an element with the class `crev-mark`) read while
 *  `working`, else rest. */
export function setMarkMood(host: Element | null | undefined, working: boolean): void {
  if (!host) return;
  if (working) host.setAttribute('data-mood', 'read');
  else host.removeAttribute('data-mood');
}

/** The eyes of `host` look by (`dx`, `dy`) mark units (about 1.7 at most),
 *  or rest when both are null. Point and tell's dock follows the pen tip. */
export function setMarkLook(host: Element | null | undefined, dx: number | null, dy = 0): void {
  if (!host) return;
  const el = host as HTMLElement;
  if (dx === null) {
    if (el.getAttribute('data-look') === 'point') el.removeAttribute('data-look');
    el.style.removeProperty('--look-x');
    el.style.removeProperty('--look-y');
    return;
  }
  el.setAttribute('data-look', 'point');
  el.style.setProperty('--look-x', `${dx.toFixed(2)}px`);
  el.style.setProperty('--look-y', `${dy.toFixed(2)}px`);
}

// ── A face with moods (Point and tell's dock) ───────────────────────────────────────────────────

const spiral = (cx: number, cy: number): string => {
  let d = '';
  for (let i = 0; i <= 28; i++) {
    const t = i / 28, a = t * Math.PI * 2 * 2.1, r = 0.25 + 2.05 * t;
    d += `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  }
  return d;
};

/** One eye at `cx`: open (the mark's own dot), sleepy line, glad arc, squint, spiral. Only one shows (`data-s`). */
const eye = (cx: number, side: 'l' | 'r'): string => {
  const squint = side === 'l' ? `M${cx - 1.6} 12.4L${cx + 1.6} 14L${cx - 1.6} 15.6` : `M${cx + 1.6} 12.4L${cx - 1.6} 14L${cx + 1.6} 15.6`;
  return `<g class="mk-eye" data-s="op"><circle class="mk-open" cx="${cx}" cy="14" r="2" fill="#1c1033"/>`
    + `<path class="mk-sleep mk-ln" d="M${cx - 2.1} 14.3Q${cx} 15.6 ${cx + 2.1} 14.3"/><path class="mk-glad mk-ln" d="M${cx - 2.1} 15Q${cx} 12.1 ${cx + 2.1} 15"/>`
    + `<path class="mk-squint mk-ln" d="${squint}"/><path class="mk-dizzy mk-ln" d="${spiral(cx, 14)}"/></g>`;
};

let rich: string | null = null;

/**
 * The same mark, as markup that can also show moods: brows, a sleepy line, a glad arc, a squint, a spiral and a
 * small z, all hidden until `mascot.ts` of Point and tell shows one. At rest it looks exactly like `markSvg()`.
 * The side panel and the Colors and images page do not use it. Styles: styles/mark-moods.css.
 */
export function richMarkSvg(): string {
  if (rich) return rich;
  const body = MARK
    .replace('<path ', '<g class="mk-body"><path ')
    .replace(/<g class="mark-look">.*?<\/g><\/g>/, `<g class="mark-look"><g class="mk-face"><g class="mk-brows"><path class="mk-bl" d="M11.3 10.2Q13.1 9.4 14.9 10"/><path class="mk-br" d="M16.6 10Q18.5 9.4 20.1 10.2"/></g>${eye(13, 'l')}${eye(18, 'r')}</g></g><path class="mk-zz" d="M23.6 3.2h2.4l-2.4 2.8h2.4"/></g>`);
  rich = body;
  return rich;
}
