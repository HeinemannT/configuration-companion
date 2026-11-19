import { describe, it, expect } from 'vitest'
import { parseTables, maskCode, tableAt, activeColumn, stringLiteral } from '../model'

const ROW_BY_ROW = `_risks := SELECT CeRiskAssessment WHERE ermq_status = "Open"

_t := LIST().table()
  .addColumn("Risk", name)
  .addColumn("Owner", ermq_owner)
  .addColumn("Inherent", ermq_inherent_score).align("right")
  .addColumn("Residual", ermq_residual_score).align("right").decimals(1)

_risks.forEach(item:
  _t.addRow(item, item.name, item.ermq_owner, item.ermq_inherent_score,
            item.ermq_residual_score)
)
_t`

const HIERARCHY = `_t := LIST().table()
  .addColumn("Name", name)
  .addColumn("Owner", owner)

this.children.forEach(unit:
  _t.addRow(unit, unit.name, unit.owner)
  unit.children.forEach(team:
    _t.addRow(team, team.name, team.owner).indent(1).collapse()
    (SELECT CeRiskAssessment WHERE ermq_entity = team).forEach(risk:
      _t.addRow(risk, risk.name, risk.ermq_owner).indent(3).collapse()
    )
  )
)
_t`

describe('maskCode', () => {
  it('keeps length and newlines, blanks strings and comments', () => {
    const src = 'a := "x(y)" // note (\n/* b\n) */ c'
    const m = maskCode(src)
    expect(m.length).toBe(src.length)
    expect(m.split('\n').length).toBe(src.split('\n').length)
    expect(m).not.toContain('x(y)')
    expect(m).not.toContain('note')
    expect(m.indexOf('c')).toBe(src.lastIndexOf('c'))
  })
  it('ends an unclosed string at the line break', () => {
    const m = maskCode('a := "oops\nb := 1')
    expect(m).toContain('b := 1')
  })
})

describe('stringLiteral', () => {
  it('decodes quotes and rejects non-literals', () => {
    expect(stringLiteral('"Risk"')).toBe('Risk')
    expect(stringLiteral(`'a\\'b'`)).toBe("a'b")
    expect(stringLiteral('name')).toBeNull()
    expect(stringLiteral('"open')).toBeNull()
  })
})

describe('parseTables: shape args', () => {
  it('reads X.table(a, b)', () => {
    const [t] = parseTables('_q := SELECT CeRisk\n_q.table(name, ermq_status)')
    expect(t.shape).toBe('args')
    expect(t.sourceText).toBe('_q')
    expect(t.columns.map(c => c.propIdent)).toEqual(['name', 'ermq_status'])
    expect(t.columns[0].line).toBe(2)
  })
  it('skips a leading title string', () => {
    const [t] = parseTables('_q.table("Risks", name, owner)')
    expect(t.columns.map(c => c.prop)).toEqual(['name', 'owner'])
  })
  it('treats a lone string as a title, not a column', () => {
    const [t] = parseTables('_q.table("Risks")')
    expect(t.columns).toHaveLength(0)
  })
  it('works for an inline SELECT receiver', () => {
    const [t] = parseTables('(SELECT CeRisk WHERE a = 1).table(name)')
    expect(t.sourceText).toBe('(SELECT CeRisk WHERE a = 1)')
    expect(t.columns[0].propIdent).toBe('name')
  })
})

describe('parseTables: shape columns', () => {
  const src = `_q := SELECT CeRisk
_t := _q.table()
  .addColumn("Name", name)
  .addColumn("Score", score).align("right").decimals(1)
  .addColumn(owner).hidden()
_t`
  it('reads labels, props and chained modifiers', () => {
    const [t] = parseTables(src)
    expect(t.shape).toBe('columns')
    expect(t.varName).toBe('_t')
    expect(t.sourceText).toBe('_q')
    expect(t.columns).toHaveLength(3)
    expect(t.columns[0]).toMatchObject({ label: 'Name', propIdent: 'name', line: 3, complete: true })
    expect(t.columns[1]).toMatchObject({ label: 'Score', propIdent: 'score', hasAlign: true, align: 'right' })
    expect(t.columns[1].chain.map(c => c.name)).toEqual(['align', 'decimals'])
    expect(t.columns[2]).toMatchObject({ label: null, propIdent: 'owner', hidden: true })
  })
  it('reports the lens line at the assignment', () => {
    const [t] = parseTables(src)
    expect(t.lensLine).toBe(2)
    expect(t.lensFrom).toBe(src.indexOf('_t :='))
  })
  it('column ranges start at the dot and end after the last chained call', () => {
    const [t] = parseTables(src)
    const c = t.columns[1]
    expect(src.slice(c.from, c.to)).toBe('.addColumn("Score", score).align("right").decimals(1)')
  })
  it('handles a table on a continuation line', () => {
    const [t] = parseTables('_t := _q\n  .table()\n  .addColumn("A", a)')
    expect(t.sourceText).toBe('_q')
    expect(t.columns).toHaveLength(1)
  })
})

