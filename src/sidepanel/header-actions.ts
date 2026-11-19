/**
 * The header's four main actions, right of the server switcher.
 *
 * Three page modes (Inspect, Blueprint, Point and tell): toggles on the live
 * BMP page, one on at a time, drawn as a segmented group whose pressed item
 * is filled. Then Extended Code: it opens the editor, so it is a plain
 * button with its own outline, never pressed. Everything else the panel
 * launches lives in the Utilities tab (tabs/utilities-tab.ts).
 *
 * Icons only in a narrow panel; icon and name when the header is wide enough
 * (shell.css, the `sp-header` container).
 */

import { h } from '../lib/dom';
import { withShortcut } from '../lib/shortcuts';
import { icon } from './icons';

/** What the buttons read from the panel's state. */
export interface PrimaryActionsState {
  inspectActive: boolean;
  blueprintActive: boolean;
  /** Point and tell is on (POINT_TELL_STATE). */
  pointTellActive: boolean;
  /** False for a BMP version without Blueprint. */
  blueprintSupported: boolean;
  /** Whether the window's tab is a BMP page; null while unknown. */
  bmpDetected: boolean | null;
}

export const BLUEPRINT_TITLE = 'Toggle the blueprint layout editor overlay on the live BMP page';
export const BLUEPRINT_UNSUPPORTED_TITLE = 'Blueprint requires BMP 5.6.3 or newer';
export const NO_PAGE_TITLE = 'Open a BMP page to inspect its layout';

const modeTitle = (what: string, shortcut: Parameters<typeof withShortcut>[1] | null) =>
  shortcut ? `${withShortcut(what, shortcut)}. Rebind at chrome://extensions/shortcuts` : what;

function actionButton(cls: string, id: string, iconId: string, name: string, title: string, pressed: boolean | null): HTMLElement {
  return h('button', {
    class: `ui-ibtn ${cls}`,
    id,
    type: 'button',
    'aria-label': name,
    ...(pressed == null ? {} : { 'aria-pressed': pressed ? 'true' : 'false' }),
    title,
  }, icon(iconId), h('span', { class: 'hdr-lbl', 'aria-hidden': 'true' }, name));
}

/** The group: the three modes, then Extended Code. */
export function buildPrimaryActions(state: PrimaryActionsState): HTMLElement {
  const root = h('div', { class: 'hdr-actions' },
    h('div', { class: 'hdr-modes', role: 'group', 'aria-label': 'Page modes' },
      actionButton('hdr-mode inspect-toggle', 'toggle-inspect', 's-crosshair', 'Inspect',
        modeTitle('Toggle inspect overlays', 'browser.inspect'), state.inspectActive),
      actionButton('hdr-mode blueprint-toggle', 'toggle-blueprint', 's-blueprint', 'Blueprint',
        BLUEPRINT_TITLE, state.blueprintActive),      // Point and tell: the page side is built separately; until it answers (POINT_TELL_STATE) this stays unpressed.
      actionButton('hdr-mode point-tell-toggle', 'toggle-point-tell', 's-pointtell', 'Point and tell',
        'Point at something on the page and tell Companion about it', state.pointTellActive),
    ),
    actionButton('hdr-act', 'open-extended', 'k-braces', 'Extended Code',
      modeTitle('Open the Extended Code editor', 'browser.extended'), null),
  );
  applyPrimaryActions(root, state);
  return root;
}

/** Bring the buttons in line with the state (pressed, disabled, dimmed). */
export function applyPrimaryActions(root: ParentNode, state: PrimaryActionsState): void {
  const press = (id: string, on: boolean) => {
    const b = root.querySelector<HTMLElement>(`#${id}`);
    if (!b) return;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  press('toggle-inspect', state.inspectActive);
  press('toggle-blueprint', state.blueprintActive);
  press('toggle-point-tell', state.pointTellActive);

  const bp = root.querySelector<HTMLButtonElement>('#toggle-blueprint');
  if (bp) {
    bp.disabled = !state.blueprintSupported;
    bp.title = state.blueprintSupported ? BLUEPRINT_TITLE : BLUEPRINT_UNSUPPORTED_TITLE;
  }
  const modes = root.querySelector<HTMLElement>('.hdr-modes');
  if (modes) {
    modes.classList.toggle('no-page', state.bmpDetected === false);
    modes.title = state.bmpDetected === false ? NO_PAGE_TITLE : '';
  }
}
