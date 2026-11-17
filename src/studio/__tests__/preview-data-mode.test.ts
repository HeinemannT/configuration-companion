/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { dataModeSwitch, LIVE_DATA_NOTICE } from '../preview-data-mode'

describe('live data is an explicit act', () => {
  it('shows the notice next to the switch and chooses live only from a click', () => {
    const choose = vi.fn()
    const els = dataModeSwitch('mock', choose)
    const strip = document.createElement('div')
    strip.append(...els)
    expect(strip.textContent).toContain(LIVE_DATA_NOTICE)
    expect(LIVE_DATA_NOTICE).toMatch(/preview code receives real data/)
    expect(choose).not.toHaveBeenCalled()
    strip.querySelector<HTMLButtonElement>('[data-mode="live"]')!.click()
    expect(choose).toHaveBeenCalledWith('live')
    expect(dataModeSwitch('live', choose)[0].querySelector('[data-mode="live"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('starts every studio window on mock data, and only the switch chooses live', () => {
    const src = readFileSync(join(__dirname, '..', 'studio.ts'), 'utf8')
    expect(src).toMatch(/let dataMode: PreviewDataMode = 'mock'/)
    // No code path sets live by itself: no literal live assignment or call.
    expect(src).not.toMatch(/dataMode\s*=\s*'live'/)
    expect(src).not.toMatch(/setDataMode\(\s*'live'\s*\)/)
    // The choice is not persisted.
    expect(src).not.toMatch(/storage[^\n]*dataMode|dataMode[^\n]*storage/)
  })
})
