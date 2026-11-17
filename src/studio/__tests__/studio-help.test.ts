/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest'
import { studioSheet } from '../studio-help'
import { STUDIO_MODES } from '../../lib/studio-mode'
import { closeCheatSheet, openCheatSheet } from '../../lib/cheat-sheet'
import { setPlatformForTests } from '../../lib/shortcuts'

afterEach(() => {
  closeCheatSheet()
  setPlatformForTests(null)
  document.body.replaceChildren()
})

describe('studio keyboard sheet', () => {
  it('explains TextElement sanitization and points executable content to CVOs', () => {
    openCheatSheet(studioSheet(STUDIO_MODES.text))
    const help = document.querySelector('.ui-keys')
    expect(help?.textContent).toContain('Text studio: keys and controls')
    expect(help?.textContent).toContain('scripts and event handlers are removed by BMP')
    expect(help?.textContent).toContain('Use a Custom Visualization')
    expect(help?.textContent).not.toContain('Mock / Live')
  })

  it('keeps the CVO-specific data guidance in CVO mode', () => {
    openCheatSheet(studioSheet(STUDIO_MODES.cvo))
    const help = document.querySelector('.ui-keys')
    expect(help?.textContent).toContain('CVO studio: keys and controls')
    expect(help?.textContent).toContain('Mock / Live')
  })

  it('lists the studio keys from the registry: Re-render on Ctrl+Enter, Format on Alt+Shift+F', () => {
    setPlatformForTests('other')
    openCheatSheet(studioSheet(STUDIO_MODES.cvo))
    const rows = [...document.querySelectorAll('.ui-keys dt')].map(dt => `${dt.textContent} = ${dt.nextElementSibling?.textContent}`)
    expect(rows).toContain('Ctrl+Enter = Re-render the preview')
    expect(rows).toContain('Alt+Shift+F = Format the active file')
    expect(rows).toContain('Ctrl+S = Save every changed field')
  })
})
