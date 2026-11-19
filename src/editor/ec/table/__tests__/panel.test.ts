/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest'
import { parseTables } from '../model'
import { analysePreview, compareToPreview } from '../preview'
import { renderTablePanel, panelSignature, type TablePanelInput } from '../panel'

const CODE = `_t := LIST().table()
  .addColumn("Risk", name)
  .addColumn("Owner", owner)
  .addColumn("Score", score)
_s.forEach(i: _t.addRow(i, i.name, i.owner, i.score))
_t`

const OUTPUT = `╔══════╦═══════╦═══════╗
║ Risk ║ Owner ║ Score ║
╠══════╬═══════╬═══════╣
║ A    ║ Anna  ║ 25    ║
║ B    ║       ║ 4     ║
╚══════╩═══════╩═══════╝`

function input(over: Partial<TablePanelInput> & { code?: string } = {}): TablePanelInput {
  const code = over.code ?? CODE
  const preview = analysePreview({ code: CODE, text: OUTPUT, at: 1000, durationMs: 600, mode: 'preview' })
  const tables = parseTables(code)
  const freshness = compareToPreview(
    { text: code, tables, target: 0 },
    { text: preview.preview.code, tables: preview.tables, target: preview.target },
  )
  return { preview, freshness, tables, target: 0, cursor: 0, onPreview: vi.fn(), onJump: vi.fn(), ...over }
}

describe('renderTablePanel', () => {
  it('offers Preview when there is no preview yet', () => {
    const onPreview = vi.fn()
    const el = renderTablePanel(input({ preview: null, freshness: null, onPreview }))
    expect(el.textContent).toContain('No preview of a table yet')
    el.querySelector('button')!.click()
    expect(onPreview).toHaveBeenCalled()
  })

  it('draws the grid with the property under each header and a footer per column', () => {
    const el = renderTablePanel(input())
    expect([...el.querySelectorAll('thead .cm-tbl-th-label')].map(e => e.textContent)).toEqual(['Risk', 'Owner', 'Score'])
    expect([...el.querySelectorAll('thead .cm-tbl-th-prop')].map(e => e.textContent)).toEqual(['name', 'owner', 'score'])
    expect([...el.querySelectorAll('tbody tr')]).toHaveLength(2)
    expect([...el.querySelectorAll('tfoot td')].map(e => e.textContent)).toEqual(['2 values', '1 empty', '4 to 25'])
    expect(el.textContent).toContain('2 rows')
  })

  it('highlights the column of the cursor line and jumps on click', () => {
    const cursor = CODE.indexOf('"Owner"')
    const onJump = vi.fn()
    const el = renderTablePanel(input({ cursor, onJump }))
    const active = el.querySelectorAll('.cm-tbl-col-active')
    expect(active.length).toBe(1 + 2 + 1) // header, two body cells, footer
    expect(el.querySelector('thead th.cm-tbl-col-active .cm-tbl-th-label')!.textContent).toBe('Owner')
    ;(el.querySelectorAll('thead th')[2] as HTMLElement).click()
    expect(onJump).toHaveBeenCalledWith(CODE.indexOf('addColumn("Score"'))
  })

  it('also follows the cursor inside an addRow value', () => {
    const el = renderTablePanel(input({ cursor: CODE.indexOf('i.score') + 2 }))
    expect(el.querySelector('thead th.cm-tbl-col-active .cm-tbl-th-label')!.textContent).toBe('Score')
  })

  it('stops highlighting and jumping when the code changed in a way that could change the data', () => {
    const edited = CODE.replace('i.name', 'i.title')
    const onJump = vi.fn()
    const el = renderTablePanel(input({ code: edited, cursor: edited.indexOf('"Owner"'), onJump }))
    expect(el.querySelector('.cm-tbl-col-active')).toBeNull()
    expect(el.textContent).toContain('The code changed after this preview')
    ;(el.querySelectorAll('thead th')[1] as HTMLElement).click()
    expect(onJump).not.toHaveBeenCalled()
  })

  it('caps the drawn rows but keeps the footers about all of them', () => {
    const rows = Array.from({ length: 700 }, (_, i) => `║ r${i} ║ x ║ ${i} ║`).join('\n')
    const out = `╔═╦═╦═╗\n║ Risk ║ Owner ║ Score ║\n╠═╬═╬═╣\n${rows}\n╚═╩═╩═╝`
    const preview = analysePreview({ code: CODE, text: out, at: 1, durationMs: null, mode: 'preview' })
    const el = renderTablePanel(input({ preview }))
    expect(el.querySelectorAll('tbody tr').length).toBe(501)
    expect(el.querySelector('.cm-tbl-more')!.textContent).toContain('first 500 of 700')
    expect(el.querySelectorAll('tfoot td')[2].textContent).toBe('0 to 699')
  })
})

describe('panelSignature', () => {
  it('changes with the highlighted column, not with every cursor move', () => {
    const a = panelSignature(input({ cursor: CODE.indexOf('"Owner"') }))
    const b = panelSignature(input({ cursor: CODE.indexOf('"Owner"') + 3 }))
    const c = panelSignature(input({ cursor: CODE.indexOf('"Score"') }))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
