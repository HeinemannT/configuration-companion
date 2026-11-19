import { describe, it, expect } from 'vitest'
import type { TypeSchemaProp } from '../../../../lib/types'
import { parseTables } from '../model'
import {
  computeTableProblems, closestNames, planAddColumn, planNewColumnSlot, resolveTable, columnAtOffset,
  type TypeEnv, type Change,
} from '../analysis'

const prop = (accessor: string, label = accessor, configClass = 'TextMethodConfig'): TypeSchemaProp =>
  ({ accessor, label, configClass, systemobject: false })

const RISK: TypeSchemaProp[] = [
  prop('name', 'Name'),
  prop('ermq_owner', 'Owner'),
  prop('ermq_status', 'Status', 'ListMethodConfig'),
  prop('ermq_inherent_score', 'Inherent', 'NumberMethodConfig'),
  prop('ermq_residual_score', 'Residual', 'NumberMethodConfig'),
  prop('ermq_treatment', 'Treatment strategy', 'ListMethodConfig'),
  prop('ermq_controls', 'Controls', 'ReferenceMethodConfig'),
]

const env = (over: Partial<TypeEnv> = {}): TypeEnv => ({
  elementTypes: expr => (expr === '_risks' || expr.startsWith('(SELECT CeRiskAssessment') ? ['CeRiskAssessment'] : null),
  schema: t => (t === 'CeRiskAssessment' ? RISK : undefined),
  canonical: t => t,
  ...over,
})

function apply(text: string, changes: Change[]): string {
  const sorted = [...changes].sort((a, b) => b.from - a.from)
  let out = text
  for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to)
  return out
}

const ROW_TABLE = `_risks := SELECT CeRiskAssessment WHERE ermq_status = "Open"

_t := LIST().table()
  .addColumn("Risk", name)
  .addColumn("Owner", ermq_owner)
  .addColumn("Status", ermq_status)

_risks.forEach(item:
  _t.addRow(item, item.name, item.ermq_owner, item.ermq_status)
)
_t`

describe('resolveTable', () => {
  it('takes the row type from the forEach source for a row-by-row table', () => {
    const [t] = parseTables(ROW_TABLE)
    const r = resolveTable(t, env())
    expect(r.rowTypes).toEqual(['CeRiskAssessment'])
    expect(r.sourceLabel).toBe('_risks')
  })
  it('takes it from the receiver for X.table(...)', () => {
    const [t] = parseTables('_risks.table(name)')
    expect(resolveTable(t, env()).rowTypes).toEqual(['CeRiskAssessment'])
  })
  it('is unknown when the source is not typed', () => {
    const [t] = parseTables('_other.table(name)')
    expect(resolveTable(t, env()).rowTypes).toBeNull()
  })
  it('has no single row type in a hierarchy but types each level', () => {
    const [t] = parseTables(`_t := LIST().table().addColumn("A", name)
this.children.forEach(u:
  _t.addRow(u, u.name)
  (SELECT CeRiskAssessment WHERE x = u).forEach(r: _t.addRow(r, r.name).indent(1))
)`)
    const r = resolveTable(t, env())
    expect(t.shape).toBe('hierarchy')
    expect(r.rowTypes).toBeNull()
    expect(r.levelTypes).toEqual([null, ['CeRiskAssessment']])
  })
})

