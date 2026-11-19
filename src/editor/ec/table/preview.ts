/**
 * Data from the user's last preview, mapped onto the table's columns.
 *
 * The preview is never run by the editor; this module only reads the output the
 * user's own Preview produced. Values are matched to columns by position and
 * trusted only while the code still matches what was previewed.
 */
import { parseEcOutput } from '../../ec-output'
import { parseTables, type ColumnModel, type TableModel } from './model'

export interface LastPreview {
  /** Exact code that was sent. */
  code: string
  /** Raw output text. */
  text: string
  /** When it finished (ms since epoch). */
  at: number
  /** Round trip in ms, when known. */
  durationMs: number | null
  mode: 'preview' | 'execute'
}

export interface PreviewTable { headers: string[]; rows: string[][] }

/** First table in the output, cells trimmed. Reuses the Output tab's parser. */
export function extractPreviewTable(output: string): PreviewTable | null {
  for (const block of parseEcOutput(output, true, true)) {
    if (block.kind === 'table') {
      return {
        headers: block.headers.map(h => h.trim()),
        rows: block.rows.map(r => r.map(c => c.trim())),
      }
    }
  }
  return null
}

/** Index in the previewed table's output for each column of `columns`, or null
 *  when the output cannot be matched safely. */
export function mapColumns(table: PreviewTable, columns: readonly ColumnModel[]): Array<number | null> | null {
  const n = table.headers.length
  if (columns.length === 0 || n === 0) return null
  if (columns.length === n) return columns.map((_, i) => i)
  const visible = columns.filter(c => !c.hidden)
  if (visible.length === n && visible.length !== columns.length) {
    let k = 0
    return columns.map(c => (c.hidden ? null : k++))
  }
  // Same labels in the same order is enough to match when every column has one.
  if (columns.every(c => c.label) && columns.every(c => table.headers.includes(c.label as string))) {
    const used = new Set<number>()
    const map = columns.map(c => {
      const at = table.headers.findIndex((h, i) => h === c.label && !used.has(i))
      if (at >= 0) used.add(at)
      return at >= 0 ? at : null
    })
    return map.every(v => v !== null) ? map : null
  }
  return null
}

export interface ColumnStats {
  rows: number
  empty: number
  distinct: number
  /** First values that are not empty. */
  sample: string[]
  /** Range text for a column where every non-empty value is a number. */
  range: { min: string; max: string } | null
  allSame: boolean
}

function toNumber(s: string): number | null {
  const t = s.replace(/\s/g, '')
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''))
  return null
}

export function columnStats(values: readonly string[], sampleSize = 3): ColumnStats {
  let empty = 0
  const seen = new Set<string>()
  const sample: string[] = []
  let allNumeric = true
  let min: { n: number; s: string } | null = null
  let max: { n: number; s: string } | null = null
  for (const v of values) {
    if (v === '') { empty++; continue }
    seen.add(v)
    if (sample.length < sampleSize) sample.push(v)
    const num = toNumber(v)
    if (num === null) allNumeric = false
    else {
      if (!min || num < min.n) min = { n: num, s: v }
      if (!max || num > max.n) max = { n: num, s: v }
    }
  }
  const filled = values.length - empty
  return {
    rows: values.length,
    empty,
    distinct: seen.size,
    sample,
    range: allNumeric && min && max && filled > 0 ? { min: min.s, max: max.s } : null,
    allSame: seen.size === 1 && values.length > 1 && empty === 0,
  }
}

export function columnValues(table: PreviewTable, outputIndex: number): string[] {
  return table.rows.map(r => r[outputIndex] ?? '')
}

// ── which table the output belongs to ─────────────────────────

/** Index of the table that produced the output: the one whose variable is the
 *  script's last expression, else the last table. -1 when there is none. */
export function pickPreviewTable(code: string, tables: readonly TableModel[]): number {
  if (tables.length === 0) return -1
  if (tables.length === 1) return 0
  const lines = code.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t || t.startsWith('//')) continue
    const idx = tables.map(x => x.varName).lastIndexOf(t)
    return idx >= 0 ? idx : tables.length - 1
  }
  return tables.length - 1
}

// ── freshness ─────────────────────────────────────────────────

/** Whitespace and comments do not change what a script computes. */
function normalize(text: string): string {
  const parts: string[] = []
  const n = text.length
  let i = 0
  let from = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 34 || c === 39) {
      i++
      while (i < n) {
        const d = text.charCodeAt(i)
        if (d === 92) { i += 2; continue }
        if (d === c || d === 10) break
        i++
      }
      i++
    } else if (c === 47 && text.charCodeAt(i + 1) === 47) {
      parts.push(text.slice(from, i))
      const j = text.indexOf('\n', i)
      i = j < 0 ? n : j
      from = i
    } else if (c === 47 && text.charCodeAt(i + 1) === 42) {
      parts.push(text.slice(from, i))
      const j = text.indexOf('*/', i + 2)
      i = j < 0 ? n : j + 2
      from = i
      parts.push(' ')
    } else i++
  }
  parts.push(text.slice(from))
  return parts.join('').replace(/\s+/g, ' ').trim()
}

