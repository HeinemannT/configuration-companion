/**
 * @vitest-environment happy-dom
 *
 * The header's four main actions: three page modes that toggle (Inspect,
 * Blueprint, Point and tell) and Extended Code, which opens the editor and
 * never shows pressed.
 */
import { describe, expect, it } from 'vitest';
import { applyPrimaryActions, buildPrimaryActions, BLUEPRINT_UNSUPPORTED_TITLE, NO_PAGE_TITLE, type PrimaryActionsState } from '../header-actions';

const state = (change: Partial<PrimaryActionsState> = {}): PrimaryActionsState => ({
  inspectActive: false, blueprintActive: false, pointTellActive: false, blueprintSupported: true, bmpDetected: true, ...change,
});
const button = (root: ParentNode, id: string) => root.querySelector<HTMLButtonElement>(`#${id}`)!;

describe('header actions', () => {
  it('are exactly four: the page modes in one group, then Extended Code', () => {
    const root = buildPrimaryActions(state());
    const modes = root.querySelector('.hdr-modes')!;
    expect(modes.getAttribute('role')).toBe('group');
    expect([...modes.children].map(b => b.id)).toEqual(['toggle-inspect', 'toggle-blueprint', 'toggle-point-tell']);
    expect([...root.querySelectorAll('button')].map(b => b.id)).toEqual(['toggle-inspect', 'toggle-blueprint', 'toggle-point-tell', 'open-extended']);
    expect([...root.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))).toEqual(['Inspect', 'Blueprint', 'Point and tell', 'Extended Code']);
  });

  it('draws an icon and a name in every button; the name is for the wide header only', () => {
    const root = buildPrimaryActions(state());
    for (const b of root.querySelectorAll('button')) {
      expect(b.querySelector('svg.ic use')?.getAttribute('href'), b.id).toMatch(/^#/);
      const name = b.querySelector('.hdr-lbl')!;
      expect(name.textContent).toBe(b.getAttribute('aria-label'));
      // The button's accessible name is the label, so the visible name is not read twice.
      expect(name.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('uses the icons chosen for them', () => {
    const root = buildPrimaryActions(state());
    const icons = Object.fromEntries([...root.querySelectorAll('button')].map(b => [b.id, b.querySelector('use')!.getAttribute('href')]));
    expect(icons).toEqual({
      'toggle-inspect': '#s-crosshair', 'toggle-blueprint': '#s-blueprint', 'toggle-point-tell': '#s-pointtell', 'open-extended': '#k-braces',
    });
  });

  it('shows the three modes pressed from the state, and Extended Code never pressed', () => {
    const root = buildPrimaryActions(state({ inspectActive: true, pointTellActive: true }));
    expect(button(root, 'toggle-inspect').getAttribute('aria-pressed')).toBe('true');
    expect(button(root, 'toggle-blueprint').getAttribute('aria-pressed')).toBe('false');
    expect(button(root, 'toggle-point-tell').getAttribute('aria-pressed')).toBe('true');
    expect(button(root, 'toggle-point-tell').classList.contains('active')).toBe(true);
    // An action, not a mode: no pressed state at all, and not in the mode group.
    const extended = button(root, 'open-extended');
    expect(extended.hasAttribute('aria-pressed')).toBe(false);
    expect(extended.classList.contains('hdr-mode')).toBe(false);
    expect(extended.closest('.hdr-modes')).toBeNull();
    applyPrimaryActions(root, state({ inspectActive: true, blueprintActive: true, pointTellActive: true }));
    expect(extended.hasAttribute('aria-pressed')).toBe(false);
    expect(extended.classList.contains('active')).toBe(false);
  });

  it('follows the state when it changes: Point and tell is pressed only once the page says so', () => {
    const root = buildPrimaryActions(state());
    expect(button(root, 'toggle-point-tell').getAttribute('aria-pressed')).toBe('false');
    applyPrimaryActions(root, state({ pointTellActive: true }));
    expect(button(root, 'toggle-point-tell').getAttribute('aria-pressed')).toBe('true');
    applyPrimaryActions(root, state({ pointTellActive: false }));
    expect(button(root, 'toggle-point-tell').getAttribute('aria-pressed')).toBe('false');
  });

  it('disables Blueprint, with the reason, on a BMP version without it', () => {
    const root = buildPrimaryActions(state({ blueprintSupported: false }));
    expect(button(root, 'toggle-blueprint').disabled).toBe(true);
    expect(button(root, 'toggle-blueprint').title).toBe(BLUEPRINT_UNSUPPORTED_TITLE);
    expect(button(root, 'toggle-inspect').disabled).toBe(false);
    applyPrimaryActions(root, state());
    expect(button(root, 'toggle-blueprint').disabled).toBe(false);
  });

  it('dims the modes, and says why, when the window shows no BMP page', () => {
    const root = buildPrimaryActions(state({ bmpDetected: false }));
    const modes = root.querySelector<HTMLElement>('.hdr-modes')!;
    expect(modes.classList.contains('no-page')).toBe(true);
    expect(modes.title).toBe(NO_PAGE_TITLE);
    applyPrimaryActions(root, state({ bmpDetected: null }));
    expect(modes.classList.contains('no-page')).toBe(false);
    expect(modes.title).toBe('');
  });

  it('names the keys of Inspect and Extended Code in their tooltips', () => {
    const root = buildPrimaryActions(state());
    expect(button(root, 'toggle-inspect').title).toMatch(/Ctrl\+Shift\+X|⇧⌘X|Shift\+X/);
    expect(button(root, 'open-extended').title).toMatch(/Open the Extended Code editor/);
  });
});
