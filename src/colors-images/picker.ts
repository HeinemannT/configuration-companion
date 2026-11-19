/**
 * A colour picker for the editor: a saturation and brightness square over a
 * hue strip, both dragged with the pointer. The hex field next to it is the
 * precise way in; this is the quick one. No keyboard model beyond the
 * native keys of the hex field.
 */
import { el } from '../lib/dom';
import { hexToHsv, hsvToHex, type Hsv } from '../lib/colors-images/color-math';

export interface Picker {
  el: HTMLElement;
  /** Show a colour (does not call onInput). */
  set(hex: string): void;
}

function drag(target: HTMLElement, move: (x: number, y: number) => void): void {
  const at = (e: PointerEvent) => {
    const r = target.getBoundingClientRect();
    move(Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))), Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1))));
  };
  target.addEventListener('pointerdown', e => {
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    at(e);
    const onMove = (m: PointerEvent) => at(m);
    const stop = () => { target.removeEventListener('pointermove', onMove); target.removeEventListener('pointerup', stop); target.removeEventListener('pointercancel', stop); };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
  });
}

export function createPicker(initial: string, onInput: (hex: string) => void): Picker {
  let hsv: Hsv = hexToHsv(initial);
  const knob = el('i');
  const sv = el('div', 'ci-sv', knob);
  const hueKnob = el('i');
  const hue = el('div', 'ci-hue', hueKnob);
  sv.setAttribute('aria-hidden', 'true');
  hue.setAttribute('aria-hidden', 'true');

  const paint = () => {
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)} 100% 50%))`;
    knob.style.left = `${hsv.s * 100}%`;
    knob.style.top = `${(1 - hsv.v) * 100}%`;
    hueKnob.style.left = `${(hsv.h / 360) * 100}%`;
  };
  drag(sv, (x, y) => { hsv = { ...hsv, s: x, v: 1 - y }; paint(); onInput(hsvToHex(hsv)); });
  drag(hue, x => { hsv = { ...hsv, h: x * 359.999 }; paint(); onInput(hsvToHex(hsv)); });
  paint();
  return {
    el: el('div', 'ci-picker', sv, hue),
    set(hex) {
      // A grey has no hue of its own: keep the hue on the strip.
      const next = hexToHsv(hex);
      hsv = { h: next.s === 0 || next.v === 0 ? hsv.h : next.h, s: next.s, v: next.v };
      paint();
    },
  };
}