describe('parseTables: shape rows', () => {
  it('links addRow calls and the forEach source', () => {
    const [t] = parseTables(ROW_BY_ROW)
    expect(t.shape).toBe('rows')
    expect(t.sourceIsList).toBe(true)
    expect(t.sourceText).toBeNull()
    expect(t.columns).toHaveLength(4)
    expect(t.rows).toHaveLength(1)
    const r = t.rows[0]
    expect(r.rowVar).toBe('item')
    expect(r.values.map(v => v.text)).toEqual(['item.name', 'item.ermq_owner', 'item.ermq_inherent_score', 'item.ermq_residual_score'])
    expect(r.complete).toBe(true)
    expect(r.forEach?.receiverText).toBe('_risks')
    expect(r.forEach?.param).toBe('item')
    expect(r.level).toBe(0)
    expect(t.levels).toHaveLength(1)
    expect(t.levels[0].level).toBe(0)
  })
  it('keeps multi-line addRow values together', () => {
    const [t] = parseTables(ROW_BY_ROW)
    expect(t.rows[0].values).toHaveLength(4)
    expect(t.rows[0].call.args[0].text).toBe('item')
  })
  it('ignores addRow on a different variable', () => {
    const [t] = parseTables('_t := LIST().table()\n  .addColumn("A", a)\n_x.addRow(i, i.a)')
    expect(t.rows).toHaveLength(0)
  })
  it('assigns rows to the nearest preceding table with that variable', () => {
    const tables = parseTables(`_t := LIST().table().addColumn("A", a)
_s.forEach(i: _t.addRow(i, i.a))
_t := LIST().table().addColumn("B", b)
_s.forEach(i: _t.addRow(i, i.b))`)
    expect(tables).toHaveLength(2)
    expect(tables[0].rows).toHaveLength(1)
    expect(tables[1].rows).toHaveLength(1)
    expect(tables[1].rows[0].values[0].text).toBe('i.b')
  })
})

describe('parseTables: shape hierarchy', () => {
  it('numbers the forEach levels from the shallowest rows', () => {
    const [t] = parseTables(HIERARCHY)
    expect(t.shape).toBe('hierarchy')
    expect(t.levels.map(l => [l.level, l.param])).toEqual([[0, 'unit'], [1, 'team'], [2, 'risk']])
    expect(t.rows.map(r => r.level)).toEqual([0, 1, 2])
    expect(t.rows.map(r => r.indent)).toEqual([null, 1, 3])
    expect(t.rows[1].collapse).toBe(true)
    expect(t.levels[2].receiverText).toBe('(SELECT CeRiskAssessment WHERE ermq_entity = team)')
    expect(t.levels[0].receiverText).toBe('this.children')
  })
  it('does not count a wrapper forEach around the whole table', () => {
    const [t] = parseTables(`_g.forEach(g:
  _t := LIST().table().addColumn("A", a)
  g.items.forEach(i: _t.addRow(i, i.a))
)`)
    expect(t.rows[0].level).toBe(0)
    expect(t.levels.map(l => l.level)).toEqual([0])
    expect(t.shape).toBe('rows')
  })
})

