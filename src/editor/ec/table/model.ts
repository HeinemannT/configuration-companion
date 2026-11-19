/**
 * Table model for Extended Code: text in, a model of every `.table()` statement
 * out (with offsets and 1-based lines). Pure, no CodeMirror and no I/O.
 *
 * Recognised shapes (anything else is ignored, never an error):
 *   args       X.table(a, b)
 *   columns    X.table().addColumn("Label", p) ...
 *   rows       LIST().table().addColumn(...) + src.forEach(item: _t.addRow(item, item.p, ...))
 *   hierarchy  the rows shape with nested forEach levels and `.indent(N).collapse()`
 *
 * Design constraints (the user is typing, the model runs on every change):
 *   - never throws; half-typed code yields incomplete calls that consumers skip
 *   - one pass: the text is masked once (strings and comments blanked, same
 *     length, newlines kept), every scan runs on the mask
 *   - cheap exit when the text has no `.table(` at all
 *   - a call whose closing paren cannot be trusted is `complete: false` rather
 *     than swallowing the rest of the document
 */

export interface Range { from: number; to: number }

export interface Arg {
  index: number
  /** Trimmed range of the argument in the source text. */
  from: number
  to: number
  /** Trimmed source text of the argument. */
  text: string
}

export interface Call {
  name: string
  /** Offset of the method name. */
  nameFrom: number
  /** Offset of the leading `.` (or nameFrom when there is none). */
  dot: number
  /** Offset of `(`. */
  open: number
  /** Offset of `)`, or null when the call is not closed (half typed). */
  close: number | null
  /** Offset just after `)`, or the end of the half-typed text (trailing blanks trimmed) when not closed. */
  end: number
  /** Like `end`, but for a half-typed call it runs to the line break, so a cursor after trailing blanks is still inside. */
  scanEnd: number
  args: Arg[]
  complete: boolean
}

export interface ColumnModel {
  index: number
  source: 'addColumn' | 'tableArg'
  /** Decoded label when the first addColumn argument is a string literal. */
  label: string | null
  /** Range of the label literal including its quotes. */
  labelRange: Range | null
  /** Source text of the property expression, when there is one. */
  prop: string | null
  propRange: Range | null
  /** The property when it is exactly one identifier (`ermq_status`). */
  propIdent: string | null
  /** Range from the leading dot of addColumn through its last chained call. */
  from: number
  to: number
  /** 1-based line of the addColumn call name. */
  line: number
  /** Chained modifiers after the column call: align, decimals, style, hidden... */
  chain: Call[]
  align: string | null
  hasAlign: boolean
  hidden: boolean
  /** False while the call is still being typed. */
  complete: boolean
  call: Call | null
}

export interface RowModel {
  call: Call
  /** Range from the row variable through the last chained call. */
  from: number
  to: number
  line: number
  /** The first argument when it is a plain identifier (the row's object). */
  rowVar: string | null
  /** Arguments after the first one. */
  values: Arg[]
  chain: Call[]
  indent: number | null
  indentCall: Call | null
  collapse: boolean
  /** Nesting level relative to the table's shallowest rows. */
  level: number
  /** Innermost enclosing forEach, if any. */
  forEach: LevelModel | null
  complete: boolean
}

export interface LevelModel {
  /** 0 is the forEach holding the table's shallowest rows. */
  level: number
  param: string | null
  receiverText: string
  receiverFrom: number
  receiverTo: number
  /** Offset of the forEach call's leading dot. */
  from: number
  /** Offset of the forEach close paren (or end of text when not closed). */
  to: number
  /** 1-based line where the receiver expression starts. */
  line: number
  /** Offset of the start of that line. */
  lineFrom: number
  complete: boolean
  /** Number of enclosing forEach spans. */
  depth: number
}

export type TableShape = 'args' | 'columns' | 'rows' | 'hierarchy'

export interface TableModel {
  shape: TableShape
  varName: string | null
  /** Statement range: start of the receiver expression through the last chained call. */
  from: number
  to: number
  /** 1-based line the lens sits above, and the offset of that line's start. */
  lensLine: number
  lensFrom: number
  /** Receiver text of `.table(` (null when it is `LIST()` or empty). */
  sourceText: string | null
  sourceRange: Range | null
  sourceIsList: boolean
  tableCall: Call
  columns: ColumnModel[]
  rows: RowModel[]
  /** forEach spans around this table's rows, outermost first (levels >= 0 only). */
  levels: LevelModel[]
  /** Table call and every call of the statement are closed. */
  complete: boolean
}