export type Freshness =
  | { state: 'fresh' }
  | { state: 'stale' }
  /** Same shape; only these columns were edited since the preview. */
  | { state: 'columns'; changed: ReadonlySet<number> }

function blankColumns(text: string, tables: readonly TableModel[]): string {
  const ranges: Array<[number, number]> = []
  for (const t of tables) for (const c of t.columns) if (c.source === 'addColumn') ranges.push([c.from, c.to])
  ranges.sort((a, b) => a[0] - b[0])
  let out = ''
  let last = 0
  for (const [a, b] of ranges) {
    if (a < last) continue
    out += text.slice(last, a)
    last = b
  }
  return out + text.slice(last)
}

/** Compare the code now with the code that was previewed. Edits to a column's
 *  own declaration leave the other columns' values valid; anything else that
 *  could change the data (source, filter, row values) makes everything stale. */
export function compareToPreview(
  current: { text: string; tables: readonly TableModel[]; target: number },
  previewed: { text: string; tables: readonly TableModel[]; target: number },
): Freshness {
  if (current.text === previewed.text) return { state: 'fresh' }
  const a = normalize(blankColumns(current.text, current.tables))
  const b = normalize(blankColumns(previewed.text, previewed.tables))
  if (a !== b || current.tables.length !== previewed.tables.length) return { state: 'stale' }
  const ct = current.tables[current.target]
  const pt = previewed.tables[previewed.target]
  if (!ct || !pt || ct.columns.length !== pt.columns.length) return { state: 'stale' }
  const changed = new Set<number>()
  ct.columns.forEach((c, i) => {
    if (normalize(current.text.slice(c.from, c.to)) !== normalize(previewed.text.slice(pt.columns[i].from, pt.columns[i].to))) changed.add(i)
  })
  return changed.size === 0 ? { state: 'fresh' } : { state: 'columns', changed }
}

// ── the stored preview, ready to read ─────────────────────────

export interface PreviewData {
  preview: LastPreview
  table: PreviewTable | null
  tables: TableModel[]
  /** Index into `tables` of the table that produced the output. */
  target: number
  /** Per column of the previewed table: output column index, or null. */
  mapping: Array<number | null> | null
}

/** Analyse a finished preview once, when it arrives. */
export function analysePreview(preview: LastPreview): PreviewData {
  const table = extractPreviewTable(preview.text)
  const tables = parseTables(preview.code)
  const target = pickPreviewTable(preview.code, tables)
  const mapping = table && target >= 0 ? mapColumns(table, tables[target].columns) : null
  return { preview, table, tables, target, mapping }
}

export interface ColumnValues {
  stats: ColumnStats
  /** Column edited since the preview: values are not shown. */
  stale: boolean
}

/** Values for column `index` of the current table, or null when there is no
 *  trustworthy data for it. */
export function valuesForColumn(
  data: PreviewData,
  index: number,
  freshness: Freshness,
): ColumnValues | null {
  if (!data.table || !data.mapping || freshness.state === 'stale') return null
  const out = data.mapping[index]
  if (out === null || out === undefined) return null
  if (freshness.state === 'columns' && freshness.changed.has(index)) return { stats: columnStats([]), stale: true }
  return { stats: columnStats(columnValues(data.table, out)), stale: false }
}

/** One line of faint text for a column: first values and what the data shows. */
export function describeValues(stats: ColumnStats): string {
  const parts: string[] = []
  if (stats.sample.length) parts.push(stats.sample.join(' · '))
  if (stats.allSame) parts.push(`same value in all ${stats.rows} rows`)
  else if (stats.empty > 0) parts.push(stats.empty === stats.rows ? 'all empty' : `${stats.empty} empty`)
  else if (stats.rows === 0) parts.push('no rows')
  return parts.join(' · ')
}

/** Footer text under a column in the Table tab. */
export function footerText(stats: ColumnStats): string {
  if (stats.range) return stats.range.min === stats.range.max ? stats.range.min : `${stats.range.min} to ${stats.range.max}`
  if (stats.empty > 0) return stats.empty === stats.rows ? 'all empty' : `${stats.empty} empty`
  if (stats.allSame) return 'all the same'
  return `${stats.rows} values`
}
