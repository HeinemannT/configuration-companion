/**
 * Table analysis: row types, problems with fixes, and the edits that keep
 * addColumn and addRow in step. Pure functions over the table model and a small
 * type environment (so tests never need the extension's type caches).
 */
import type { TypeSchemaProp } from '../../../lib/types'
import { intersectTypeSchemas } from '../../../lib/type-schema-utils'
import type { TableModel, ColumnModel, RowModel } from './model'

export interface TypeEnv {
  /** Element type(s) of a collection expression, or null when unknown. */
  elementTypes(expr: string): string[] | null
  /** Loaded property list of a class, or undefined while it is not loaded. */
  schema(type: string): TypeSchemaProp[] | undefined
  /** Display name of a class. */
  canonical(type: string): string
}

export interface Change { from: number; to: number; insert: string }
export interface Fix { label: string; changes: Change[] }

export type ProblemKind = 'unknown-property' | 'missing-values' | 'extra-values' | 'indent'

export interface TableProblem {
  kind: ProblemKind
  from: number
  to: number
  severity: 'error' | 'warning' | 'info'
  message: string
  tableIndex: number
  fixes: Fix[]
}

// ── row types ─────────────────────────────────────────────────

export interface ResolvedTable {
  /** Row type(s) the columns' properties belong to; null when unknown or mixed (hierarchy). */
  rowTypes: string[] | null
  /** Element type(s) per `table.levels` entry. */
  levelTypes: Array<string[] | null>
  /** Where the rows come from, as shown in the lens: `from _risks`. */
  sourceLabel: string | null
}

export function resolveTable(t: TableModel, env: TypeEnv): ResolvedTable {
  const levelTypes = t.levels.map(l => safeTypes(env, l.receiverText))
  let rowTypes: string[] | null = null
  let sourceLabel: string | null = null
  if (t.shape === 'args' || t.shape === 'columns') {
    rowTypes = t.sourceText ? safeTypes(env, t.sourceText) : null
    sourceLabel = t.sourceText
  }
  if (t.shape === 'rows') {
    const lvl = t.levels.findIndex(l => l.level === 0)
    const baseRowsInLoop = t.rows.length > 0 && t.rows.every(r => r.forEach !== null)
    if (lvl >= 0 && baseRowsInLoop) {
      rowTypes = levelTypes[lvl]
      sourceLabel = t.levels[lvl].receiverText
    }
  }
  return { rowTypes, levelTypes, sourceLabel }
}

function safeTypes(env: TypeEnv, expr: string): string[] | null {
  try {
    const r = env.elementTypes(expr)
    return r && r.length > 0 ? r : null
  } catch {
    return null
  }
}

/** Property list for one or several types, or undefined when any is not loaded. */
export function schemaOf(env: TypeEnv, types: string[] | null): TypeSchemaProp[] | undefined {
  if (!types || types.length === 0) return undefined
  const all = types.map(ty => env.schema(ty))
  if (all.some(s => !s)) return undefined
  return all.length === 1 ? all[0] : intersectTypeSchemas(all as TypeSchemaProp[][])
}

export function typeLabel(env: TypeEnv, types: string[]): string {
  return types.map(ty => env.canonical(ty)).join(' | ')
}

// ── property names ────────────────────────────────────────────

/** Accessors every object answers regardless of its schema. A wrong "no such
 *  property" is worse than a missed one, so these are never flagged. */
const UNIVERSAL = new Set([
  'id', 'rid', 'bid', 'name', 'title', 'description', 'parent', 'children', 'descendants',
  'classname', 'type', 'status', 'created', 'modified', 'createdby', 'modifiedby',
  'createdon', 'modifiedon', 'location', 'path', 'index', 'position', 'level', 'self', 'this', 'root',
])

