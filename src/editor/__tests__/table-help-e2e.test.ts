/**
 * @vitest-environment happy-dom
 *
 * Table help wired into a real EditorView: completion of the row type's
 * properties inside a LIST().table() chain, the one-edit "add column" apply, the
 * lens, inline values from a stored preview, and staleness after an edit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { propertyCompletions } from '../ec/propertyCompletions'
import * as ti from '../ec/typeInference'
import { tableHelp, recordTablePreview, getTableContext, addColumn } from '../ec/table/extension'
import type { TypeSchemaProp } from '../../lib/types'

const RISK_PROPS: TypeSchemaProp[] = [
  { accessor: 'name', label: 'Name', configClass: 'SystemMethodConfig', systemobject: true },
  { accessor: 'ermq_owner', label: 'Owner', configClass: 'TextMethodConfig', systemobject: false },
  { accessor: 'ermq_status', label: 'Status', configClass: 'ListMethodConfig', systemobject: false },
  { accessor: 'ermq_treatment', label: 'Treatment strategy', configClass: 'ListMethodConfig', systemobject: false },
]

const CODE_HEAD = `_risks := SELECT CeRiskAssessment WHERE ermq_status = "Open"

_t := LIST().table()
  .addColumn("Risk", name)
  .addColumn("Owner", ermq_owner)
`
const CODE_TAIL = `
_risks.forEach(item:
  _t.addRow(item, item.name, item.ermq_owner)
)
_t`

const docOf = (src: string) => {
  const lines = src.split('\n')
  return { lines: lines.length, line: (n: number) => ({ text: lines[n - 1] }) }
}

const OUTPUT = `Result : OK
╔═══════════╦════════╗
║ Risk      ║ Owner  ║
╠═══════════╬════════╣
║ Supplier  ║ Anna   ║
║ Data      ║        ║
╚═══════════╩════════╝
Duration : 5ms`

async function flush() { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)) }

beforeEach(async () => {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn(() => Promise.resolve({ type: 'FETCH_TYPE_SCHEMA_RESULT', className: 'CeRiskAssessment', ok: true, props: RISK_PROPS, canonicalClassName: 'CeRiskAssessment' })),
    },
  }
  ti._resetForTests()
  ti.ensureSchemaNow('CeRiskAssessment')
  await flush()
})

function makeView(doc: string, pos = doc.length): EditorView {
  ti.scanDocForInferences(docOf(doc))
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: pos },
      extensions: [history(), ti.typeInferenceListener, ...tableHelp({ mode: 'full' })],
    }),
  })
}

describe('completion inside a LIST().table() chain', () => {
  it('offers the row type properties at the property slot of a new column', async () => {
    const doc = CODE_HEAD + '  .addColumn("", tr' + CODE_TAIL
    ti.scanDocForInferences(docOf(doc))
    const pos = doc.indexOf('tr' + CODE_TAIL) + 2
    const res = await propertyCompletions(new CompletionContext(EditorState.create({ doc }), pos, false))
    expect(res).not.toBeNull()
    const labels = res!.options.map(o => o.label)
    expect(labels).toEqual(expect.arrayContaining(['ermq_treatment', 'ermq_status', 'name']))
  })

  it('ranks properties that are not yet columns first and tags used ones', async () => {
    const doc = CODE_HEAD + '  .addColumn("", ' + CODE_TAIL
    ti.scanDocForInferences(docOf(doc))
    const pos = doc.indexOf('.addColumn("", ') + '.addColumn("", '.length
    const res = await propertyCompletions(new CompletionContext(EditorState.create({ doc }), pos, true))
    const byLabel = new Map(res!.options.map(o => [o.label, o]))
    expect(byLabel.get('ermq_owner')!.detail).toContain('in table')
    expect(byLabel.get('ermq_treatment')!.boost!).toBeGreaterThan(byLabel.get('ermq_owner')!.boost!)
  })

  it('stays quiet in the label slot and when the row type is unknown', async () => {
    const doc = CODE_HEAD + '  .addColumn(' + CODE_TAIL
    ti.scanDocForInferences(docOf(doc))
    const inLabel = await propertyCompletions(new CompletionContext(EditorState.create({ doc }), doc.indexOf('addColumn(', doc.indexOf('Owner') + 10) + 10, true))
    expect(inLabel).toBeNull()
    const unknown = '_zzz := LIST().table()\n  .addColumn("", '
    ti.scanDocForInferences(docOf(unknown))
    expect(await propertyCompletions(new CompletionContext(EditorState.create({ doc: unknown }), unknown.length, true))).toBeNull()
  })

  it('choosing a property writes the column and the addRow value in one undo step', async () => {
    const doc = CODE_HEAD + '  .addColumn("", tr' + CODE_TAIL
    const pos = doc.indexOf('tr' + CODE_TAIL) + 2
    const view = makeView(doc, pos)
    const res = await propertyCompletions(new CompletionContext(view.state, pos, false))
    const opt = res!.options.find(o => o.label === 'ermq_treatment') as Completion
    expect(typeof opt.apply).toBe('function')
    const before = view.state.doc.toString()
    ;(opt.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, opt, res!.from, pos)
    const after = view.state.doc.toString()
    expect(after).toContain('.addColumn("Treatment strategy", ermq_treatment)')
    expect(after).toContain('_t.addRow(item, item.name, item.ermq_owner, item.ermq_treatment)')
    // Cursor sits right after the finished column call.
    const head = view.state.selection.main.head
    expect(after.slice(head - 'ermq_treatment)'.length, head)).toBe('ermq_treatment)')
    // One transaction: a single undo restores the original text.
    undo(view)
    expect(view.state.doc.toString()).toBe(before)
    expect(after).not.toBe(before)
    view.destroy()
  })
})

describe('add column action', () => {
  it('opens a new addColumn slot after the last column', () => {
    const view = makeView(CODE_HEAD + CODE_TAIL)
    addColumn(view, 0)
    const text = view.state.doc.toString()
    expect(text).toContain('.addColumn("Owner", ermq_owner)\n  .addColumn("", \n')
    expect(view.state.selection.main.head).toBe(text.indexOf('.addColumn("", ') + '.addColumn("", '.length)
    view.destroy()
  })

  it('completion at the new slot lists the row type properties, and choosing one finishes the column and the rows', async () => {
    const view = makeView(CODE_HEAD + CODE_TAIL)
    addColumn(view, 0)
    ti.scanDocForInferences(docOf(view.state.doc.toString()))
    const pos = view.state.selection.main.head
    const res = await propertyCompletions(new CompletionContext(view.state, pos, true))
    const opt = res!.options.find(o => o.label === 'ermq_status') as Completion
    ;(opt.apply as (v: EditorView, c: Completion, from: number, to: number) => void)(view, opt, res!.from, pos)
    const text = view.state.doc.toString()
    expect(text).toContain('.addColumn("Status", ermq_status)')
    expect(text).toContain('item.ermq_owner, item.ermq_status)')
    view.destroy()
  })
})

describe('lens and inline values', () => {
  const code = CODE_HEAD + CODE_TAIL

  it('draws a lens above the table with the column count, type and source', () => {
    const view = makeView(code)
    const lens = view.dom.querySelector('.cm-tbl-lens')
    expect(lens).not.toBeNull()
    expect(lens!.textContent).toContain('2 columns')
    expect(lens!.textContent).toContain('Risk assessment')
    expect(lens!.textContent).toContain('_risks')
    expect(lens!.textContent).toContain('Add column')
    view.destroy()
  })

  it('shows no values before a preview, and labels inside addRow', () => {
    const view = makeView(code)
    expect(view.dom.querySelector('.cm-tbl-values')).toBeNull()
    const labels = [...view.dom.querySelectorAll('.cm-tbl-label')].map(e => e.textContent)
    expect(labels).toEqual(['Risk', 'Owner'])
    view.destroy()
  })

  it('shows real values after a preview and the row count in the lens', () => {
    const view = makeView(code)
    recordTablePreview(view, { code, text: OUTPUT, at: Date.now(), durationMs: 600, mode: 'preview' })
    const values = [...view.dom.querySelectorAll('.cm-tbl-values')].map(e => e.textContent)
    expect(values).toEqual(['Supplier · Data', 'Anna · 1 empty'])
    expect(view.dom.querySelector('.cm-tbl-lens')!.textContent).toContain('2 rows, 0.6 s')
    view.destroy()
  })

  it('marks values stale once the code changed in a way that could change them', () => {
    const view = makeView(code)
    recordTablePreview(view, { code, text: OUTPUT, at: Date.now(), durationMs: 600, mode: 'preview' })
    const at = code.indexOf('ermq_owner)')
    view.dispatch({ changes: { from: at, to: at + 'ermq_owner'.length, insert: 'ermq_ownr' } })
    const texts = [...view.dom.querySelectorAll('.cm-tbl-values')].map(e => e.textContent)
    expect(texts).toEqual(['Supplier · Data', 'not previewed since this change'])
    // A change to the data source hides everything.
    const w = view.state.doc.toString().indexOf('"Open"')
    view.dispatch({ changes: { from: w, to: w + 6, insert: '"Closed"' } })
    expect(view.dom.querySelector('.cm-tbl-values')).toBeNull()
    expect(view.dom.querySelector('.cm-tbl-lens')!.textContent).toContain('edited since')
    view.destroy()
  })

  it('getTableContext exposes freshness for the Table tab', () => {
    const view = makeView(code)
    expect(getTableContext(view.state).freshness).toBeNull()
    recordTablePreview(view, { code, text: OUTPUT, at: 1, durationMs: null, mode: 'preview' })
    expect(getTableContext(view.state).freshness).toEqual({ state: 'fresh' })
    view.destroy()
  })

  it('does nothing for code without a table', () => {
    const view = makeView('_x := 1\n_y := _x + 2')
    expect(view.dom.querySelector('.cm-tbl-lens')).toBeNull()
    view.destroy()
  })

  it('problems mode draws no lens or inline pieces', () => {
    ti.scanDocForInferences(docOf(code))
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: code, extensions: [ti.typeInferenceListener, ...tableHelp({ mode: 'problems' })] }),
    })
    expect(view.dom.querySelector('.cm-tbl-lens')).toBeNull()
    expect(view.dom.querySelector('.cm-tbl-label')).toBeNull()
    view.destroy()
  })
})
