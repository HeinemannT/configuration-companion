/**
 * @vitest-environment happy-dom
 *
 * The mark's click reaction: one hop of 300 to 700 ms, transforms only, on
 * the body group the mark really has; every click plays it again from rest;
 * reading and looking go on inside it; nothing under reduced motion; the
 * markup never changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REACTIONS, playMarkReaction, reactToClick, stopMarkReaction } from '../mark-reactions';
import { buildServerControl, reactToSwitcherClick } from '../../sidepanel/server-control';

let reduced = false;
const calls: Array<{ el: Element; frames: Keyframe[]; ms: number; cancel: ReturnType<typeof vi.fn> }> = [];

beforeEach(() => {
  reduced = false;
  calls.length = 0;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') && reduced }));
  Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, o?: number | KeyframeAnimationOptions) {
    const cancel = vi.fn();
    calls.push({ el: this, frames: frames as Keyframe[], ms: typeof o === 'number' ? o : Number(o?.duration), cancel });
    return { cancel, finished: new Promise(() => { /* never ends in these tests */ }) } as unknown as Animation;
  };
});
afterEach(() => { vi.unstubAllGlobals(); });

const ring = () => buildServerControl().querySelector('.srv-ring')!;

describe('mark reaction', () => {
  it('is one hop of 300 to 700 ms, transforms only, ending at rest', () => {
    expect(Object.keys(REACTIONS)).toEqual(['hop']);
    const r = REACTIONS.hop;
    expect(r.ms).toBeGreaterThanOrEqual(300);
    expect(r.ms).toBeLessThanOrEqual(700);
    for (const t of r.tracks) {
      for (const f of t.frames) for (const k of Object.keys(f)) expect(['offset', 'transform']).toContain(k);
      expect(t.frames[0].transform).toBe(t.frames[t.frames.length - 1].transform);
    }
  });

  it('moves only the body group the switcher mark has', () => {
    const host = ring();
    playMarkReaction(host, 'hop');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(host.contains(c.el)).toBe(true); expect(c.el.classList.contains('mark-act')).toBe(true); }
    expect(host.querySelector(':scope > svg > svg > .mark-act > path')).not.toBeNull();
    expect(host.querySelector('.mark-act .mark-look > .mark-eyes')).not.toBeNull();
  });

  it('every click plays the hop again from rest and changes no markup', () => {
    const host = ring();
    const markup = host.innerHTML;
    expect([reactToClick(host), reactToClick(host), reactToClick(host)]).toEqual(['hop', 'hop', 'hop']);
    expect(calls).toHaveLength(3);
    // A click while one plays stops it first.
    expect(calls[0].cancel).toHaveBeenCalled();
    expect(calls[1].cancel).toHaveBeenCalled();
    expect(calls[2].cancel).not.toHaveBeenCalled();
    stopMarkReaction(host);
    expect(calls[2].cancel).toHaveBeenCalled();
    expect(host.innerHTML).toBe(markup);
  });

  it('plays while the eyes read or look (they move inside the body)', () => {
    const host = ring();
    host.setAttribute('data-mood', 'read');
    expect(playMarkReaction(host, 'hop')).toHaveLength(1);
    host.removeAttribute('data-mood');
    host.setAttribute('data-look', 'page');
    expect(playMarkReaction(host, 'hop')).toHaveLength(1);
  });

  it('nothing moves under reduced motion', () => {
    reduced = true;
    const host = ring();
    expect(playMarkReaction(host, 'hop')).toEqual([]);
    reactToSwitcherClick(host.closest('button') ?? buildServerControl());
    expect(calls).toHaveLength(0);
  });
});
