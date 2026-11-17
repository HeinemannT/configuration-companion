/** Live, read-only contracts of the code index: the inventory and the LIST read. */
import { expect, it } from 'vitest'
import { plainFrame as createEcFrame } from '../../code-index-sync'
import { buildInventoryEc, buildReadEc, parseInventoryLog, parseReadLog } from '../../code-index-sync'
import { buildSourceListEc, parseSourceListLog } from '../../code-scope-read'
import { bridgePreview, integrationTarget } from './config'

it('lists ExtendedExpressions with stamp and code length, completion-marked', async () => {
  const target = integrationTarget()
  const frame = createEcFrame()
  const rows = parseInventoryLog(await bridgePreview(target, buildInventoryEc('ExtendedExpression', frame)), frame)
  expect(rows.length).toBeGreaterThan(0)
  expect(new Set(rows.map(r => r.rid)).size).toBe(rows.length)
  expect(rows.every(r => r.len >= 0)).toBe(true)
}, 30_000)

it('reads code of listed objects in one LIST and the length matches the inventory', async () => {
  const target = integrationTarget()
  const f1 = createEcFrame()
  const rows = parseInventoryLog(await bridgePreview(target, buildInventoryEc('ExtendedExpression', f1)), f1).filter(r => r.len > 0).slice(0, 5)
  const f2 = createEcFrame()
  const read = parseReadLog(await bridgePreview(target, buildReadEc(rows.map(r => ({ rid: r.rid, ref: `lookup(${r.rid})`, type: 'ExtendedExpression', props: ['expression'] })), f2)), f2)
  expect([...read.keys()]).toEqual(rows.map(r => r.rid))
  for (const r of rows) expect(read.get(r.rid)!.code.expression?.length).toBe(r.len)
}, 30_000)

it('lists every object with code of a source with one constant script', async () => {
  const target = integrationTarget()
  const { rows } = parseSourceListLog(await bridgePreview(target, buildSourceListEc(['ExtendedExpression'], undefined, 'root')))
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every(r => r.type === 'ExtendedExpression' && r.len > 0)).toBe(true)
}, 30_000)