// ── masking ───────────────────────────────────────────────────

const blank = (s: string): string => s.replace(/[^\n]/g, ' ')

/** Same-length copy of `text` with string-literal contents and comments turned
 *  into spaces (newlines kept), so paren/comma/dot scans cannot be fooled by
 *  text inside strings. An unclosed string ends at its line break. */
export function maskCode(text: string): string {
  const n = text.length
  const parts: string[] = []
  let last = 0
  let i = 0
  while (i < n) {
    const c = text.charCodeAt(i)
    if (c === 34 || c === 39) {
      let j = i + 1
      while (j < n) {
        const d = text.charCodeAt(j)
        if (d === 92) { j += 2; continue }
        if (d === c || d === 10) break
        j++
      }
      if (j > n) j = n
      parts.push(text.slice(last, i + 1), blank(text.slice(i + 1, j)))
      last = j
      i = j < n && text.charCodeAt(j) === c ? j + 1 : j
      continue
    }
    if (c === 47) {
      const d = text.charCodeAt(i + 1)
      if (d === 47) {
        let j = text.indexOf('\n', i)
        if (j < 0) j = n
        parts.push(text.slice(last, i), ' '.repeat(j - i))
        last = j
        i = j
        continue
      }
      if (d === 42) {
        let j = text.indexOf('*/', i + 2)
        j = j < 0 ? n : j + 2
        parts.push(text.slice(last, i), blank(text.slice(i, j)))
        last = j
        i = j
        continue
      }
    }
    i++
  }
  if (last === 0) return text
  parts.push(text.slice(last))
  return parts.join('')
}

function isIdentCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}
function isWs(c: number): boolean { return c === 32 || c === 9 || c === 10 || c === 13 }

function lineStartsOf(text: string): number[] {
  const starts = [0]
  let i = text.indexOf('\n')
  while (i >= 0) {
    starts.push(i + 1)
    i = text.indexOf('\n', i + 1)
  }
  return starts
}

/** 1-based line containing `offset`. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// ── calls ─────────────────────────────────────────────────────

const MAX_CALL_CHARS = 6000
/** A new `.addColumn(` / `x.addRow(` at a line start inside an open call means the
 *  call was never closed. */
