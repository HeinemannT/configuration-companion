/**
 * Point and tell: the voice state of the comment field, the words. While the microphone is held, a layer lies over the
 * text area (same box and same type, so the text that is already there does not move and the field never changes
 * size) and the words are shown as they are recognised: each lands with a small rise and fade, in a lighter tone
 * until it is final, then firms to the normal text colour. A word the recogniser revises is changed in place with a
 * quiet cross-fade, and the words after it slide to where they now belong instead of jumping. A soft caret follows
 * the end and swells a little with the voice. Long dictation scrolls so the newest words stay in view.
 *
 * Only transforms and opacity change. Nothing runs unless voice.ts calls in (`words` for a result, `level` once a
 * frame while listening). Under reduced motion the words simply appear in their place and the caret stands still.
 */
import { diffWords, staggerMs, type HeardWord, type WordDiff } from '../lib/point-tell/voice-words';
import { EASE, animate, reducedMotion } from './motion';

export interface VoiceView {
  /** Reset to a quiet start and show; `base` is what the field held before. */
  begin(base: string): void;
  /** The words heard so far (the whole list); `scrollTop` is where the text area is scrolled to. */
  words(next: readonly HeardWord[], scrollTop: number): WordDiff;
  /** The voice level now, 0..1 (the caret swells with it). */
  level(v: number): void;
  /** Where the caret is, in window coordinates (what the listener's eyes look at). */
  caretAt(): { x: number; y: number } | null;
  /** Hide (the layer fades out as the stylesheet says); `quick`: the words firm at once. */
  end(quick: boolean): void;
  /** The words heard are dropped: they slide off to the left, the newest first. */
  discard(): void;
  /** Remove the layer. */
  remove(): void;
}