describe('parseTables: robustness', () => {
  it('returns nothing for text without a table', () => {
    expect(parseTables('')).toEqual([])
    expect(parseTables('_x := 1\n_y := "table("')).toEqual([])
  })
  it('ignores table( inside strings and comments', () => {
    expect(parseTables('_a := ".table(name)"\n// _b.table(name)')).toEqual([])
  })
  it('half-typed: unclosed table call', () => {
    const [t] = parseTables('_t := LIST().table(')
    expect(t.complete).toBe(false)
    expect(t.columns).toEqual([])
  })
  it('half-typed: an addColumn without its closing paren does not swallow the rest', () => {
    const src = `_t := LIST().table()
  .addColumn("A", a)
  .addColumn("B", b

_risks.forEach(item:
  _t.addRow(item, item.a)
)
_t`
    const [t] = parseTables(src)
    expect(t.columns).toHaveLength(2)
    expect(t.columns[1].complete).toBe(false)
    expect(t.columns[1].propIdent).toBe('b')
    expect(t.rows).toHaveLength(1)
    expect(t.rows[0].values.map(v => v.text)).toEqual(['item.a'])
  })
  it('half-typed: new column with empty property', () => {
    const [t] = parseTables('_t := LIST().table()\n  .addColumn("A", a)\n  .addColumn("", ')
    expect(t.columns).toHaveLength(2)
    expect(t.columns[1]).toMatchObject({ label: '', prop: null, complete: false })
  })
  it('half-typed: addRow whose paren is the enclosing forEach close', () => {
    const src = '_t := LIST().table().addColumn("A", a)\n_s.forEach(i:\n  _t.addRow(i, i.a,\n)\n_t'
    const [t] = parseTables(src)
    expect(t.rows[0].complete).toBe(false)
  })
  it('half-typed: trailing comma in addRow marks the row incomplete', () => {
    const [t] = parseTables('_t := LIST().table().addColumn("A", a)\n_s.forEach(i: _t.addRow(i, i.a, ))')
    expect(t.rows[0].complete).toBe(false)
  })
  it('never throws on garbage', () => {
    const junk = [
      '.table(', '.table()', 'x.table(((', ').table(', '_t := .table()', '.addColumn(', '"', "'", '/*',
      '_t := LIST().table()\n.addRow(\n.forEach(', 'a.forEach(b:\n_t.addRow(', '.table().table().table(',
      '_t.addRow(item\n_t := LIST().table(\n.forEach(',
    ]
    for (const j of junk) expect(() => parseTables(j)).not.toThrow()
    for (let i = 0; i < 200; i++) {
      const s = Array.from({ length: 60 }, () => '(.),"\n:= table addRow forEach addColumn _t item'.split(' ')[Math.floor(Math.random() * 8)] ?? '(').join('')
      expect(() => parseTables(s)).not.toThrow()
    }
  })
  it('stays correct on every prefix of a real script (typing simulation)', () => {
    for (let n = 0; n <= ROW_BY_ROW.length; n += 3) {
      const tables = parseTables(ROW_BY_ROW.slice(0, n))
      for (const t of tables) {
        expect(t.from).toBeLessThanOrEqual(t.to)
        for (const c of t.columns) expect(c.from).toBeLessThanOrEqual(c.to)
      }
    }
  })
  it('is case-insensitive about method names', () => {
    const [t] = parseTables('_t := LIST().TABLE().ADDCOLUMN("A", a)\n_s.FOREACH(i: _t.ADDROW(i, i.a))')
    expect(t.columns).toHaveLength(1)
    expect(t.rows).toHaveLength(1)
  })
  it('ignores a call that is part of an object path, not a table variable', () => {
    const [t] = parseTables('_t := LIST().table().addColumn("A", a)\n_s.forEach(i: x._t.addRow(i, i.a))')
    expect(t.rows).toHaveLength(0)
  })
})

describe('queries', () => {
  it('tableAt finds the table around a column or a row', () => {
    const tables = parseTables(ROW_BY_ROW)
    expect(tableAt(tables, ROW_BY_ROW.indexOf('"Owner"'))).toBe(tables[0])
    expect(tableAt(tables, ROW_BY_ROW.indexOf('item.name'))).toBe(tables[0])
    expect(tableAt(tables, 5)).toBeNull()
  })
  it('activeColumn maps the cursor to a column index', () => {
    const [t] = parseTables(ROW_BY_ROW)
    expect(activeColumn(t, ROW_BY_ROW.indexOf('"Owner"'))).toBe(1)
    expect(activeColumn(t, ROW_BY_ROW.indexOf('item.ermq_owner') + 3)).toBe(1)
    expect(activeColumn(t, ROW_BY_ROW.indexOf('item.ermq_residual_score') + 3)).toBe(3)
    expect(activeColumn(t, ROW_BY_ROW.indexOf('_t.addRow') + 2)).toBeNull()
  })
})

describe('performance', () => {
  it('parses a 2,000 line document with tables quickly', () => {
    const lines: string[] = []
    for (let i = 0; i < 300; i++) lines.push(`_v${i} := SELECT CeRiskAssessment WHERE ermq_status = "Open" // note ${i}`)
    lines.push('_t := LIST().table()')
    for (let c = 0; c < 40; c++) lines.push(`  .addColumn("Col ${c}", prop_${c})`)
    lines.push('_v0.forEach(item:')
    for (let r = 0; r < 600; r++) lines.push(`  _t.addRow(item, ${Array.from({ length: 6 }, (_, k) => `item.prop_${k}`).join(', ')})`)
    lines.push(')')
    for (let i = 0; i < 1000; i++) lines.push(`_w${i} := _v${i % 300}.filter(a = ${i})`)
    const src = lines.join('\n')
    expect(src.split('\n').length).toBeGreaterThan(1900)
    parseTables(src) // warm up
    const t0 = performance.now()
    const tables = parseTables(src)
    const ms = performance.now() - t0
    expect(tables).toHaveLength(1)
    expect(tables[0].rows).toHaveLength(600)
    expect(ms).toBeLessThan(50)
  })
  it('a document without tables is nearly free', () => {
    const src = Array.from({ length: 2000 }, (_, i) => `_x${i} := ${i} + 1`).join('\n')
    const t0 = performance.now()
    parseTables(src)
    expect(performance.now() - t0).toBeLessThan(20)
  })
  it('many unclosed calls do not go quadratic', () => {
    const src = '_t := LIST().table()\n' + Array.from({ length: 2000 }, () => '  _t.addRow(item, item.a,').join('\n')
    const t0 = performance.now()
    parseTables(src)
    expect(performance.now() - t0).toBeLessThan(200)
  })
})