describe('problems: unknown property', () => {
  it('flags a wrong property in addColumn and offers the closest names', () => {
    const src = ROW_TABLE.replace('ermq_status)\n', 'ermq_staus)\n')
    const tables = parseTables(src)
    const p = computeTableProblems(tables, env()).filter(x => x.kind === 'unknown-property')
    expect(p).toHaveLength(1)
    expect(src.slice(p[0].from, p[0].to)).toBe('ermq_staus')
    expect(p[0].severity).toBe('error')
    expect(p[0].message).toContain('ermq_status')
    expect(p[0].fixes[0].label).toContain('ermq_status')
    expect(apply(src, p[0].fixes[0].changes)).toContain('.addColumn("Status", ermq_status)')
  })
  it('stays silent while the schema is not loaded', () => {
    const src = ROW_TABLE.replace('ermq_status)\n', 'bogus)\n')
    expect(computeTableProblems(parseTables(src), env({ schema: () => undefined }))).toEqual([])
  })
  it('stays silent when the row type is unknown', () => {
    expect(computeTableProblems(parseTables('_zzz.table(bogus)'), env())).toEqual([])
  })
  it('never flags universal accessors or case differences', () => {
    const src = '_risks.table(id, Name, parent, ERMQ_OWNER)'
    expect(computeTableProblems(parseTables(src), env())).toEqual([])
  })
  it('skips property paths (kpi.value)', () => {
    expect(computeTableProblems(parseTables('_risks.table(a.b.c)'), env())).toEqual([])
  })
  it('holds back the property the cursor is typing', () => {
    const src = '_risks.table(ermq_ow)'
    const tables = parseTables(src)
    expect(computeTableProblems(tables, env(), { cursor: src.indexOf('ermq_ow') + 7 })).toEqual([])
    expect(computeTableProblems(tables, env())).toHaveLength(1)
  })
  it('flags a wrong property in an addRow value', () => {
    const src = ROW_TABLE.replace('item.ermq_owner', 'item.ermq_ownr')
    const p = computeTableProblems(parseTables(src), env()).filter(x => x.kind === 'unknown-property')
    expect(p).toHaveLength(1)
    expect(src.slice(p[0].from, p[0].to)).toBe('ermq_ownr')
    expect(apply(src, p[0].fixes[0].changes)).toContain('item.ermq_owner,')
  })
  it('does not check hierarchy columns against one type', () => {
    const [t] = parseTables(`_t := LIST().table().addColumn("A", whatever)
this.children.forEach(u:
  _t.addRow(u, u.whatever)
  (SELECT CeRiskAssessment WHERE x = u).forEach(r: _t.addRow(r, r.name).indent(1))
)`)
    expect(computeTableProblems([t], env())).toEqual([])
  })
  it('is silent for a table that is still being typed', () => {
    const src = '_t := _risks.table()\n  .addColumn("A", bogus'
    expect(computeTableProblems(parseTables(src), env())).toEqual([])
  })
})

describe('problems: value count', () => {
  it('warns when addRow has fewer values than columns and fixes it', () => {
    const src = ROW_TABLE.replace(', item.ermq_status)', ')')
    const p = computeTableProblems(parseTables(src), env()).filter(x => x.kind === 'missing-values')
    expect(p).toHaveLength(1)
    expect(p[0].severity).toBe('warning')
    expect(p[0].message).toContain('2 values for 3 columns')
    expect(p[0].message).toContain('Status')
    expect(apply(src, p[0].fixes[0].changes)).toContain('item.ermq_owner, item.ermq_status)')
  })
  it('uses MISSING when the column is not a plain property', () => {
    const src = `_t := LIST().table().addColumn("A", a).addColumn("B", a.b)
_s.forEach(i: _t.addRow(i, i.a))`
    const [p] = computeTableProblems(parseTables(src), env())
    expect(apply(src, p.fixes[0].changes)).toContain('_t.addRow(i, i.a, MISSING)')
  })
  it('warns on extra values and removes them', () => {
    const src = ROW_TABLE.replace('item.ermq_status)', 'item.ermq_status, item.x, item.y)')
    const p = computeTableProblems(parseTables(src), env()).filter(x => x.kind === 'extra-values')
    expect(p).toHaveLength(1)
    expect(src.slice(p[0].from, p[0].to)).toBe('item.x, item.y')
    expect(apply(src, p[0].fixes[0].changes)).toContain('_t.addRow(item, item.name, item.ermq_owner, item.ermq_status)')
  })
  it('does not warn when counts match', () => {
    expect(computeTableProblems(parseTables(ROW_TABLE), env())).toEqual([])
  })
  it('holds back a row the cursor is in', () => {
    const src = ROW_TABLE.replace(', item.ermq_status)', ')')
    const tables = parseTables(src)
    expect(computeTableProblems(tables, env(), { cursor: src.indexOf('item.name') + 2 })).toEqual([])
  })
  it('is silent while a column is half typed', () => {
    const src = ROW_TABLE.replace('  .addColumn("Status", ermq_status)', '  .addColumn("Status", ')
    expect(computeTableProblems(parseTables(src), env())).toEqual([])
  })
  it('works without schemas (counts need none)', () => {
    const src = ROW_TABLE.replace(', item.ermq_status)', ')')
    const p = computeTableProblems(parseTables(src), env({ schema: () => undefined, elementTypes: () => null }))
    expect(p.map(x => x.kind)).toEqual(['missing-values'])
  })
})

