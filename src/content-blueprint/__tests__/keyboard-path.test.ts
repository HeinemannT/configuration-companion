// @vitest-environment happy-dom
/**
 * The Blueprint canvas keyboard path: one tab stop into the canvas, arrows
 * between boxes in reading order (into and out of containers), Enter or
 * Space selects the box and sends focus to its toolbar. Escape from the
 * toolbar and Escape during a drag are in keyboard-escape.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Drag wiring is not under test here.
vi.mock('../gestures', () => ({ armBox: () => {}, cancelDrag: () => {} }));
vi.mock('../actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../actions')>()),
  select: vi.fn(),
}));
vi.mock('../view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../view')>()),
  render: vi.fn(),
  requestFocus: vi.fn(),
}));

import { renderResult } from '../result';
import { select } from '../actions';
import { requestFocus } from '../view';
import { bp } from '../state';
import type { LModel, LNode } from '../../lib/layout/types';

const widget = (id: string, colsL: number): LNode =>
  ({ id, rid: `r_${id}`, kind: 'widget', className: 'TextElement', name: id, cols: { L: colsL }, children: [] });
const container = (id: string, colsL: number, children: LNode[]): LNode =>
  ({ id, rid: `r_${id}`, kind: 'container', className: 'Container', name: id, cols: { L: colsL }, children });
const tab = (id: string, children: LNode[]): LNode =>
  ({ id, rid: `r_${id}`, kind: 'tab', className: 'Tab', name: id, cols: { L: 6 }, children });
const mdl = (tabs: LNode[]): LModel =>
  ({ pageId: 'sc1', tabsetId: 'ts1', pageClass: 'Scorecard', tabs, target: 'instance', hasTemplate: false });

// Reading order: the container, its two children, then the box after it.
const m = mdl([tab('t1', [container('A', 4, [widget('w1', 6), widget('w2', 3)]), widget('w3', 2)])]);
const byRid = new Map<string, Element>(['r_w1', 'r_w2', 'r_w3'].map(rid => [rid, document.createElement('div')]));

let layer: HTMLElement;
const cell = (id: string) => layer.querySelector<HTMLElement>(`.bp-rcell[data-bpid="${id}"]`)!;
const stops = () => Array.from(layer.querySelectorAll<HTMLElement>('.bp-rcell[tabindex="0"]')).map(c => c.dataset.bpid);
const press = (target: HTMLElement, key: string) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};
const focused = () => (document.activeElement as HTMLElement | null)?.dataset?.bpid;

function draw(): void {
  layer = document.createElement('div');
  document.body.appendChild(layer);
  expect(renderResult(m, m, byRid, layer)).toBe(true);
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 100, top: 50, right: 700, bottom: 300, width: 600, height: 250, x: 100, y: 50, toJSON: () => ({}) } as DOMRect);
  bp.selectedId = null;
  bp.viewTabId = null;
  bp.resultAnchor = null;
  bp.mode = 'layout';
  vi.mocked(select).mockClear();
  vi.mocked(requestFocus).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('Blueprint canvas: tab stop', () => {
  it('has exactly one tab stop, on the first box when nothing is selected', () => {
    draw();
    expect(stops()).toEqual(['A']);
    for (const c of layer.querySelectorAll<HTMLElement>('.bp-rcell[data-bpid]')) {
      if (c.dataset.bpid !== 'A') expect(c.tabIndex).toBe(-1);
    }
  });

  it('puts the tab stop on the selected box', () => {
    bp.selectedId = 'w2';
    draw();
    expect(stops()).toEqual(['w2']);
  });

  it('gives every box a role, its pressed state and a spoken name with type, name and width', () => {
    bp.selectedId = 'w1';
    draw();
    expect(cell('w1').getAttribute('role')).toBe('button');
    expect(cell('w1').getAttribute('aria-pressed')).toBe('true');
    expect(cell('w3').getAttribute('aria-pressed')).toBe('false');
    expect(cell('A').getAttribute('aria-label')).toBe('Container A, 4 col');
    expect(cell('w3').getAttribute('aria-label')).toBe('TextElement w3, 2 col');
  });
});

describe('Blueprint canvas: arrows in reading order', () => {
  it('ArrowDown and ArrowRight walk into the container and out of it', () => {
    draw();
    cell('A').focus();
    const order: Array<string | undefined> = [focused()];
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowDown']) {
      const e = press(document.activeElement as HTMLElement, key);
      expect(e.defaultPrevented).toBe(true);
      order.push(focused());
    }
    expect(order).toEqual(['A', 'w1', 'w2', 'w3']);
    // The tab stop moves with the focus (roving tab index).
    expect(stops()).toEqual(['w3']);
  });

  it('ArrowUp and ArrowLeft walk back', () => {
    draw();
    cell('w3').focus();
    press(cell('w3'), 'ArrowUp');
    expect(focused()).toBe('w2');
    press(cell('w2'), 'ArrowLeft');
    expect(focused()).toBe('w1');
    press(cell('w1'), 'ArrowUp');
    expect(focused()).toBe('A');
  });

  it('stays on the first and last box', () => {
    draw();
    cell('A').focus();
    press(cell('A'), 'ArrowUp');
    expect(focused()).toBe('A');
    cell('w3').focus();
    press(cell('w3'), 'ArrowDown');
    expect(focused()).toBe('w3');
  });

  it('leaves other keys and keys from inside a box control to the page', () => {
    draw();
    cell('A').focus();
    expect(press(cell('A'), 'a').defaultPrevented).toBe(false);
    const inner = document.createElement('button');
    cell('w1').appendChild(inner);
    expect(press(inner, 'ArrowDown').defaultPrevented).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});

describe('Blueprint canvas: Enter or Space', () => {
  it.each(['Enter', ' '])('%j selects the focused box and asks for the toolbar focus', (key) => {
    draw();
    cell('w2').focus();
    const e = press(cell('w2'), key);
    expect(e.defaultPrevented).toBe(true);
    expect(requestFocus).toHaveBeenCalledWith('toolbar');
    expect(select).toHaveBeenCalledWith('w2');
    // The focus request comes first, so the render that select() starts restores it.
    expect(vi.mocked(requestFocus).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(select).mock.invocationCallOrder[0]);
  });
});