export const WAITING_WORDS = 'Listening…';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function createVoiceView(wrap: HTMLElement): VoiceView {
  const layer = el('div', 'pt-voice');
  layer.setAttribute('aria-hidden', 'true');
  // Over the text area, inside its border: the critical geometry is inline, the stylesheet only adds the look.
  Object.assign(layer.style, { position: 'absolute', left: '1px', top: '1px', right: '1px', bottom: '1px', zIndex: '1', pointerEvents: 'none' });
  const flow = el('div', 'pt-vw-flow');
  flow.style.position = 'relative';
  const ph = el('span', 'pt-vw-ph', WAITING_WORDS);
  const baseEl = el('span', 'pt-vw-base');
  const end = el('i', 'pt-vw-end');
  const caret = el('i', 'pt-vw-caret');
  const halo = el('i', 'pt-vw-halo');
  const bar = el('i', 'pt-vw-bar');
  caret.style.position = 'absolute'; caret.style.left = '0'; caret.style.top = '0'; caret.style.pointerEvents = 'none';
  bar.style.position = 'absolute'; halo.style.position = 'absolute';
  ph.style.position = 'absolute'; ph.style.left = '0'; ph.style.top = '0';
  caret.append(halo, bar);
  flow.append(ph, baseEl, end, caret);
  layer.appendChild(flow);
  wrap.appendChild(layer);

  let els: HTMLElement[] = [];
  let spaceFirst = false;
  let shownLevel = -1;
  let held = false;
  let shift = 0;

  const space = (): Text => document.createTextNode(' ');
  /** Every word has one space before it, except the first when the text before it needs none. */
  const fixSpaces = (): void => {
    els.forEach((w, k) => {
      const prev = w.previousSibling;
      const has = prev !== null && prev.nodeType === 3 && (prev as Text).data === ' ';
      const need = k > 0 || spaceFirst;
      if (need && !has) flow.insertBefore(space(), w);
      else if (!need && has) prev.remove();
    });
  };

  const place = (): void => {
    const x = end.offsetLeft + 2, y = end.offsetTop;
    caret.style.transform = `translate(${x}px,${y}px)`;
  };

  const scroll = (top: number): void => {
    shift = Math.max(0, Math.round(top));
    flow.style.transform = shift ? `translateY(${-shift}px)` : '';
    layer.classList.toggle('pt-sc', shift > 0);
  };

  const view: VoiceView = {
    begin(base) {
      for (const w of els) w.remove();
      [...flow.childNodes].forEach(n => { if (n.nodeType === 3) n.remove(); });
      els = [];
      held = true; shownLevel = -1; shift = 0;
      flow.style.transition = '';
      baseEl.textContent = base;
      spaceFirst = base !== '' && !/\s$/.test(base);
      layer.classList.toggle('pt-still', reducedMotion());
      layer.classList.remove('pt-sc', 'pt-quick');
      ph.style.opacity = base ? '0' : '';
      flow.style.transform = '';
      bar.style.transform = ''; bar.style.opacity = ''; halo.style.opacity = '';
      place();
    },
    words(next, scrollTop) {
      const prev: HeardWord[] = els.map(w => ({ text: w.dataset.w ?? '', final: w.classList.contains('f') }));
      const diff = diffWords(prev, next);
      const still = reducedMotion();
      // Where the kept words are now: the ones after a revision slide to their new place instead of jumping there.
      const flip = !still && diff.items.some(i => i.kind === 'changed') ? els.map(w => [w.offsetLeft, w.offsetTop] as const) : null;
      const before = new Map<HTMLElement, readonly [number, number]>();
      if (flip) els.forEach((w, k) => before.set(w, flip[k]));
      for (const k of diff.removed) { const gone = els[k]; if (gone.previousSibling?.nodeType === 3) gone.previousSibling.remove(); gone.remove(); }
      const out: HTMLElement[] = [];
      let n = 0;
      const delays = new Map<number, number>();
      diff.items.forEach((it, i) => { if (it.kind === 'new') delays.set(i, staggerMs(n++)); });
      // Firming runs one word after another (the last word of a phrase last), like the words arriving.
      let firmed = 0;
      diff.items.forEach((it, i) => {
        let w: HTMLElement;
        if (it.from === null) {
          w = el('span', 'pt-w', it.word.text);
          w.dataset.w = it.word.text;
          if (!still) w.style.setProperty('--d', `${delays.get(i) ?? 0}ms`);
          else w.classList.add('pt-w-now');
          let after: Node = end;
          for (let j = i + 1; j < diff.items.length; j++) { const f = diff.items[j].from; if (f !== null && els[f]?.isConnected) { after = els[f]; break; } }
          flow.insertBefore(w, after);
        } else {
          w = els[it.from];
          if (it.kind === 'changed') {
            const old = w.dataset.w ?? '';
            w.textContent = it.word.text;
            w.dataset.w = it.word.text;
            if (!still) {
              const ghost = el('span', 'pt-w-old', old);
              w.appendChild(ghost);
              const a = animate(ghost, [{ opacity: 0.9 }, { opacity: 0 }], { duration: 200, easing: EASE.out, fill: 'forwards' });
              if (a) { a.finished.then(() => ghost.remove(), () => ghost.remove()); } else ghost.remove();
              animate(w, [{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: EASE.out });
            }
          }
        }
        if (it.word.final && !w.classList.contains('f')) {
          if (!still && it.kind === 'firm') w.style.setProperty('--fd', `${Math.min(150, firmed++ * 22)}ms`);
          w.classList.add('f');
        }
        out.push(w);
      });
      els = out;
      fixSpaces();
      ph.style.opacity = els.length || baseEl.textContent ? '0' : '';
      scroll(scrollTop);
      place();
      if (flip) {
        for (const w of els) {
          const was = before.get(w);
          if (!was) continue;
          const dx = was[0] - w.offsetLeft, dy = was[1] - w.offsetTop;
          if (dx || dy) animate(w, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.16,1,.3,1)', composite: 'add' });
        }
      }
      return diff;
    },
    level(v) {
      if (!held || Math.abs(v - shownLevel) < 0.012) return;
      shownLevel = v;
      bar.style.transform = `scaleY(${(1 + 0.3 * v).toFixed(3)})`;
      bar.style.opacity = (0.78 + 0.22 * v).toFixed(2);
      halo.style.opacity = (0.08 + 0.5 * v).toFixed(2);
    },
    caretAt() {
      if (!held) return null;
      const r = caret.getBoundingClientRect();
      return { x: r.left + 1, y: r.top + r.height / 2 };
    },
    end(quick) {
      held = false;
      layer.classList.toggle('pt-quick', quick);
      // The words stand where the text area's own text will be: nothing may still be sliding or rising when it shows through.
      flow.style.transition = 'none';
      for (const w of els) { w.classList.add('f', 'pt-w-now'); w.getAnimations?.().forEach(an => an.finish()); }
      bar.style.transform = ''; bar.style.opacity = ''; halo.style.opacity = '';
    },
    discard() {
      const n = els.length;
      els.forEach((w, i) => animate(w, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-14px)' }], { duration: 170, delay: (n - 1 - i) * Math.min(14, 110 / n), easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' }));
    },
    remove() { layer.remove(); },
  };
  return view;
}