function lev(a: string, b: string): number {
  if (a === b) return 0
  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

/** The accessors closest to `name`, best first. */
export function closestNames(name: string, candidates: readonly string[], limit = 3): string[] {
  const lower = name.toLowerCase()
  const maxDist = Math.max(2, Math.ceil(lower.length * 0.34))
  const scored: Array<{ c: string; score: number }> = []
  for (const c of candidates) {
    const lc = c.toLowerCase()
    let score = lev(lower, lc)
    if (lower.length >= 3 && (lc.startsWith(lower) || lower.startsWith(lc) || lc.includes(lower))) score = Math.min(score, 1)
    if (score <= maxDist) scored.push({ c, score })
  }
  scored.sort((a, b) => a.score - b.score || a.c.length - b.c.length || a.c.localeCompare(b.c))
  return scored.slice(0, limit).map(s => s.c)
}

function isKnownProperty(name: string, props: TypeSchemaProp[]): boolean {
  const lc = name.toLowerCase()
  if (UNIVERSAL.has(lc)) return true
  for (const p of props) if (p.accessor.toLowerCase() === lc) return true
  return false
}

function describeAccessor(props: TypeSchemaProp[], accessor: string): string {
  const p = props.find(x => x.accessor === accessor)
  return p?.label ? ` (${p.label})` : ''
}

// ── problems ──────────────────────────────────────────────────

export interface ProblemOptions {
  /** Cursor offset: problems the cursor is touching are held back while typing. */
  cursor?: number
}

/** Problems for every table. One pass over the model, no text rescans. */
export function computeTableProblems(tables: readonly TableModel[], env: TypeEnv, opts: ProblemOptions = {}): TableProblem[] {
  const out: TableProblem[] = []
  const cursor = opts.cursor ?? -1
  tables.forEach((t, tableIndex) => {
    if (!t.complete) return
    const resolved = resolveTable(t, env)
    const typing = (from: number, to: number): boolean => cursor >= from && cursor <= to + 1

    // 1. Unknown properties (columns).
    const props = schemaOf(env, resolved.rowTypes)
    if (props && resolved.rowTypes) {
      const tname = typeLabel(env, resolved.rowTypes)
      for (const c of t.columns) {
        if (!c.propIdent || !c.propRange || !c.complete) continue
        if (isKnownProperty(c.propIdent, props)) continue
        if (typing(c.propRange.from, c.propRange.to)) continue
        out.push(unknownProperty(tname, c.propIdent, c.propRange, props, tableIndex))
      }
    }

    // Row values `item.prop`: checked against the type of the row's own forEach.
    if (t.shape === 'rows' || t.shape === 'hierarchy') {
      for (const row of t.rows) {
        if (!row.complete || !row.rowVar || !row.forEach) continue
        const li = t.levels.indexOf(row.forEach)
        const rt = li >= 0 ? resolved.levelTypes[li] : null
        const rprops = schemaOf(env, rt)
        if (!rprops || !rt) continue
        const tname = typeLabel(env, rt)
        for (const v of row.values) {
          const mm = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(v.text)
          if (!mm || mm[1] !== row.rowVar) continue
          if (isKnownProperty(mm[2], rprops)) continue
          if (typing(v.from, v.to)) continue
          const from = v.from + mm[1].length + 1
          out.push(unknownProperty(tname, mm[2], { from, to: v.to }, rprops, tableIndex))
        }
      }
    }

    // 2. addRow value count against the column count.
    if ((t.shape === 'rows' || t.shape === 'hierarchy') && t.columns.length > 0 && t.columns.every(c => c.complete)) {
      for (const row of t.rows) {
        if (!row.complete || !row.rowVar) continue
        if (cursor >= row.call.open && cursor <= row.call.scanEnd + 1) continue
        const n = row.values.length
        const cols = t.columns.length
        if (n < cols) out.push(missingValues(t, row, tableIndex))
        else if (n > cols) out.push(extraValues(t, row, tableIndex))
      }
    }

    // 4. indent(n) against the nesting level.
    if (t.shape === 'hierarchy' && t.levels.every(l => l.complete)) {
      for (const row of t.rows) {
        if (!row.indentCall || row.indent === null || !row.complete) continue
        if (cursor >= row.indentCall.dot && cursor <= row.indentCall.end + 1) continue
        if (row.indent === row.level) continue
        out.push(indentProblem(row, tableIndex))
      }
    }
  })
  return out
}

function unknownProperty(tname: string, prop: string, range: { from: number; to: number }, props: TypeSchemaProp[], tableIndex: number): TableProblem {
  const near = closestNames(prop, props.map(p => p.accessor))
  const hint = near.length ? ` Did you mean ${near[0]}?` : ''
  return {
    kind: 'unknown-property',
    from: range.from,
    to: range.to,
    severity: 'error',
    message: `${tname} has no property ${prop}.${hint}`,
    tableIndex,
    fixes: near.map(n => ({
      label: `Change to ${n}${describeAccessor(props, n)}`,
      changes: [{ from: range.from, to: range.to, insert: n }],
    })),
  }
}

function lastValueEnd(row: RowModel): number {
  return row.values.length ? row.values[row.values.length - 1].to : row.call.args[0].to
}

function missingValues(t: TableModel, row: RowModel, tableIndex: number): TableProblem {
  const n = row.values.length
  const missing = t.columns.slice(n)
  const labels = missing.map(c => c.label || c.prop || `column ${c.index + 1}`)
  const insert = missing.map(c => `, ${c.propIdent ? `${row.rowVar}.${c.propIdent}` : 'MISSING'}`).join('')
  const at = lastValueEnd(row)
  return {
    kind: 'missing-values',
    from: row.from,
    to: row.call.nameFrom + row.call.name.length,
    severity: 'warning',
    message: `This row has ${n} value${n === 1 ? '' : 's'} for ${t.columns.length} columns. Missing: ${labels.join(', ')}.`,
    tableIndex,
    fixes: [{
      label: missing.length === 1 ? `Add value for ${labels[0]}` : `Add ${missing.length} missing values`,
      changes: [{ from: at, to: at, insert }],
    }],
  }
}

function extraValues(t: TableModel, row: RowModel, tableIndex: number): TableProblem {
  const n = row.values.length
  const cols = t.columns.length
  const keepEnd = cols === 0 ? row.call.args[0].to : row.values[cols - 1].to
  const last = row.values[n - 1]
  return {
    kind: 'extra-values',
    from: row.values[cols].from,
    to: last.to,
    severity: 'warning',
    message: `This row has ${n} values for ${cols} columns.`,
    tableIndex,
    fixes: [{
      label: n - cols === 1 ? 'Remove the extra value' : `Remove ${n - cols} extra values`,
      changes: [{ from: keepEnd, to: last.to, insert: '' }],
    }],
  }
}

function indentProblem(row: RowModel, tableIndex: number): TableProblem {
  const call = row.indentCall!
  const want = row.level
  const arg = call.args[0]
  return {
    kind: 'indent',
    from: call.nameFrom,
    to: call.end,
    severity: 'warning',
    message: `This row is at level ${row.level}, but indent(${row.indent}) is used.`,
    tableIndex,
    fixes: [want === 0
      ? { label: 'Remove .indent', changes: [{ from: call.dot, to: call.end, insert: '' }] }
      : { label: `Change to indent(${want})`, changes: [{ from: arg.from, to: arg.to, insert: String(want) }] }],
  }
}

// ── adding a column ───────────────────────────────────────────

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export interface NewColumn { accessor: string; label?: string }

/** The column (call) being typed at `offset`, if the offset sits inside one. */
export function columnAtOffset(t: TableModel, offset: number): ColumnModel | null {
  for (const c of t.columns) {
    if (c.call && offset > c.call.open && offset <= (c.call.close ?? c.call.scanEnd)) return c
  }
  return null
}

/**
 * One edit that finishes the column being typed and keeps the addRow calls in
 * step: replaces the word being completed with the property, closes the call,
 * fills an empty label with the property's label, and appends the matching
 * value to every addRow whose value count matches the other columns.
 */
export function planAddColumn(text: string, t: TableModel, column: ColumnModel | null, prop: NewColumn, word: { from: number; to: number }): Change[] {
  const changes: Change[] = []
  const closed = column?.call?.close != null || /^\s*\)/.test(text.slice(word.to, word.to + 40))
  changes.push({ from: word.from, to: word.to, insert: prop.accessor + (column && !closed ? ')' : '') })
  if (!column) return changes
  if (column.labelRange && column.label === '' && prop.label) {
    changes.push({ from: column.labelRange.from + 1, to: column.labelRange.to - 1, insert: esc(prop.label) })
  }
  const others = t.columns.length - 1
  for (const row of t.rows) {
    if (!row.complete || !row.rowVar || row.values.length !== others) continue
    if (column.index > row.values.length) continue
    const at = column.index === 0 ? row.call.args[0].to : row.values[column.index - 1].to
    changes.push({ from: at, to: at, insert: `, ${row.rowVar}.${prop.accessor}` })
  }
  return changes
}

