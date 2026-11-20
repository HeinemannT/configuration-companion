// @vitest-environment happy-dom
/**
 * The pointer surface with a tool that may hold: a still press starts voice and listens until it ends; a press that
 * moves is a stroke; a short one is a click; a cancel or the window losing focus ends a hold. Mouse, pen and touch alike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_TO_TALK_MS } from '../../lib/point-tell/press-hold';
import { installSurface, releasePointer, type PtTool } from '../pointer';

let holdable = true;
const makeTool = () => ({
  id: 'test', cursor: vi.fn(() => 'crosshair'), hover: vi.fn(), leave: vi.fn(),
  strokeStart: vi.fn(), strokeMove: vi.fn(), strokeEnd: vi.fn(), strokeCancel: vi.fn(), click: vi.fn(),
  holdable: vi.fn(() => holdable), holdDisarm: vi.fn(), holdStart: vi.fn((_p: unknown) => true), holdEnd: vi.fn(),
});
let surface: HTMLElement;
let tool: ReturnType<typeof makeTool>;

function setup(): void {
  document.body.innerHTML = '';
  const layer = document.createElement('div');
  document.body.appendChild(layer);
  tool = makeTool();
  surface = installSurface(layer, tool as PtTool);
}

const fire = (type: string, x: number, y: number, pointerType = 'mouse') =>
  surface.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 7, pointerType, button: 0 }));

beforeEach(() => { vi.useFakeTimers(); holdable = true; setup(); });
afterEach(() => { releasePointer(); vi.useRealTimers(); });

describe('a still press with voice comments on', () => {
  for (const kind of ['mouse', 'pen', 'touch']) {
    it(`(${kind}) starts voice at the point after the time, ignores movement, and ends on release`, () => {
      fire('pointerdown', 200, 150, kind);
      expect(tool.holdable).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(HOLD_TO_TALK_MS - 10);
      expect(tool.holdStart).not.toHaveBeenCalled();
      fire('pointermove', 201, 151, kind);
      vi.advanceTimersByTime(10);
      expect(tool.holdStart).toHaveBeenCalledTimes(1);
      expect(tool.holdStart.mock.calls[0][0]).toMatchObject({ cx: 200, cy: 150 });
      // Speaking with the hand moving: no stroke, no ink.
      fire('pointermove', 260, 190, kind);
      expect(tool.strokeStart).not.toHaveBeenCalled();
      fire('pointerup', 260, 190, kind);
      expect(tool.holdEnd).toHaveBeenCalledTimes(1);
      expect(tool.click).not.toHaveBeenCalled();
      expect(tool.strokeEnd).not.toHaveBeenCalled();
    });
  }

  it('a press that moves before the time is an ordinary stroke and voice never starts', () => {
    fire('pointerdown', 200, 150);
    vi.advanceTimersByTime(300);
    fire('pointermove', 210, 150);
    expect(tool.holdDisarm).toHaveBeenCalledTimes(1);
    expect(tool.strokeStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(tool.holdStart).not.toHaveBeenCalled();
    fire('pointerup', 230, 160);
    expect(tool.strokeEnd).toHaveBeenCalledTimes(1);
    expect(tool.holdEnd).not.toHaveBeenCalled();
  });

  it('a short press is a click, as before', () => {
    fire('pointerdown', 200, 150);
    vi.advanceTimersByTime(150);
    fire('pointerup', 200, 150);
    expect(tool.click).toHaveBeenCalledTimes(1);
    expect(tool.holdDisarm).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(tool.holdStart).not.toHaveBeenCalled();
  });

  it('a cancelled pointer ends the hold', () => {
    fire('pointerdown', 200, 150);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    fire('pointercancel', 200, 150);
    expect(tool.holdEnd).toHaveBeenCalledTimes(1);
    fire('pointerup', 200, 150);
    expect(tool.holdEnd).toHaveBeenCalledTimes(1);
    expect(tool.click).not.toHaveBeenCalled();
  });

  it('the window losing focus ends the hold; while charging it drops the press', () => {
    fire('pointerdown', 200, 150);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    window.dispatchEvent(new Event('blur'));
    expect(tool.holdEnd).toHaveBeenCalledTimes(1);
    fire('pointerdown', 200, 150);
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event('blur'));
    expect(tool.holdDisarm).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS);
    expect(tool.holdStart).toHaveBeenCalledTimes(1);
    fire('pointerup', 200, 150);
    expect(tool.click).not.toHaveBeenCalled();
  });

  it('a hold the tool does not take goes on as a click', () => {
    tool.holdStart.mockReturnValue(false);
    fire('pointerdown', 200, 150);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS + 200);
    fire('pointerup', 200, 150);
    expect(tool.click).toHaveBeenCalledTimes(1);
    expect(tool.holdEnd).not.toHaveBeenCalled();
  });
});

describe('with voice comments off', () => {
  it('a long still press does nothing new: it is a click', () => {
    holdable = false;
    fire('pointerdown', 200, 150);
    vi.advanceTimersByTime(HOLD_TO_TALK_MS * 3);
    expect(tool.holdStart).not.toHaveBeenCalled();
    fire('pointerup', 200, 150);
    expect(tool.click).toHaveBeenCalledTimes(1);
    expect(tool.holdDisarm).not.toHaveBeenCalled();
  });
});
