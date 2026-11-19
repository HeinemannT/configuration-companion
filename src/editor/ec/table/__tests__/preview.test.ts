import { describe, it, expect } from 'vitest'
import { parseTables } from '../model'
import {
  extractPreviewTable, mapColumns, columnStats, pickPreviewTable, compareToPreview, analysePreview,
  valuesForColumn, describeValues, footerText, type LastPreview,
} from '../preview'

const OUTPUT = `Result : OK
╔══════════════╦════════╦═══════╗
║ Risk         ║ Owner  ║ Score ║
╠══════════════╬════════╬═══════╣
║ Supplier     ║ Anna   ║ 25    ║
║ Data centre  ║ Ole    ║ 20    ║
║ Key person   ║        ║ 20    ║
╚══════════════╩════════╩═══════╝
Duration : 12ms`

const CODE = `_t := LIST().table()
  .addColumn("Risk", name)
  .addColumn("Owner", owner)
  .addColumn("Score", score).align("right")

_s.forEach(i:
  _t.addRow(i, i.name, i.owner, i.score)
)
_t`

const lastPreview = (code: string, text = OUTPUT): LastPreview => ({ code, text, at: 1000, durationMs: 600, mode: 'preview' })

describe('extractPreviewTable', () => {
  it('reuses the Output tab parser and trims cells', () => {
    const t = extractPreviewTable(OUTPUT)!
    expect(t.headers).toEqual(['Risk', 'Owner', 'Score'])
    expect(t.rows).toEqual([['Supplier', 'Anna', '25'], ['Data centre', 'Ole', '20'], ['Key person', '', '20']])
  })
  it('is null when there is no table (error output, plain text)', () => {
    expect(extractPreviewTable('Result : 5')).toBeNull()
    expect(extractPreviewTable('')).toBeNull()
  })
})

describe('mapColumns', () => {
  const cols = (src: string) => parseTables(src)[0].columns
  it('maps by position when counts agree', () => {
    expect(mapColumns(extractPreviewTable(OUTPUT)!, cols(CODE))).toEqual([0, 1, 2])
  })
  it('skips hidden columns when the output shows only the visible ones', () => {
    const code = CODE.replace('.addColumn("Owner", owner)', '.addColumn("Owner", owner).hidden()')
    const table = { headers: ['Risk', 'Score'], rows: [] }
    expect(mapColumns(table, cols(code))).toEqual([0, null, 1])
  })
  it('falls back to labels when counts differ', () => {
    const table = { headers: ['Score', 'Extra', 'Risk', 'Owner'], rows: [] }
    expect(mapColumns(table, cols(CODE))).toEqual([2, 3, 0])
  })
  it('refuses to guess otherwise', () => {
    expect(mapColumns({ headers: ['A', 'B'], rows: [] }, cols(CODE))).toBeNull()
    expect(mapColumns({ headers: [], rows: [] }, cols(CODE))).toBeNull()
  })
})

describe('columnStats', () => {
  it('counts empties, distinct values and samples', () => {
    const s = columnStats(['Open', 'Open', '', 'Closed'])
    expect(s).toMatchObject({ rows: 4, empty: 1, distinct: 2, sample: ['Open', 'Open', 'Closed'], allSame: false, range: null })
  })
  it('notices a single value everywhere', () => {
    expect(columnStats(['Open', 'Open', 'Open']).allSame).toBe(true)
    expect(columnStats(['Open']).allSame).toBe(false)
  })
  it('gives a range for numbers, keeping the printed form', () => {
    expect(columnStats(['25', '20', '4.5']).range).toEqual({ min: '4.5', max: '25' })
    expect(columnStats(['1,200', '300']).range).toEqual({ min: '300', max: '1,200' })
  })
  it('gives no range for mixed or empty columns', () => {
    expect(columnStats(['1', 'x']).range).toBeNull()
    expect(columnStats(['', '']).range).toBeNull()
  })
  it('text helpers follow the draft wording', () => {
    expect(describeValues(columnStats(['Open', 'Open', 'Open']))).toBe('Open · Open · Open · same value in all 3 rows')
    expect(describeValues(columnStats(['Anna', 'Ole', '', '']))).toBe('Anna · Ole · 2 empty')
    expect(footerText(columnStats(['25', '4']))).toBe('4 to 25')
    expect(footerText(columnStats(['a', '', 'b']))).toBe('1 empty')
    expect(footerText(columnStats(['a', 'b', 'c']))).toBe('3 values')
  })
})