/** The edit behind "Add column": opens a new `.addColumn("", ` line after the
 *  last column (or appends an argument to `X.table(a, b)`). The cursor lands
 *  where the property is typed, and completion takes it from there. */
export function planNewColumnSlot(text: string, t: TableModel): { change: Change; cursor: number } | null {
  if (!t.tableCall.complete) return null
  if (t.shape === 'args') {
    const last = t.tableCall.args[t.tableCall.args.length - 1]
    if (!last) {
      const at = t.tableCall.open + 1
      return { change: { from: at, to: at, insert: '' }, cursor: at }
    }
    return { change: { from: last.to, to: last.to, insert: ', ' }, cursor: last.to + 2 }
  }
  const lastCol = t.columns[t.columns.length - 1]
  if (lastCol && !lastCol.complete) return null
  const anchor = lastCol ? lastCol.to : t.tableCall.end
  const refPos = lastCol && lastCol.call ? lastCol.call.nameFrom : t.from
  const lineStart = text.lastIndexOf('\n', refPos - 1) + 1
  const lead = /^[ \t]*/.exec(text.slice(lineStart, lineStart + 80))![0]
  const indent = lastCol ? lead : lead + '  '
  const insert = `\n${indent}.addColumn("", `
  return { change: { from: anchor, to: anchor, insert }, cursor: anchor + insert.length }
}