describe('problems: indent', () => {
  const H = `_t := LIST().table().addColumn("A", name)
this.children.forEach(unit:
  _t.addRow(unit, unit.name)
  unit.children.forEach(team:
    _t.addRow(team, team.name).indent(1).collapse()
    team.children.forEach(risk:
      _t.addRow(risk, risk.name).indent(3).collapse()
    )
  )
)`
  it('flags indent that does not match the nesting level', () => {
    const p = computeTableProblems(parseTables(H), env()).filter(x => x.kind === 'indent')
    expect(p).toHaveLength(1)
    expect(p[0].message).toContain('level 2')
    expect(p[0].message).toContain('indent(3)')
    expect(apply(H, p[0].fixes[0].changes)).toContain('.indent(2).collapse()')
  })
  it('accepts matching indents', () => {
    const ok = H.replace('indent(3)', 'indent(2)')
    expect(computeTableProblems(parseTables(ok), env()).filter(x => x.kind === 'indent')).toEqual([])
  })
  it('ignores a single level', () => {
    const one = `_t := LIST().table().addColumn("A", name)
_s.forEach(i: _t.addRow(i, i.name).indent(5))`
    expect(computeTableProblems(parseTables(one), env())).toEqual([])
  })
  it('is silent while a forEach is not closed yet', () => {
    expect(computeTableProblems(parseTables(H.slice(0, H.lastIndexOf(')'))), env()).filter(x => x.kind === 'indent')).toEqual([])
  })
})

describe('closestNames', () => {
  it('ranks near misses first', () => {
    const names = RISK.map(p => p.accessor)
    expect(closestNames('ermq_treatmnt', names)[0]).toBe('ermq_treatment')
    expect(closestNames('ermq_owner_x', names)[0]).toBe('ermq_owner')
  })
  it('returns nothing for unrelated names', () => {
    expect(closestNames('zzzzzzzz', ['name', 'ermq_owner'])).toEqual([])
  })
})

describe('planAddColumn', () => {
  const src = ROW_TABLE.replace('  .addColumn("Status", ermq_status)', '  .addColumn("Status", ermq_status)\n  .addColumn("", zzz')
  const plan = (s: string, accessor: string, label: string): string => {
    const t = parseTables(s)[0]
    const from = s.indexOf('zzz')
    const to = from + 3
    return apply(s, planAddColumn(s, t, columnAtOffset(t, to), { accessor, label }, { from, to }))
  }
  it('writes the column and the matching value in every addRow in one change set', () => {
    const t = parseTables(src)[0]
    expect(columnAtOffset(t, src.indexOf('zzz') + 3)?.index).toBe(3)
    const out = plan(src, 'ermq_treatment', 'Treatment strategy')
    expect(out).toContain('.addColumn("Treatment strategy", ermq_treatment)')
    expect(out).toContain('_t.addRow(item, item.name, item.ermq_owner, item.ermq_status, item.ermq_treatment)')
    const t2 = parseTables(out)[0]
    expect(t2.columns).toHaveLength(4)
    expect(t2.rows[0].values).toHaveLength(4)
    expect(computeTableProblems([t2], env())).toEqual([])
  })
  it('keeps an existing label', () => {
    const out = plan(src.replace('.addColumn("", zzz', '.addColumn("Mine", zzz'), 'ermq_treatment', 'Treatment strategy')
    expect(out).toContain('.addColumn("Mine", ermq_treatment)')
  })
  it('does not add a second ) when the call is already closed', () => {
    const out = plan(src.replace('zzz', 'zzz)'), 'ermq_treatment', 'T')
    expect(out).toContain('.addColumn("T", ermq_treatment)')
    expect(out).not.toContain('))')
  })
  it('leaves rows that are not in step alone', () => {
    const out = plan(src.replace('item.ermq_owner, item.ermq_status)', 'item.ermq_owner)'), 'ermq_treatment', 'T')
    expect(out).toContain('_t.addRow(item, item.name, item.ermq_owner)')
  })
  it('inserts the value at the column position when the column goes in the middle', () => {
    const s = `_t := LIST().table()
  .addColumn("A", a)
  .addColumn("", zzz
  .addColumn("B", b)
_s.forEach(i: _t.addRow(i, i.a, i.b))`
    const out = plan(s, 'c', 'C')
    expect(out).toContain('_t.addRow(i, i.a, i.c, i.b)')
    expect(out).toContain('.addColumn("C", c)')
  })
  it('for chain-only tables writes just the column', () => {
    const out = plan('_t := _risks.table()\n  .addColumn("", zzz', 'ermq_treatment', 'Treatment strategy')
    expect(out).toBe('_t := _risks.table()\n  .addColumn("Treatment strategy", ermq_treatment)')
  })
  it('escapes quotes in labels', () => {
    const out = plan('_t := _risks.table()\n  .addColumn("", zzz)', 'q', 'The "big" one')
    expect(out).toContain('.addColumn("The \\"big\\" one", q)')
  })
})

