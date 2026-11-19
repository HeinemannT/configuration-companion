/**
 * CodeMirror side of the table help. Everything here is a thin layer over the
 * pure modules (model, analysis, preview):
 *
 *   - helpField   StateField: the last preview, problem counts per table, and the
 *                 block "lens" decorations above each table / hierarchy level.
 *                 Block widgets must come from a field, not a ViewPlugin.
 *   - inline      ViewPlugin: faint column values after addColumn lines and
 *                 column labels inside addRow, for the visible ranges only.
 *   - linter      problems with fixes, at the linter's usual delay.
 *
 * Nothing here starts a preview or reads more than the visible ranges plus one
 * memoised model pass per document version.
 */
import { Facet, StateField, StateEffect, type EditorState, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { linter, forceLinting, type Diagnostic } from '@codemirror/lint'
import { startCompletion } from '@codemirror/autocomplete'
import { h } from '../../../lib/dom'
import { typeBadge } from '../../../lib/type-badge'
import { typeLabel as displayTypeName } from '../../../lib/object-window-table'
import { programmaticSwap } from '../../../editor-core/code-surface'
import {
  getSchema, ensureSchema, canonicalType, inferExpression, subscribe,
} from '../typeInference'
import { tableAt, activeColumn, type TableModel } from './model'
import { getTableModels } from './doc-models'
import {
  computeTableProblems, planNewColumnSlot, resolveTable, schemaOf, type TypeEnv, type TableProblem,
} from './analysis'
import {
  analysePreview, compareToPreview, describeValues, valuesForColumn, type Freshness, type LastPreview, type PreviewData,
} from './preview'

// ── environment ───────────────────────────────────────────────

/** Types and properties from the editor's own inference and schema cache. */
export const liveEnv: TypeEnv = {
  elementTypes(expr) {
    const inf = inferExpression(expr)
    return inf.kind === 'list' ? inf.types : null
  },
  schema: type => getSchema(type),
  canonical: type => canonicalType(type),
}

// ── configuration ─────────────────────────────────────────────

export interface TableHelpOptions {
  /** `full`: lens, inline values, row labels and problems. `problems`: underlines only. */
  mode: 'full' | 'problems'
  /** The editor's own Preview action (the lens offers it; the user presses it). */
  onPreview?: () => void
}

const optionsFacet = Facet.define<TableHelpOptions, TableHelpOptions>({
  combine: values => values[0] ?? { mode: 'problems' },
})

// ── memoised context ──────────────────────────────────────────

export interface TableContext {
  text: string
  tables: TableModel[]
  preview: PreviewData | null
  /** Table the preview belongs to, in `tables` (-1 when none). */
  target: number
  freshness: Freshness | null
}

const ctxMemo = new WeakMap<Text, { preview: PreviewData | null; ctx: TableContext }>()

function pickTarget(tables: readonly TableModel[], preview: PreviewData): number {
  if (tables.length === 0) return -1
  // Same table index as in the previewed code when the table count agrees; else the last table.
  return preview.target >= 0 && preview.target < tables.length && tables.length === preview.tables.length
    ? preview.target
    : tables.length - 1
}

function contextFor(doc: Text, preview: PreviewData | null): TableContext {
  const hit = ctxMemo.get(doc)
  if (hit && hit.preview === preview) return hit.ctx
  const { text, tables } = getTableModels(doc)
  let target = -1
  let freshness: Freshness | null = null
  if (preview && tables.length > 0) {
    target = pickTarget(tables, preview)
    freshness = compareToPreview(
      { text, tables, target },
      { text: preview.preview.code, tables: preview.tables, target: preview.target },
    )
  }
  const ctx: TableContext = { text, tables, preview, target, freshness }
  ctxMemo.set(doc, { preview, ctx })
  return ctx
}

export function getTableContext(state: EditorState): TableContext {
  return contextFor(state.doc, state.field(helpField, false)?.preview ?? null)
}

// ── state ─────────────────────────────────────────────────────

const setPreviewEffect = StateEffect.define<PreviewData | null>()
const setCountsEffect = StateEffect.define<Map<number, { errors: number; warnings: number }>>()
const tickEffect = StateEffect.define<null>()

interface HelpState {
  preview: PreviewData | null
  counts: Map<number, { errors: number; warnings: number }>
  lens: DecorationSet
  /** Fingerprint of everything type-related the lens showed. */
  key: string
}

/** Fingerprint of the row types and which schemas are loaded, so a change in
 *  either refreshes the lens and the problems. */
function typeFingerprint(tables: readonly TableModel[]): string {
  const parts: string[] = []
  for (const t of tables) {
    const r = resolveTable(t, liveEnv)
    const all = [...(r.rowTypes ?? []), ...r.levelTypes.flatMap(l => l ?? [])]
    parts.push(all.map(ty => `${ty}:${getSchema(ty) ? 1 : 0}`).join(','))
  }
  return parts.join('|')
}

/** The extension's own display name for the row type(s), as everywhere else. */
const displayLabel = (types: string[]): string => types.map(ty => displayTypeName(liveEnv.canonical(ty))).join(' | ')

function buildLens(state: EditorState, preview: PreviewData | null, counts: HelpState['counts']): { lens: DecorationSet; key: string } {
  const opts = state.facet(optionsFacet)
  const ctx = contextFor(state.doc, preview)
  const key = typeFingerprint(ctx.tables)
  if (opts.mode !== 'full' || ctx.tables.length === 0) return { lens: Decoration.none, key }
  const ranges: Range<Decoration>[] = []
  ctx.tables.forEach((t, i) => {
    const r = resolveTable(t, liveEnv)
    const info: LensInfo = {
      kind: 'table',
      columns: t.columns.length,
      rowTypes: r.rowTypes,
      rowTypeLabel: r.rowTypes ? displayLabel(r.rowTypes) : null,
      source: r.sourceLabel,
      problems: counts.get(i) ?? null,
      run: null,
      tableIndex: i,
    }
    if (preview && ctx.freshness && ctx.target === i && preview.table) {
      info.run = {
        rows: preview.table.rows.length,
        durationMs: preview.preview.durationMs,
        at: preview.preview.at,
        edited: ctx.freshness.state !== 'fresh',
      }
    }
    ranges.push(Decoration.widget({ widget: new LensWidget(info), block: true, side: -1 }).range(t.lensFrom))
    if (t.shape === 'hierarchy') {
      t.levels.forEach((lv, li) => {
        const types = r.levelTypes[li]
        ranges.push(Decoration.widget({
          widget: new LensWidget({
            kind: 'level',
            level: lv.level,
            param: lv.param,
            rowTypes: types,
            rowTypeLabel: types ? displayLabel(types) : null,
            source: lv.receiverText,
            tableIndex: i,
          }),
          block: true,
          side: -1,
        }).range(lv.lineFrom))
      })
    }
  })
  return { lens: Decoration.set(ranges, true), key }
}

export const helpField: StateField<HelpState> = StateField.define<HelpState>({
  create(state) {
    return { preview: null, counts: new Map(), ...buildLens(state, null, new Map()) }
  },
  update(value, tr) {
    let { preview, counts } = value
    let changed = tr.docChanged
    for (const e of tr.effects) {
      if (e.is(setPreviewEffect)) { preview = e.value; changed = true }
      else if (e.is(setCountsEffect)) { counts = e.value; changed = true }
      else if (e.is(tickEffect)) changed = true
    }
    if (tr.docChanged && tr.annotation(programmaticSwap) === true) {
      preview = null
      counts = new Map()
    }
    if (!changed) return value
    return { preview, counts, ...buildLens(tr.state, preview, counts) }
  },
  provide: f => EditorView.decorations.from(f, v => v.lens),
})

/** Record the output of a finished Preview (or Execute) for inline values and the Table tab. */
export function recordTablePreview(view: EditorView, preview: LastPreview): void {
  view.dispatch({ effects: setPreviewEffect.of(analysePreview(preview)) })
}

// ── lens widget ───────────────────────────────────────────────

interface LensInfo {
  kind: 'table' | 'level'
  tableIndex: number
  columns?: number
  level?: number
  param?: string | null
  rowTypes: string[] | null
  rowTypeLabel: string | null
  source: string | null
  problems?: { errors: number; warnings: number } | null
  run?: { rows: number; durationMs: number | null; at: number; edited: boolean } | null
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

class LensWidget extends WidgetType {
  private readonly sig: string
  constructor(private readonly info: LensInfo) {
    super()
    this.sig = JSON.stringify(info)
  }
  eq(other: LensWidget): boolean { return this.sig === other.sig }
  ignoreEvent(): boolean { return true }

  toDOM(view: EditorView): HTMLElement {
    const i = this.info
    const dot = (): HTMLElement => h('span', { class: 'cm-tbl-sep' }, '·')
    const parts: Array<HTMLElement | string> = []
    if (i.kind === 'level') {
      parts.push(h('span', { class: 'cm-tbl-lens-k' }, `Level ${i.level}`))
      if (i.param) parts.push(h('span', { class: 'cm-tbl-lens-mono' }, i.param))
    } else {
      parts.push(h('span', { class: 'cm-tbl-lens-k' }, 'Rows'))
    }
    if (i.rowTypes && i.rowTypeLabel) {
      parts.push(typeBadge(i.rowTypes[0], { size: 'xs' }))
      parts.push(h('span', null, i.rowTypeLabel))
    }
    if (i.source) parts.push(h('span', { class: 'cm-tbl-lens-dim' }, ['from ', h('span', { class: 'cm-tbl-lens-mono' }, i.source)]))
    if (i.kind === 'table') {
      parts.push(dot(), h('span', { class: 'cm-tbl-lens-dim' }, plural(i.columns ?? 0, 'column')))
      if (i.problems && (i.problems.errors || i.problems.warnings)) {
        const bits: string[] = []
        if (i.problems.errors) bits.push(plural(i.problems.errors, 'error'))
        if (i.problems.warnings) bits.push(plural(i.problems.warnings, 'warning'))
        parts.push(dot(), h('span', { class: i.problems.errors ? 'cm-tbl-lens-err' : 'cm-tbl-lens-warn' }, bits.join(', ')))
      }
      if (i.run) {
        const secs = i.run.durationMs != null ? `, ${(i.run.durationMs / 1000).toFixed(1)} s` : ''
        parts.push(dot(), h('span', { class: i.run.edited ? 'cm-tbl-lens-dim cm-tbl-lens-old' : 'cm-tbl-lens-dim', title: i.run.edited ? 'The code was edited after this preview' : 'From your last preview' },
          `${plural(i.run.rows, 'row')}${secs} at ${clock(i.run.at)}${i.run.edited ? ', edited since' : ''}`))
      }
      const opts = view.state.facet(optionsFacet)
      const action = (label: string, run: () => void, title: string): HTMLElement => h('button', {
        class: 'cm-tbl-lens-act', type: 'button', title,
        onMousedown: ((e: MouseEvent) => e.preventDefault()) as never,
        onClick: ((e: MouseEvent) => { e.preventDefault(); run() }) as never,
      }, label)
      parts.push(h('span', { class: 'cm-tbl-lens-spacer' }))
      if (opts.onPreview) parts.push(action('Preview', () => opts.onPreview?.(), 'Preview the code (F5)'))
      parts.push(action('Add column', () => addColumn(view, i.tableIndex), 'Add a column and its addRow values'))
    }
    return h('div', { class: `cm-tbl-lens cm-tbl-lens--${i.kind}` }, ...parts)
  }
}

/** "Add column": open a new `.addColumn("", ` slot and let completion list the row type's properties. */
export function addColumn(view: EditorView, tableIndex: number): void {
  const { text, tables } = getTableModels(view.state.doc)
  const t = tables[tableIndex]
  if (!t) return
  const plan = planNewColumnSlot(text, t)
  if (!plan) { view.focus(); return }
  view.dispatch({
    changes: plan.change,
    selection: { anchor: plan.cursor },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
  startCompletion(view)
}

// ── inline values and labels ──────────────────────────────────

class ValuesWidget extends WidgetType {
  constructor(private readonly text: string, private readonly active: boolean, private readonly stale: boolean) { super() }
  eq(o: ValuesWidget): boolean { return o.text === this.text && o.active === this.active && o.stale === this.stale }
  toDOM(): HTMLElement {
    return h('span', { class: `cm-tbl-values${this.active ? ' cm-tbl-active' : ''}${this.stale ? ' cm-tbl-values--stale' : ''}`, 'aria-hidden': 'true' }, this.text)
  }
  ignoreEvent(): boolean { return true }
}

class LabelWidget extends WidgetType {
  constructor(private readonly text: string, private readonly active: boolean) { super() }
  eq(o: LabelWidget): boolean { return o.text === this.text && o.active === this.active }
  toDOM(): HTMLElement {
    return h('span', { class: `cm-tbl-label${this.active ? ' cm-tbl-active' : ''}`, 'aria-hidden': 'true' }, this.text)
  }
  ignoreEvent(): boolean { return true }
}

class MissingWidget extends WidgetType {
  constructor(private readonly text: string) { super() }
  eq(o: MissingWidget): boolean { return o.text === this.text }
  toDOM(): HTMLElement { return h('span', { class: 'cm-tbl-label cm-tbl-label--missing', 'aria-hidden': 'true' }, this.text) }
  ignoreEvent(): boolean { return true }
}

function buildInline(view: EditorView): DecorationSet {
  const ctx = getTableContext(view.state)
  if (ctx.tables.length === 0) return Decoration.none
  const out: Range<Decoration>[] = []
  const head = view.state.selection.main.head
  const ranges = view.visibleRanges
  const visible = (from: number, to: number): boolean => ranges.some(r => to >= r.from && from <= r.to)

  ctx.tables.forEach((t, ti) => {
    const active = tableAt([t], head) ? activeColumn(t, head) : null
    const showValues = ctx.preview !== null && ctx.target === ti && ctx.freshness !== null

    for (const c of t.columns) {
      if (c.source !== 'addColumn' || !c.complete || !visible(c.from, c.to)) continue
      if (showValues && ctx.preview && ctx.freshness) {
        const v = valuesForColumn(ctx.preview, c.index, ctx.freshness)
        if (v) {
          const txt = v.stale ? 'not previewed since this change' : describeValues(v.stats)
          if (txt) out.push(Decoration.widget({ widget: new ValuesWidget(txt, active === c.index, v.stale), side: 1 }).range(c.to))
        }
      }
    }

    if ((t.shape === 'rows' || t.shape === 'hierarchy') && t.columns.length > 0 && t.columns.every(c => c.complete)) {
      for (const row of t.rows) {
        if (!row.complete || !row.rowVar || !visible(row.from, row.to)) continue
        const n = Math.min(row.values.length, t.columns.length)
        for (let k = 0; k < n; k++) {
          const col = t.columns[k]
          const label = col.label || col.prop || `#${k + 1}`
          out.push(Decoration.widget({ widget: new LabelWidget(label, active === k), side: -1 }).range(row.values[k].from))
        }
        if (row.values.length < t.columns.length && row.call.close !== null) {
          const col = t.columns[row.values.length]
          out.push(Decoration.widget({ widget: new MissingWidget(`${col.label || col.prop || 'value'} missing`), side: -1 }).range(row.call.close))
        }
      }
    }
  })
  return Decoration.set(out, true)
}

/** Ask for the row type's property list once a table with a known type is on screen. */
function warmSchemas(view: EditorView): void {
  const { tables } = getTableModels(view.state.doc)
  for (const t of tables) {
    const r = resolveTable(t, liveEnv)
    for (const types of [r.rowTypes, ...r.levelTypes]) {
      if (types && schemaOf(liveEnv, types) === undefined) types.forEach(ty => ensureSchema(ty))
    }
  }
}

/** Types arrive after the first parse; re-run when the fingerprint changes. */
function watchTypes(view: EditorView): () => void {
  let raf = 0
  const check = (): void => {
    raf = 0
    const st = view.state.field(helpField, false)
    if (!st) return
    const { tables } = getTableModels(view.state.doc)
    if (typeFingerprint(tables) !== st.key) {
      view.dispatch({ effects: tickEffect.of(null) })
      // The row type is known only now, so this is the first moment its schema can be asked for.
      warmSchemas(view)
      forceLinting(view)
    }
  }
  const off = subscribe(() => {
    if (raf) return
    raf = requestAnimationFrame(check)
  })
  return () => { off(); if (raf) cancelAnimationFrame(raf) }
}

const inlinePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  private readonly stop: () => void
  constructor(view: EditorView) {
    this.decorations = view.state.facet(optionsFacet).mode === 'full' ? buildInline(view) : Decoration.none
    this.stop = watchTypes(view)
    warmSchemas(view)
  }
  update(u: ViewUpdate): void {
    if (u.state.facet(optionsFacet).mode !== 'full') { this.decorations = Decoration.none; return }
    const previewChanged = u.startState.field(helpField, false)?.preview !== u.state.field(helpField, false)?.preview
    if (u.docChanged || u.viewportChanged || u.selectionSet || previewChanged || u.transactions.some(t => t.effects.some(e => e.is(tickEffect)))) {
      this.decorations = buildInline(u.view)
    }
    if (u.docChanged) warmSchemas(u.view)
  }
  destroy(): void { this.stop() }
}, { decorations: v => v.decorations })

// ── problems ──────────────────────────────────────────────────

function toDiagnostic(p: TableProblem): Diagnostic {
  return {
    from: p.from,
    to: Math.max(p.to, p.from + 1),
    severity: p.severity,
    message: p.message,
    source: 'Table',
    actions: p.fixes.map(f => ({
      name: f.label,
      apply(view: EditorView): void {
        view.dispatch({ changes: f.changes, userEvent: 'input.complete' })
      },
    })),
  }
}

const countsKey = (m: Map<number, { errors: number; warnings: number }>): string =>
  [...m].map(([k, v]) => `${k}:${v.errors}/${v.warnings}`).join(',')

const tableLinter = linter(view => {
  const ctx = getTableContext(view.state)
  const counts = new Map<number, { errors: number; warnings: number }>()
  let diagnostics: Diagnostic[] = []
  if (ctx.tables.length > 0) {
    const problems = computeTableProblems(ctx.tables, liveEnv, { cursor: view.state.selection.main.head })
    for (const p of problems) {
      const c = counts.get(p.tableIndex) ?? { errors: 0, warnings: 0 }
      if (p.severity === 'error') c.errors++
      else if (p.severity === 'warning') c.warnings++
      counts.set(p.tableIndex, c)
    }
    diagnostics = problems.map(toDiagnostic)
  }
  const prev = view.state.field(helpField, false)?.counts
  if (view.state.facet(optionsFacet).mode === 'full' && prev && countsKey(prev) !== countsKey(counts)) {
    queueMicrotask(() => {
      try { view.dispatch({ effects: setCountsEffect.of(counts) }) } catch { /* view went away before the counts landed */ }
    })
  }
  return diagnostics
}, {
  delay: 750,
  // A late schema or row type arrives as a tick; forceLinting only acts on a pending refresh.
  needsRefresh: u => u.selectionSet || u.transactions.some(tr => tr.effects.some(e => e.is(tickEffect))),
})

/** Everything the table help adds to an Extended Code editor. */
export function tableHelp(options: TableHelpOptions): Extension[] {
  // The plugin also warms the row type's schema, so it is present in both modes.
  return [optionsFacet.of(options), helpField, tableLinter, inlinePlugin]
}
