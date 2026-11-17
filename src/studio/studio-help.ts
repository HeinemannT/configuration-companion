/**
 * The studio's help: the `?` keyboard sheet (keys from the registry plus the
 * controls without keys) and the bottom panel's concept popover. Esc or an
 * outside click dismisses the popover.
 */
import { h } from '../lib/dom'
import type { CheatSheetOptions } from '../lib/cheat-sheet'
import { anchorPopover } from '../lib/popover-anchor'
import type { StudioMode } from '../lib/studio-mode'
import { escapeLayers } from '../lib/escape-layers'

function installDismissal(popover: HTMLElement, anchor: HTMLElement): void {
  anchor.setAttribute('aria-expanded', 'true')
  let unregister = () => {}
  const close = (event?: Event) => {
    if (event && popover.contains(event.target as Node)) return
    popover.remove()
    anchor.setAttribute('aria-expanded', 'false')
    document.removeEventListener('mousedown', close)
    unregister()
  }
  // Escape closes the popover before the studio (one layer at a time).
  escapeLayers().listen(document)
  unregister = escapeLayers().register({
    kind: 'popover', name: 'studio-panel-help', isOpen: () => popover.isConnected,
    close: () => { close(); anchor.focus() },
  })
  setTimeout(() => document.addEventListener('mousedown', close), 0)
}

/** The studio's `?` sheet: its keys from the registry (lib/shortcuts.ts),
 *  plus the controls that have no key, per mode. */
export function studioSheet(mode: StudioMode): CheatSheetOptions {
  const row = (keys: string, label: string) => ({ keys: [keys], label })
  const cvo = [
    { title: 'View', rows: [
      row('Wrap', 'Soft-wrap long lines so they stay in view, without changing the file'),
      row('Format', 'Reindent and reflow the active file (HTML or JavaScript)'),
      row('Code / Split / Preview', 'Show the editor only, both, or the preview only'),
      row('Full / 1280 / 768 / 375', 'Render the CVO at a container width to check responsiveness'),
      row('Drag the dividers', 'Resize the editor/preview split and the bottom panel'),
    ]},
    { title: 'Data', rows: [
      row('Mock / Live', 'Preview against local mock _data or real BMP data'),
      row('Context', 'The scorecard or page rid the live-data servlet is gated on'),
      row('Inputs', 'Add expression inputs, each exposed as _data.expressions.<key>'),
      row('Deps', 'Detected FileResource libraries + CDN URLs; host a file as a FileResource'),
    ]},
  ]
  const text = [
    { title: 'View', rows: [
      row('Wrap', 'Soft-wrap long lines so they stay in view, without changing the HTML'),
      row('Format', 'Reindent and reflow the active HTML field'),
      row('Code / Split / Preview', 'Show the editor only, both, or the preview only'),
      row('Full / 1280 / 768 / 375', 'Render at a container width to check responsive layout'),
      row('Drag the divider', 'Resize the editor/preview split'),
    ]},
    { title: 'Content', rows: [
      row('Static HTML', 'TextElements store sanitized content; scripts and event handlers are removed by BMP'),
      row('Preview', 'The preview is inert and cannot execute or navigate active content'),
      row('After save', 'The editor reloads the exact value BMP persisted and reports any sanitization'),
      row('Executable UI', 'Use a Custom Visualization when the content needs JavaScript'),
    ]},
  ]
  return { window: 'studio', title: `${mode.title}: keys and controls`, notes: mode.key === 'text' ? text : cvo }
}

/**
 * Explains the studio's bottom-panel concepts where they are encountered.
 * This deliberately stays separate from the shortcut reference: Inputs and
 * dependency hosting are product workflows, not keyboard commands.
 */
export function showStudioPanelHelp(anchor: HTMLElement): void {
  const existing = document.getElementById('studio-panel-help-popover')
  if (existing) {
    existing.remove()
    anchor.setAttribute('aria-expanded', 'false')
    return
  }

  const popover = h('div', {
    id: 'studio-panel-help-popover',
    class: 'studio-help-popover studio-panel-help-popover',
    role: 'dialog',
    'aria-label': 'Inputs and dependencies help',
    style: 'top:-9999px; left:-9999px;',
  },
    h('div', { class: 'studio-help-title' }, 'Inputs and dependencies'),
    h('section', { class: 'studio-panel-help-section' },
      h('h3', null, 'Inputs'),
      h('p', null, 'Inputs are child objects of this CVO. At render time BMP exposes them through _data, including expressions, tables, and connections.'),
      h('p', null, 'Add, Save, and Remove update the child objects in BMP. Mock values affect only your local preview; they are not saved as production data.'),
    ),
    h('section', { class: 'studio-panel-help-section' },
      h('h3', null, 'Deps'),
      h('p', null, 'Deps scans the current HTML and JavaScript for FileResource references and external CDN URLs. Re-render retries dependencies that previously failed.'),
      h('p', null, 'Host resource opens a local file picker. The selected file is created or updated as a FileResource under Resources > CREV Studio Assets, then the studio gives you a rid-based snippet to insert into the CVO.'),
      h('p', { class: 'studio-panel-help-note' }, 'CDN URLs require network access from the BMP browser. Host critical libraries as FileResources for air-gapped or restricted environments.'),
    ),
    h('div', { class: 'studio-help-footer' }, 'Press Esc to close'),
  )

  document.body.appendChild(popover)
  anchorPopover(popover, anchor)
  installDismissal(popover, anchor)
}
