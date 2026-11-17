/**
 * The preview's data switch (Mock / Live). Live data is real server data read
 * with the stored identity and handed to the CVO code being previewed, so it is
 * only ever chosen by the user: the studio starts every window on mock data,
 * the choice is not stored, and the only path to live is this switch.
 */
import { h } from '../lib/dom'

export type PreviewDataMode = 'mock' | 'live'

/** The sentence shown next to the switch. */
export const LIVE_DATA_NOTICE = 'With Live, the preview code receives real data from the server.'

/** The Mock / Live switch and its notice. `onChoose` runs only from a click. */
export function dataModeSwitch(mode: PreviewDataMode, onChoose: (mode: PreviewDataMode) => void): HTMLElement[] {
  const live = mode === 'live'
  return [
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Preview data' },
      h('button', { class: `seg-btn${!live ? ' active' : ''}`, 'data-mode': 'mock', title: 'Render against local mock _data', 'aria-pressed': !live ? 'true' : 'false', onClick: () => onChoose('mock') }, 'Mock'),
      h('button', { class: `seg-btn${live ? ' active' : ''}`, 'data-mode': 'live', title: 'Render against real BMP _data for the render context', 'aria-pressed': live ? 'true' : 'false', onClick: () => onChoose('live') }, 'Live'),
    ),
    h('span', { class: 'studio-strip-hint studio-live-notice' }, LIVE_DATA_NOTICE),
  ]
}