const NEW_CALL_LINE = /[ \t]*(?:[A-Za-z_]\w*)?\.\s*(?:addColumn|addRow)\s*\(/iy

/** Offset of the `)` closing the call opened at `open`, or null when it is not
 *  closed or the closing paren cannot be trusted (see the comments). */
function scanClose(m: string, open: number, isForEach: boolean): number | null {
  const n = m.length
  const limit = isForEach ? n : Math.min(n, open + MAX_CALL_CHARS)
  let depth = 1
  for (let i = open + 1; i < limit; i++) {
    const c = m.charCodeAt(i)
    if (c === 40) depth++
    else if (c === 41) {
      depth--
      if (depth === 0) {
        if (!isForEach) {
          // A `)` alone at the start of a line right after a trailing comma is
          // the paren of an enclosing forEach, not this call's.
          let k = i - 1
          while (k > open && (m.charCodeAt(k) === 32 || m.charCodeAt(k) === 9)) k--
          if (m.charCodeAt(k) === 10) {
            while (k > open && isWs(m.charCodeAt(k))) k--
            if (m.charCodeAt(k) === 44 || k <= open) return null
          }
        }
        return i
      }
    } else if (!isForEach) {
      if (c === 58 && m.charCodeAt(i + 1) === 61) return null // `:=` cannot sit inside call arguments
      if (c === 10) {
        NEW_CALL_LINE.lastIndex = i + 1
        if (NEW_CALL_LINE.test(m)) return null
      }
    }
  }
  return null
}

function endOfLine(m: string, from: number): number {
  const i = m.indexOf('\n', from)
  return i < 0 ? m.length : i
}

/** Split the text between two offsets at top-level commas. */
function splitArgs(text: string, m: string, from: number, to: number): Arg[] {
  const out: Arg[] = []
  let depth = 0
  let start = from
  const push = (a: number, b: number): void => {
    while (a < b && isWs(m.charCodeAt(a))) a++
    while (b > a && isWs(m.charCodeAt(b - 1))) b--
    out.push({ index: out.length, from: a, to: b, text: text.slice(a, b) })
  }
  for (let i = from; i < to; i++) {
    const c = m.charCodeAt(i)
    if (c === 40 || c === 91 || c === 123) depth++
    else if (c === 41 || c === 93 || c === 125) depth--
    else if (c === 44 && depth === 0) {
      push(start, i)
      start = i + 1
    }
  }
  push(start, to)
  if (out.length === 1 && out[0].text === '') return []
  return out
}

function parseCall(text: string, m: string, nameFrom: number, name: string, dot: number, open: number, isForEach = false): Call {
  const close = scanClose(m, open, isForEach)
  if (close !== null) {
    return { name, nameFrom, dot, open, close, end: close + 1, scanEnd: close + 1, args: isForEach ? [] : splitArgs(text, m, open + 1, close), complete: true }
  }
  let e = endOfLine(m, open)
  while (e > open + 1 && isWs(m.charCodeAt(e - 1))) e--
  return { name, nameFrom, dot, open, close: null, end: e, scanEnd: endOfLine(m, open), args: isForEach ? [] : splitArgs(text, m, open + 1, e), complete: false }
}

const CALL_AT = /\s*\.\s*([A-Za-z_]\w*)\s*\(/y

/** The `.name(` call that starts at/after `pos` (whitespace allowed), if any. */
function nextCall(text: string, m: string, pos: number): Call | null {
  CALL_AT.lastIndex = pos
  const r = CALL_AT.exec(m)
  if (!r) return null
  const open = r.index + r[0].length - 1
  let p = open - 1
  while (p > r.index && isWs(m.charCodeAt(p))) p--
  const nameFrom = p + 1 - r[1].length
  const dot = m.lastIndexOf('.', nameFrom - 1)
  return parseCall(text, m, nameFrom, r[1], dot < r.index ? nameFrom : dot, open)
}

/** Start offset of the receiver chain left of the dot at `dot` (identifiers,
 *  dots and balanced call/paren groups, across line breaks only next to a dot),
 *  or -1 when there is no receiver. */
function walkReceiver(m: string, dot: number): number {
  let i = dot - 1
  let start = -1
  for (let guard = 0; guard < 64; guard++) {
    let j = i
    while (j >= 0 && isWs(m.charCodeAt(j))) j--
    if (j < 0) break
    let opStart: number
    if (m.charCodeAt(j) === 41) {
      let depth = 0
      let k = j
      const floor = Math.max(0, j - 4000)
      for (; k >= floor; k--) {
        const c = m.charCodeAt(k)
        if (c === 41) depth++
        else if (c === 40) { depth--; if (depth === 0) break }
      }
      if (k < floor || depth !== 0) break
      while (k > 0 && isIdentCode(m.charCodeAt(k - 1))) k--
      opStart = k
    } else if (isIdentCode(m.charCodeAt(j))) {
      let k = j
      while (k > 0 && isIdentCode(m.charCodeAt(k - 1))) k--
      opStart = k
    } else break
    start = opStart
    const p = opStart - 1
    if (p >= 0 && m.charCodeAt(p) === 46) { i = p - 1; continue }
    break
  }
  return start
}

// ── literals ──────────────────────────────────────────────────

/** Decoded value of a complete string literal, else null. */
export function stringLiteral(text: string): string | null {
  const t = text.trim()
  if (t.length < 2) return null
  const q = t[0]
  if ((q !== '"' && q !== "'") || t[t.length - 1] !== q) return null
  return t.slice(1, -1).replace(/\\(["'\\])/g, '$1')
}

const SIMPLE_IDENT = /^[A-Za-z_]\w*$/

// ── the pass ──────────────────────────────────────────────────

interface Span { level: LevelModel; call: Call }

/** Parse every table statement in `text`. Never throws. */
export function parseTables(text: string): TableModel[] {
  try {
    return parseTablesUnsafe(text)
  } catch {
    return []
  }
}

function parseTablesUnsafe(text: string): TableModel[] {
  if (!/\.\s*table\s*\(/i.test(text)) return []
  const m = maskCode(text)
  const starts = lineStartsOf(text)
  const tables: TableModel[] = []

  const tableRe = /\.\s*table\s*\(/gi
  let hit: RegExpExecArray | null
  while ((hit = tableRe.exec(m)) !== null) {
    const dot = hit.index
    const open = dot + hit[0].length - 1
    const tableCall = parseCall(text, m, dot + hit[0].search(/table/i), 'table', dot, open)
    const recvStart = walkReceiver(m, dot)
    if (recvStart < 0) { tableRe.lastIndex = Math.max(tableRe.lastIndex, tableCall.end); continue }

    // Statement variable: `_t :=` directly before the receiver.
    const before = m.slice(Math.max(0, recvStart - 300), recvStart)
    const assign = /([A-Za-z_]\w*)\s*:=\s*$/.exec(before)
    const varName = assign ? assign[1] : null
    const stmtFrom = assign ? recvStart - (before.length - assign.index) : recvStart

    const receiverText = text.slice(recvStart, dot).replace(/\s+/g, ' ').trim()
    const sourceIsList = /^LIST\s*\(\s*\)$/i.test(receiverText)

    // Chained calls after `.table(...)`.
    const chain: Call[] = []
    let end = tableCall.end
    // A half-typed call ends at its line; the chain may still continue on the next line.
    while (tableCall.complete) {
      const c = nextCall(text, m, end)
      if (!c) break
      chain.push(c)
      end = c.end
    }

    const columns: ColumnModel[] = []
    const chainRows: Call[] = []
    let cur: ColumnModel | null = null
    for (const c of chain) {
      const lname = c.name.toLowerCase()
      if (lname === 'addcolumn') {
        cur = columnFromCall(text, c, columns.length, starts)
        columns.push(cur)
      } else if (lname === 'addrow') {
        chainRows.push(c)
        cur = null
      } else if (cur) {
        cur.chain.push(c)
        cur.to = c.end
        if (lname === 'align') {
          cur.hasAlign = true
          const lit = c.args.length ? stringLiteral(c.args[0].text) : null
          cur.align = lit ? lit.toLowerCase() : (c.args[0]?.text.toLowerCase() ?? null)
        } else if (lname === 'hidden') cur.hidden = true
      }
    }

    // `X.table(a, b)`: the arguments are the columns (a leading title string is not one).
    if (columns.length === 0 && tableCall.args.length > 0) {
      const args = tableCall.args.length > 1 && stringLiteral(tableCall.args[0].text) !== null
        ? tableCall.args.slice(1)
        : tableCall.args
      if (!(args.length === 1 && stringLiteral(args[0].text) !== null)) {
        for (const a of args) columns.push(columnFromArg(a, columns.length, starts, tableCall.complete))
      }
    }

    const lensFromOffset = assign ? stmtFrom : recvStart
    const lensLine = lineAt(starts, lensFromOffset)
    tables.push({
      shape: columns.length > 0 && columns[0].source === 'tableArg' ? 'args' : 'columns',
      varName,
      from: stmtFrom,
      to: end,
      lensLine,
      lensFrom: starts[lensLine - 1],
      sourceText: sourceIsList || receiverText === '' ? null : receiverText,
      sourceRange: sourceIsList ? null : { from: recvStart, to: dot },
      sourceIsList,
      tableCall,
      columns,
      rows: [],
      levels: [],
      complete: tableCall.complete && chain.every(c => c.complete),
    })
    // Rows chained straight onto the table call (`.table().addColumn(..).addRow(..)`).
    for (const rc of chainRows) {
      const t = tables[tables.length - 1]
      t.rows.push(rowFromCall(text, m, rc, starts))
    }
    tableRe.lastIndex = Math.max(tableRe.lastIndex, end)
  }
  if (tables.length === 0) return tables

  attachRows(text, m, starts, tables)
  return tables
}

function columnFromCall(text: string, c: Call, index: number, starts: number[]): ColumnModel {
  const a0 = c.args[0]
  const a1 = c.args[1]
  let label: string | null = null
  let labelRange: Range | null = null
  let propArg: Arg | null = null
  if (c.args.length >= 2) {
    label = a0 ? stringLiteral(a0.text) : null
    labelRange = a0 && label !== null ? { from: a0.from, to: a0.to } : null
    propArg = a1 && a1.text !== '' ? a1 : null
  } else if (c.args.length === 1) {
    const lit = stringLiteral(a0.text)
    if (lit !== null) { label = lit; labelRange = { from: a0.from, to: a0.to } }
    else propArg = a0
  }
  return {
    index,
    source: 'addColumn',
    label,
    labelRange,
    prop: propArg ? propArg.text : null,
    propRange: propArg ? { from: propArg.from, to: propArg.to } : null,
    propIdent: propArg && SIMPLE_IDENT.test(propArg.text) ? propArg.text : null,
    from: c.dot,
    to: c.end,
    line: lineAt(starts, c.nameFrom),
    chain: [],
    align: null,
    hasAlign: false,
    hidden: false,
    complete: c.complete && propArg !== null,
    call: c,
  }
}

function columnFromArg(a: Arg, index: number, starts: number[], complete: boolean): ColumnModel {
  return {
    index,
    source: 'tableArg',
    label: null,
    labelRange: null,
    prop: a.text || null,
    propRange: a.text ? { from: a.from, to: a.to } : null,
    propIdent: SIMPLE_IDENT.test(a.text) ? a.text : null,
    from: a.from,
    to: a.to,
    line: lineAt(starts, a.from),
    chain: [],
    align: null,
    hasAlign: false,
    hidden: false,
    complete: complete && a.text !== '',
    call: null,
  }
}

function rowFromCall(text: string, m: string, c: Call, starts: number[]): RowModel {
  const chain: Call[] = []
  let end = c.end
  let prev = c
  while (prev.complete) {
    const n = nextCall(text, m, end)
    if (!n || !['indent', 'collapse', 'expand', 'style', 'align', 'hidden'].includes(n.name.toLowerCase())) break
    chain.push(n)
    end = n.end
    prev = n
  }
  const first = c.args[0]
  let indent: number | null = null
  let indentCall: Call | null = null
  let collapse = false
  for (const ch of chain) {
    const ln = ch.name.toLowerCase()
    if (ln === 'indent') {
      indentCall = ch
      const v = ch.args[0]?.text ?? ''
      indent = /^\d+$/.test(v) ? Number(v) : null
    } else if (ln === 'collapse') collapse = true
  }
  return {
    call: c,
    from: c.nameFrom,
    to: end,
    line: lineAt(starts, c.nameFrom),
    rowVar: first && SIMPLE_IDENT.test(first.text) ? first.text : null,
    values: c.args.slice(1),
    chain,
    indent,
    indentCall,
    collapse,
    level: 0,
    forEach: null,
    complete: c.complete && c.args.length > 0 && c.args.every(a => a.text !== ''),
  }
}

/** Find `<var>.addRow(` rows, the forEach spans around them, and hang both on their tables. */
function attachRows(text: string, m: string, starts: number[], tables: TableModel[]): void {
  const byVar = new Map<string, TableModel[]>()
  for (const t of tables) {
    if (!t.varName) continue
    const list = byVar.get(t.varName)
    if (list) list.push(t)
    else byVar.set(t.varName, [t])
  }

  // addRow calls, in document order, with their table.
  interface RowHit { row: RowModel; table: TableModel; pos: number }
  const hits: RowHit[] = []
  const rowRe = /([A-Za-z_]\w*)\s*\.\s*addRow\s*\(/gi
  let r: RegExpExecArray | null
  while (byVar.size > 0 && (r = rowRe.exec(m)) !== null) {
    const pos = r.index
    if (pos > 0 && m.charCodeAt(pos - 1) === 46) continue // `a.b.addRow(`: not a bare table variable
    const cands = byVar.get(r[1])
    if (!cands) continue
    let table: TableModel | null = null
    for (const t of cands) if (t.from < pos) table = t
    if (!table) continue
    const open = rowRe.lastIndex - 1
    let p = open - 1
    while (p > pos && isWs(m.charCodeAt(p))) p--
    const nameFrom = p + 1 - 'addRow'.length
    const dot = m.lastIndexOf('.', nameFrom - 1)
    const call = parseCall(text, m, nameFrom, 'addRow', dot, open)
    const row = rowFromCall(text, m, call, starts)
    row.from = pos
    row.line = lineAt(starts, pos)
    hits.push({ row, table, pos })
    rowRe.lastIndex = Math.max(rowRe.lastIndex, call.end)
  }
  // Rows chained onto the table call itself already sit in `table.rows`; merge by position.
  for (const t of tables) for (const row of t.rows) hits.push({ row, table: t, pos: row.from })
  if (hits.length === 0) return
  hits.sort((a, b) => a.pos - b.pos)

  // forEach spans in document order.
  const spans: Span[] = []
  const feRe = /\.\s*forEach\s*\(/gi
  let f: RegExpExecArray | null
  while ((f = feRe.exec(m)) !== null) {
    const dot = f.index
    const open = dot + f[0].length - 1
    const call = parseCall(text, m, dot + 1, 'forEach', dot, open, true)
    const recv = walkReceiver(m, dot)
    const recvFrom = recv < 0 ? dot : recv
    const bodyTo = call.close ?? m.length
    // `(item:` parameter
    const pm = /^\s*([A-Za-z_]\w*)\s*:/.exec(m.slice(open + 1, Math.min(bodyTo, open + 200)))
    const startLine = lineAt(starts, recvFrom)
    spans.push({
      call,
      level: {
        level: -1,
        param: pm ? pm[1] : null,
        receiverText: text.slice(recvFrom, dot).replace(/\s+/g, ' ').trim(),
        receiverFrom: recvFrom,
        receiverTo: dot,
        from: dot,
        to: bodyTo,
        line: startLine,
        lineFrom: starts[startLine - 1],
        complete: call.complete,
        depth: 0,
      },
    })
  }

  // Sweep rows and spans together to find each row's enclosing spans.
  const stack: Span[] = []
  let si = 0
  const enclosingByRow = new Map<RowModel, Span[]>()
  const popClosed = (pos: number): void => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].level.to < pos) stack.splice(k, 1)
  }
  for (const h of hits) {
    while (si < spans.length && spans[si].level.from < h.pos) {
      popClosed(spans[si].level.from)
      spans[si].level.depth = stack.length
      stack.push(spans[si])
      si++
    }
    popClosed(h.pos)
    enclosingByRow.set(h.row, stack.slice())
    h.row.forEach = stack.length ? stack[stack.length - 1].level : null
  }

  // Assemble per table.
  const grouped = new Map<TableModel, RowHit[]>()
  for (const h of hits) {
    const list = grouped.get(h.table)
    if (list) list.push(h)
    else grouped.set(h.table, [h])
  }
  for (const [table, list] of grouped) {
    table.rows = list.map(h => h.row)
    let base = Infinity
    for (const h of list) base = Math.min(base, enclosingByRow.get(h.row)!.length)
    // One LevelModel per forEach per table (a forEach could surround two tables).
    const copies = new Map<LevelModel, LevelModel>()
    for (const h of list) {
      const enc = enclosingByRow.get(h.row)!
      h.row.level = enc.length - base
      for (const sp of enc) {
        const idx = sp.level.depth + 1 - base
        if (idx >= 0 && !copies.has(sp.level)) copies.set(sp.level, { ...sp.level, level: idx })
      }
      h.row.forEach = enc.length ? copies.get(enc[enc.length - 1].level) ?? null : null
    }
    table.levels = [...copies.values()].sort((a, b) => a.from - b.from)
    if (table.shape !== 'args') {
      const depths = new Set(list.map(h => h.row.level))
      table.shape = depths.size >= 2 ? 'hierarchy' : 'rows'
    }
  }
}

// ── queries ───────────────────────────────────────────────────

/** The table whose statement or rows contain `offset`, if any. */
export function tableAt(tables: readonly TableModel[], offset: number): TableModel | null {
  let best: TableModel | null = null
  for (const t of tables) {
    let to = t.to
    for (const c of t.columns) if (c.call && c.call.scanEnd > to) to = c.call.scanEnd
    for (const r of t.rows) if (r.to > to) to = r.to
    for (const l of t.levels) if (l.to > to && l.to <= to + 4000) to = Math.max(to, l.to)
    if (offset >= t.from && offset <= to) best = t
  }
  return best
}

/** Which column the cursor belongs to: the column call it sits in, or the
 *  addRow value position it sits in. */
export function activeColumn(table: TableModel, offset: number): number | null {
  for (const c of table.columns) if (offset >= c.from && offset <= c.to) return c.index
  for (const r of table.rows) {
    if (offset < r.call.open || offset > r.call.scanEnd) continue
    const args = r.call.args
    for (let k = 0; k < args.length; k++) {
      if (offset <= args[k].to + 1) return k >= 1 ? k - 1 : null
    }
    return null
  }
  return null
}
