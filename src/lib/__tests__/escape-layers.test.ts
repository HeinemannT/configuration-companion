/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';
import { EscapeLayers } from '../escape-layers';

const esc = (init: KeyboardEventInit = {}) => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });

afterEach(() => document.body.replaceChildren());

describe('Escape layers', () => {
  it('closes the innermost open layer first, one per press', () => {
    const layers = new EscapeLayers();
    const closed: string[] = [];
    const open = new Set(['window', 'peek', 'popover', 'menu']);
    for (const kind of ['window', 'peek', 'popover', 'menu'] as const) {
      layers.register({ kind, name: kind, isOpen: () => open.has(kind), close: () => { closed.push(kind); if (kind !== 'window') open.delete(kind); } });
    }
    layers.escape(); layers.escape(); layers.escape(); layers.escape();
    expect(closed).toEqual(['menu', 'popover', 'peek', 'window']);
  });

  it('asks the next layer out when one declines, and reports when none took the key', () => {
    const layers = new EscapeLayers();
    const order: string[] = [];
    layers.register({ kind: 'window', isOpen: () => true, close: () => { order.push('window'); return false; } });
    layers.register({ kind: 'peek', isOpen: () => true, close: () => { order.push('peek'); return false; } });
    expect(layers.escape()).toBe(false);
    expect(order).toEqual(['peek', 'window']);
  });

  it('asks the layer registered last first within one kind', () => {
    const layers = new EscapeLayers();
    const order: string[] = [];
    layers.register({ kind: 'input', name: 'query', isOpen: () => true, close: () => { order.push('query'); } });
    layers.register({ kind: 'input', name: 'running', isOpen: () => true, close: () => { order.push('running'); } });
    layers.escape();
    expect(order).toEqual(['running']);
  });

  it('skips closed and removed layers', () => {
    const layers = new EscapeLayers();
    const order: string[] = [];
    const off = layers.register({ kind: 'dialog', isOpen: () => true, close: () => { order.push('dialog'); } });
    layers.register({ kind: 'menu', isOpen: () => false, close: () => { order.push('menu'); } });
    layers.register({ kind: 'window', isOpen: () => true, close: () => { order.push('window'); } });
    off();
    layers.escape();
    expect(order).toEqual(['window']);
  });

  it('handles Escape only: not other keys, not composing, not keys already used', () => {
    const layers = new EscapeLayers();
    let n = 0;
    layers.register({ kind: 'window', isOpen: () => true, close: () => { n++; } });
    expect(layers.handle(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
    expect(layers.handle(esc({ isComposing: true }))).toBe(false);
    const used = esc(); used.preventDefault();
    expect(layers.handle(used)).toBe(false);
    const e = esc();
    expect(layers.handle(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(n).toBe(1);
  });

  it('asks capture layers before the focused element and bubble layers only when it left the key alone', () => {
    const layers = new EscapeLayers();
    const order: string[] = [];
    let menuOpen = true;
    layers.register({ kind: 'menu', phase: 'capture', isOpen: () => menuOpen, close: () => { menuOpen = false; order.push('menu'); } });
    layers.register({ kind: 'window', isOpen: () => true, close: () => { order.push('window'); } });
    const stop = layers.listen(document);
    const field = document.createElement('input');
    let fieldUsesEscape = false;
    field.addEventListener('keydown', e => { if (fieldUsesEscape) { e.preventDefault(); order.push('field'); } });
    document.body.append(field);

    field.dispatchEvent(esc());          // menu (capture) wins; nothing else
    fieldUsesEscape = true;
    field.dispatchEvent(esc());          // the field uses it; the window stays
    fieldUsesEscape = false;
    field.dispatchEvent(esc());          // nobody inside: the window closes
    stop();
    expect(order).toEqual(['menu', 'field', 'window']);
  });

  it('listens once per stack', () => {
    const layers = new EscapeLayers();
    let n = 0;
    layers.register({ kind: 'window', isOpen: () => true, close: () => { n++; } });
    const a = layers.listen(document);
    const b = layers.listen(document);
    document.body.dispatchEvent(esc());
    a(); b();
    expect(n).toBe(1);
  });
});
