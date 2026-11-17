// @vitest-environment happy-dom
/**
 * Escape on the Blueprint keyboard path: from a box's toolbar back to the
 * box (the selection stays), and during a drag it cancels the drag and
 * nothing else (nothing staged, the box stays selected or unselected).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../view', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../view')>()),
  render: vi.fn(),
}));

import { onKeydown } from '../actions';
import { armBox, cancelGesture } from '../gestures';
import { bp } from '../state';

const escape = (target: Element) => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  onKeydown(e);
  return e;
};

let layer: HTMLElement;

function canvas(): { cell: HTMLElement; tool: HTMLButtonElement } {
  layer = document.createElement('div');
  layer.id = 'crev-blueprint-layer';
  const cell = document.createElement('div');
  cell.className = 'bp-rcell';
  cell.dataset.bpid = 'w1';
  cell.tabIndex = 0;
  const tools = document.createElement('div');
  tools.className = 'bp-tools';
  const tool = document.createElement('button');
  tool.textContent = 'Wider';
  tools.appendChild(tool);
  layer.append(cell, tools);
  document.body.appendChild(layer);
  bp.layer = layer;
  return { cell, tool };
}

beforeEach(() => {
  bp.active = true;
  bp.mode = 'layout';
  bp.selectedId = null;
  bp.dragging = false;
});

afterEach(() => {
  cancelGesture();
  bp.active = false;
  bp.layer = null;
  bp.selectedId = null;
  document.body.replaceChildren();
});

describe('Escape from the toolbar', () => {
  it('goes back to the selected box and keeps the selection', () => {
    const { cell, tool } = canvas();
    bp.selectedId = 'w1';
    tool.focus();
    expect(document.activeElement).toBe(tool);

    const e = escape(tool);

    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cell);
    expect(bp.selectedId).toBe('w1');
  });

  it('a second Escape, from the box, drops the selection', () => {
    const { cell } = canvas();
    bp.selectedId = 'w1';
    cell.focus();
    escape(cell);
    expect(bp.selectedId).toBeNull();
  });
});

describe('Escape during a drag', () => {
  it('cancels the drag: no ghost, no drop, the selection unchanged', () => {
    const { cell } = canvas();
    armBox(cell, 'w1');
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 80 }));
    expect(bp.dragging).toBe(true);
    expect(document.querySelector('.bp-ghost')).not.toBeNull();
    expect(cell.classList.contains('bp-dragsrc')).toBe(true);
    expect(layer.classList.contains('bp-dragging')).toBe(true);

    const e = escape(cell);

    expect(e.defaultPrevented).toBe(true);
    expect(bp.dragging).toBe(false);
    expect(document.querySelector('.bp-ghost,.bp-dropline,.bp-lands')).toBeNull();
    expect(cell.classList.contains('bp-dragsrc')).toBe(false);
    expect(layer.classList.contains('bp-dragging')).toBe(false);
    expect(layer.classList.contains('bp-nodrop')).toBe(false);
    expect(document.body.style.cursor).toBe('');
    // Only the drag was cancelled: the press did not turn into a selection.
    expect(bp.selectedId).toBeNull();

    // The released mouse finds no gesture any more: nothing is selected or staged.
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 80, clientY: 80 }));
    expect(bp.selectedId).toBeNull();
    expect(bp.history).toBeFalsy();
  });

  it('a selected box stays selected when its drag is cancelled', () => {
    const { cell } = canvas();
    bp.selectedId = 'w1';
    armBox(cell, 'w1');
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 80 }));
    expect(bp.dragging).toBe(true);
    escape(cell);
    expect(bp.dragging).toBe(false);
    expect(bp.selectedId).toBe('w1');
  });
});
