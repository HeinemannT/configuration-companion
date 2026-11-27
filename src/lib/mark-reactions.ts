/**
 * The mark's reaction to a click on it (the side panel's server switcher):
 * a small hop. It is a short Web Animation on transform only, on the mark's
 * body (the arc and the eyes as one group, `.mark-act`). It exists only
 * while it plays and ends where it began.
 *
 * Which wins:
 *  - The hop moves the whole body, so the blink, reading
 *    (`data-mood="read"`) and looking (`data-look`) go on inside it.
 *  - A new click stops the hop playing and starts it again from rest.
 *  - Under prefers-reduced-motion nothing plays.
 */

export type MarkReactionName = 'hop';
type Part = 'body';

interface Track { part: Part; frames: Keyframe[]; easing?: string }
export interface MarkReaction { name: MarkReactionName; ms: number; tracks: Track[] }

const SELECTOR: Record<Part, string> = {
  body: '.mark-act',
};

const body = (y: number, sx = 1, sy = sx) => `translateY(${y}px) scale(${sx}, ${sy})`;

export const REACTIONS: Record<MarkReactionName, MarkReaction> = {
  /** A small hop: squat, up, a soft squash on landing. */
  hop: {
    name: 'hop', ms: 540, tracks: [
      { part: 'body', easing: 'ease-in-out', frames: [
        { offset: 0, transform: body(0) },
        { offset: 0.18, transform: body(0, 1.08, 0.9) },
        // Up only as far as the ring leaves room: the arc's upper corner stays inside it.
        { offset: 0.45, transform: body(-1.6, 0.96, 1.04) },
        { offset: 0.72, transform: body(0, 1.06, 0.92) },
        { offset: 0.86, transform: body(0, 0.98, 1.02) },
        { offset: 1, transform: body(0) },
      ] },
    ],
  },
};

const playing = new WeakMap<Element, Animation[]>();

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Stop what `host` plays (it jumps back to rest). */
export function stopMarkReaction(host: Element): void {
  const anims = playing.get(host);
  if (!anims) return;
  anims.forEach(a => a.cancel());
  playing.delete(host);
}

/** Play `name` on `host` (an element with the class `crev-mark`). Returns
 *  the animations started (none under reduced motion or without
 *  `Element.animate`). */
export function playMarkReaction(host: Element | null | undefined, name: MarkReactionName): Animation[] {
  if (!host || reducedMotion()) return [];
  const reaction = REACTIONS[name];
  stopMarkReaction(host);
  const anims: Animation[] = [];
  for (const t of reaction.tracks) {
    for (const el of host.querySelectorAll(SELECTOR[t.part])) {
      if (typeof el.animate !== 'function') continue;
      const a = el.animate(t.frames, { duration: reaction.ms, easing: t.easing ?? 'ease-in-out' });
      a.finished?.then(() => { if (playing.get(host)?.includes(a)) playing.delete(host); }, () => { /* cancelled by the next click */ });
      anims.push(a);
    }
  }
  if (anims.length) playing.set(host, anims);
  return anims;
}

/** A click on the mark: the hop, played on `host`. Returns its name. */
export function reactToClick(host: Element | null | undefined): MarkReactionName | null {
  if (!host) return null;
  playMarkReaction(host, 'hop');
  return 'hop';
}