describe('planNewColumnSlot', () => {
  it('opens a new addColumn line after the last column with the same indent', () => {
    const t = parseTables(ROW_TABLE)[0]
    const plan = planNewColumnSlot(ROW_TABLE, t)!
    const out = apply(ROW_TABLE, [plan.change])
    expect(out).toContain('.addColumn("Status", ermq_status)\n  .addColumn("", \n')
    expect(out.slice(plan.cursor - 2, plan.cursor)).toBe(', ')
  })
  it('appends an argument to X.table(a, b)', () => {
    const s = '_risks.table(name, ermq_owner)'
    const t = parseTables(s)[0]
    const plan = planNewColumnSlot(s, t)!
    expect(apply(s, [plan.change])).toBe('_risks.table(name, ermq_owner, )')
    expect(plan.cursor).toBe(s.indexOf('ermq_owner') + 'ermq_owner'.length + 2)
  })
  it('works on an empty table call', () => {
    const s = '_t := LIST().table()'
    const t = parseTables(s)[0]
    const plan = planNewColumnSlot(s, t)!
    expect(apply(s, [plan.change])).toBe('_t := LIST().table()\n  .addColumn("", ')
  })
  it('does nothing while the last column is still being typed', () => {
    const s = '_t := LIST().table()\n  .addColumn("A", '
    expect(planNewColumnSlot(s, parseTables(s)[0])).toBeNull()
  })
})

describe('performance', () => {
  it('model, problems and freshness over a 2,000 line document stay fast', async () => {
    const { analysePreview, compareToPreview } = await import('../preview')
    const lines: string[] = ['_risks := SELECT CeRiskAssessment WHERE ermq_status = "Open"', '_t := LIST().table()']
    for (let c = 0; c < 6; c++) lines.push(`  .addColumn("Col ${c}", ermq_owner)`)
    lines.push('_risks.forEach(item:')
    for (let r = 0; r < 800; r++) lines.push(`  _t.addRow(item, ${Array.from({ length: 6 }, () => 'item.ermq_owner').join(', ')})`)
    lines.push(')')
    for (let i = 0; i < 1100; i++) lines.push(`_w${i} := _risks.filter(name = "${i}") // comment ${i}`)
    const src = lines.join('\n')
    expect(src.split('\n').length).toBeGreaterThan(1900)
    const run = (): number => {
      const t0 = performance.now()
      const tables = parseTables(src)
      computeTableProblems(tables, env())
      const prev = analysePreview({ code: src, text: '', at: 0, durationMs: null, mode: 'preview' })
      compareToPreview({ text: `${src} `, tables, target: 0 }, { text: src, tables: prev.tables, target: 0 })
      return performance.now() - t0
    }
    run()
    expect(run()).toBeLessThan(150)
  })
})
