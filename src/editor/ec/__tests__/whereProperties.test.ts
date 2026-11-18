import { describe, it, expect } from 'vitest'
import { computeWherePropertyDiagnostics, suggestField } from '../whereProperties'
import { completeFields } from '../propertyLinter'

const KPI = ['id', 'name', 'description', 'parent', 'status', 'weight_pct', 'Owner_Team']
const fieldsOf = (type: string) => (type.toLowerCase() === 'kpi' ? KPI : undefined)
const run = (text: string, f = fieldsOf) => computeWherePropertyDiagnostics(text, f)
const messages = (text: string, f = fieldsOf) => run(text, f).map(d => d.message)

describe('computeWherePropertyDiagnostics', () => {
  it('warns for an unknown property and underlines only the identifier', () => {
    const text = 'SELECT Kpi FROM root.organisation WHERE nme = 1'
    const d = run(text)
    expect(d).toHaveLength(1)
    expect(d[0].severity).toBe('warning')
    expect(d[0].message).toBe('"nme" is not a property of Kpi. Did you mean "name"?')
    expect(text.slice(d[0].from, d[0].to)).toBe('nme')
  })

  it('omits the suggestion when nothing is close', () => {
    expect(messages('SELECT Kpi FROM root.x WHERE zzzzzz = 1')).toEqual(['"zzzzzz" is not a property of Kpi.'])
  })

  it('suggests by prefix and by case-insensitive distance', () => {
    expect(suggestField('weight', KPI)).toBe('weight_pct')
    expect(suggestField('statsu', KPI)).toBe('status')
    expect(suggestField('x', KPI)).toBeUndefined()
  })

  it('does not warn for known, custom, generic or differently cased properties', () => {
    expect(run('SELECT Kpi FROM root.x WHERE name = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE owner_team = "a"')).toEqual([])
    expect(run('SELECT kpi FROM root.x WHERE STATUS = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE lastModifiedDate > 1')).toEqual([])
  })

  it('skips variables, this/self/root, references and calls', () => {
    expect(run('SELECT Kpi FROM root.x WHERE _var = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE this.x = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE self.x = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE root.x = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE t.foo = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE ceras.foo.bar = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE fn(1) = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE name.size() > 3')).toEqual([])
  })

  it('checks only the first segment of a dotted chain', () => {
    expect(messages('SELECT Kpi FROM root.x WHERE parent.whatever = 1')).toEqual([])
    expect(messages('SELECT Kpi FROM root.x WHERE nme.size() > 1')).toEqual(['"nme" is not a property of Kpi. Did you mean "name"?'])
  })

  it('ignores identifiers inside strings and comments', () => {
    expect(run('x := "SELECT Kpi FROM root.x WHERE nme = 1"')).toEqual([])
    expect(run('// SELECT Kpi FROM root.x WHERE nme = 1')).toEqual([])
    expect(run('/* SELECT Kpi FROM root.x WHERE nme = 1 */')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE name = "nme = 1 AND bogus = 2"')).toEqual([])
  })

  it('stays silent for unknown types and unknown schemas', () => {
    expect(run('SELECT Other FROM root.x WHERE nme = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x WHERE nme = 1', () => undefined)).toEqual([])
  })

  it('does not handle multi-type selects', () => {
    expect(run('SELECT Kpi, Risk FROM root.x WHERE nme = 1')).toEqual([])
  })

  it('treats a schema without built-ins as unknown', () => {
    expect(completeFields(undefined)).toBeUndefined()
    expect(completeFields([])).toBeUndefined()
    const custom = { label: '', configClass: 'X', systemobject: false }
    expect(completeFields([{ ...custom, accessor: 'status' }])).toBeUndefined()
    expect(completeFields([{ ...custom, accessor: 'status' }, { ...custom, accessor: 'name', systemobject: true }])).toEqual(['status', 'name'])
  })

  it('handles AND, OR and parentheses', () => {
    const text = 'SELECT Kpi FROM root.x WHERE (name = 1 OR nme = 2) AND ( stauts = 3 )'
    const d = run(text)
    expect(d.map(x => text.slice(x.from, x.to))).toEqual(['nme', 'stauts'])
    expect(d[1].message).toBe('"stauts" is not a property of Kpi. Did you mean "status"?')
  })

  it('handles multi-line WHERE clauses and word operators', () => {
    const text = 'SELECT Kpi FROM root.x\nWHERE name = 1\n  AND bogus CONTAINS "a"\n  OR status IN t.a'
    const d = run(text)
    expect(d).toHaveLength(1)
    expect(text.slice(d[0].from, d[0].to)).toBe('bogus')
  })

  it('stops at the end of the clause and does not read the next statement', () => {
    expect(run('_a := SELECT Kpi FROM root.x WHERE name = 1\nIF bogus = 1 AND other = 2 THEN\nENDIF')).toEqual([])
    expect(run('_a := SELECT Kpi FROM root.x WHERE name = 1 ORDER BY bogus = 2')).toEqual([])
  })

  it('checks a nested SELECT against its own type only', () => {
    const f = (t: string) => (t.toLowerCase() === 'kpi' ? KPI : t.toLowerCase() === 'risk' ? ['id', 'name', 'score'] : undefined)
    const text = 'SELECT Kpi FROM root.x WHERE parent IN (SELECT Risk FROM root.y WHERE score = 1 AND status = 2) AND bogus = 1'
    const d = computeWherePropertyDiagnostics(text, f)
    expect(d.map(x => text.slice(x.from, x.to))).toEqual(['status', 'bogus'])
    expect(d[0].message).toContain('property of Risk')
    expect(d[1].message).toContain('property of Kpi')
  })

  it('clears when the text no longer applies', () => {
    expect(run('SELECT Kpi FROM root.x WHERE nme = 1')).toHaveLength(1)
    expect(run('SELECT Kpi FROM root.x WHERE name = 1')).toEqual([])
    expect(run('SELECT Kpi FROM root.x')).toEqual([])
  })
})