describe('pickPreviewTable', () => {
  const two = parseTables(`_a := LIST().table().addColumn("A", a)
_b := LIST().table().addColumn("B", b)
_a`)
  it('prefers the table named by the last expression', () => {
    expect(pickPreviewTable('_a := x.table()\n_b := y.table()\n_a', two)).toBe(0)
  })
  it('falls back to the last table', () => {
    expect(pickPreviewTable('x\n// done\n', two)).toBe(1)
    expect(pickPreviewTable('', [])).toBe(-1)
  })
})

describe('staleness', () => {
  const fresh = (code: string): ReturnType<typeof compareToPreview> => {
    const prev = analysePreview(lastPreview(CODE))
    return compareToPreview(
      { text: code, tables: parseTables(code), target: 0 },
      { text: prev.preview.code, tables: prev.tables, target: prev.target },
    )
  }
  it('is fresh for identical text', () => {
    expect(fresh(CODE)).toEqual({ state: 'fresh' })
  })
  it('is fresh after whitespace and comment changes', () => {
    expect(fresh(CODE.replace('\n\n', '\n\n\n  // a comment\n'))).toEqual({ state: 'fresh' })
    expect(fresh(CODE.replace('.addColumn("Risk", name)', '.addColumn("Risk",    name)  // note'))).toEqual({ state: 'fresh' })
  })
  it('marks only the edited column when just its declaration changed', () => {
    const r = fresh(CODE.replace('.addColumn("Owner", owner)', '.addColumn("Owner", ownr)'))
    expect(r.state).toBe('columns')
    if (r.state === 'columns') expect([...r.changed]).toEqual([1])
  })
  it('flags a column whose chained modifiers changed', () => {
    const r = fresh(CODE.replace('.align("right")', '.align("left")'))
    expect(r.state).toBe('columns')
  })
  it('is stale when a column is added or removed', () => {
    expect(fresh(CODE.replace('\n  .addColumn("Score", score).align("right")', '')).state).toBe('stale')
  })
  it('is stale when anything that feeds the data changes', () => {
    expect(fresh(CODE.replace('item', 'x').replace('_s.forEach', '_z.forEach')).state).toBe('stale')
    expect(fresh(CODE.replace('i.name', 'i.title')).state).toBe('stale')
  })
})

describe('valuesForColumn', () => {
  const data = analysePreview(lastPreview(CODE))
  it('returns stats for a mapped column', () => {
    const v = valuesForColumn(data, 1, { state: 'fresh' })!
    expect(v.stale).toBe(false)
    expect(v.stats.sample).toEqual(['Anna', 'Ole'])
    expect(v.stats.empty).toBe(1)
  })
  it('hides values for edited columns and when stale', () => {
    expect(valuesForColumn(data, 1, { state: 'columns', changed: new Set([1]) })?.stale).toBe(true)
    expect(valuesForColumn(data, 0, { state: 'columns', changed: new Set([1]) })?.stale).toBe(false)
    expect(valuesForColumn(data, 0, { state: 'stale' })).toBeNull()
  })
  it('is null when the output could not be mapped', () => {
    const odd = analysePreview(lastPreview(CODE, OUTPUT.replace(' ║ Score ║', ' ║').replace(/ ║ 2\d {4}║/g, ' ║')))
    expect(valuesForColumn(odd, 0, { state: 'fresh' })).toBeNull()
  })
  it('analysePreview picks the table and maps it', () => {
    expect(data.target).toBe(0)
    expect(data.mapping).toEqual([0, 1, 2])
    expect(data.table?.rows).toHaveLength(3)
  })
})
