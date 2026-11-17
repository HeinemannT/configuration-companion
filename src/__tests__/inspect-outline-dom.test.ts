// @vitest-environment happy-dom
/**
 * The outline frame, the current object and Locate in the page DOM:
 * critical layout inline (position, z-index, pointer-events), never on the
 * page's own element; background detection from computed styles; the
 * current object's ring and mark; locate's spot (pulse unless motion is
 * reduced) and edge flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFrame, frameOf, readOutlineLook, removeFrame, setOutlineColor, writeOutlineLook, FRAME_Z_INDEX } from '../content-outline';
import { clearCurrent, currentObject, endLocate, locateElement, markCurrent, LOCATE_MS, LOCATE_Z_INDEX } from '../content-current';
import { contrast } from '../lib/badge-look';

vi.mock('../lib/messaging', () => ({ sendFireForget: vi.fn() }));

function host(rid: string, html = ''): { host: HTMLElement; label: HTMLElement } {
  const el = document.createElement('div');
  el.className = 'crev-outline';
  el.innerHTML = html;
  const label = document.createElement('span');
  label.className = 'crev-label';
  label.dataset.crevLabel = rid;
  const stub = document.createElement('span');
  stub.className = 'crev-stub';
  label.appendChild(stub);
  el.appendChild(label);
  return { host: el, label };
}

const rect = (top: number, left: number, w: number, h: number) => ({ top, left, bottom: top + h, right: left + w, width: w, height: h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('the outline frame', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('is our own child with inline position, z-index and no pointer events; the host keeps its own outline', () => {
    const { host: h } = host('1');
    h.style.outline = '1px solid red';
    const own = h.style.outline;
    document.body.appendChild(h);
    const f = ensureFrame(h);
    expect(ensureFrame(h)).toBe(f);
    expect(f.style.position).toBe('absolute');
    expect(f.style.zIndex).toBe(FRAME_Z_INDEX);
    expect(f.style.pointerEvents).toBe('none');
    expect(f.getAttribute('aria-hidden')).toBe('true');
    expect(h.style.outline).toBe(own);
    setOutlineColor(h, '#6fdc8c', 'Scorecard');
    expect(contrast(h.style.getPropertyValue('--crev-tick'), '#ffffff')).toBeGreaterThanOrEqual(4.8);
    expect(f.dataset.crevType).toBe('Scorecard');
    removeFrame(h);
    expect(frameOf(h)).toBeNull();
  });

  it('classifies nesting and detects a dark ancestor background once', () => {
    const header = document.createElement('header');
    header.style.backgroundColor = 'rgb(11, 61, 107)';
    const { host: outer, label: outerLabel } = host('1');
    const { host: inner, label: innerLabel } = host('2');
    outer.appendChild(inner);
    header.appendChild(outer);
    document.body.appendChild(header);
    ensureFrame(outer);
    ensureFrame(inner);
    setOutlineColor(outer, '#9aa3e8', 'ExtendedTable');
    setOutlineColor(inner, '#78a9ff', 'ExtendedTable');
    const cache = new Map();
    const a = readOutlineLook(outerLabel, outer, cache)!;
    const b = readOutlineLook(innerLabel, inner, cache)!;
    expect(a.level).toBe('container');
    expect(b.backdrop).toBe('dark');
    writeOutlineLook(outerLabel, a);
    writeOutlineLook(innerLabel, b);
    expect(frameOf(outer)!.classList.contains('crev-frame--container')).toBe(true);
    expect(frameOf(inner)!.classList.contains('crev-on-dark')).toBe(true);
    expect(innerLabel.classList.contains('crev-on-dark')).toBe(true);
    // Kept: the next pass does not walk the styles again.
    expect(frameOf(inner)!.dataset.crevBg).toBe('dark');
    const spy = vi.spyOn(window, 'getComputedStyle');
    readOutlineLook(innerLabel, inner, new Map());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a light page stays light', () => {
    const { host: h, label } = host('1');
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';
    document.body.appendChild(h);
    ensureFrame(h);
    expect(readOutlineLook(label, h, new Map())!.backdrop).toBe('light');
  });
});

describe('the current object', () => {
  beforeEach(() => { document.body.replaceChildren(); clearCurrent(); });

  it('rings one object at a time and marks its badge', () => {
    const a = host('11'), b = host('22');
    document.body.append(a.host, b.host);
    markCurrent('11');
    expect(a.host.classList.contains('crev-current')).toBe(true);
    expect(a.label.querySelector('.crev-curmark')).not.toBeNull();
    expect(a.label.querySelector('.crev-stub')!.getAttribute('aria-current')).toBe('true');
    markCurrent('22');
    expect(a.host.classList.contains('crev-current')).toBe(false);
    expect(a.label.querySelector('.crev-curmark')).toBeNull();
    expect(b.host.classList.contains('crev-current')).toBe(true);
    expect(currentObject()).toBe('22');
    clearCurrent();
    expect(document.querySelector('.crev-current')).toBeNull();
  });
});

describe('locate on page', () => {
  let target: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    clearCurrent();
    const h = host('77');
    target = h.host;
    document.body.appendChild(target);
    target.scrollIntoView = vi.fn();
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  });
  afterEach(() => { endLocate(); vi.useRealTimers(); });

  it('on screen: no scroll, the page dims around a pulsing ring for 1.5 s; inline layout', () => {
    target.getBoundingClientRect = () => rect(100, 100, 300, 200);
    locateElement(target, { rid: '77', name: 'Risks', type: 'ExtendedTable' }, false);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    const spot = document.getElementById('crev-locate-spot')!;
    expect(spot.style.position).toBe('fixed');
    expect(spot.style.zIndex).toBe(LOCATE_Z_INDEX);
    expect(spot.style.pointerEvents).toBe('none');
    expect(spot.style.top).toBe('97px');
    expect(spot.classList.contains('crev-locate-spot--pulse')).toBe(true);
    expect(document.getElementById('crev-locate-flag')).toBeNull();
    expect(target.classList.contains('crev-current')).toBe(true);
    vi.advanceTimersByTime(LOCATE_MS + 10);
    expect(document.getElementById('crev-locate-spot')).toBeNull();
  });

  it('with reduced motion: the ring and the dim, no pulse, no smooth scroll', () => {
    target.getBoundingClientRect = () => rect(1200, 100, 300, 200);
    locateElement(target, { rid: '77', name: 'Risks' }, true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });

  it('off screen: an edge flag names it and points to it, then the spot once it is in view', () => {
    let r = rect(1600, 200, 300, 200);
    target.getBoundingClientRect = () => r;
    locateElement(target, { rid: '77', name: 'Risks', type: 'ExtendedTable' }, false);
    const flag = document.getElementById('crev-locate-flag')!;
    expect(flag.textContent).toContain('Risks');
    expect(flag.classList.contains('crev-locate-flag--bottom')).toBe(true);
    expect(flag.style.position).toBe('fixed');
    expect(flag.style.zIndex).toBe(LOCATE_Z_INDEX);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    // The scroll lands.
    r = rect(300, 200, 300, 200);
    vi.advanceTimersByTime(800);
    expect(document.getElementById('crev-locate-flag')).toBeNull();
    expect(document.getElementById('crev-locate-spot')).not.toBeNull();
  });

  it('a target that stays off screen keeps the flag; a click on it scrolls again', () => {
    target.getBoundingClientRect = () => rect(-900, 200, 300, 200);
    locateElement(target, { rid: '77', name: 'Risks' }, false);
    vi.advanceTimersByTime(800);
    const flag = document.getElementById('crev-locate-flag')!;
    expect(flag.classList.contains('crev-locate-flag--top')).toBe(true);
    flag.click();
    expect(target.scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
