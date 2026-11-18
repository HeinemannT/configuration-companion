/**
 * Static check for unknown property names in `SELECT <Type> FROM … WHERE …`.
 *
 * The server answers `[]` for `WHERE nme = 1` with no hint that `nme` is not a
 * property of the type. This pure checker (text + a field lookup) turns that
 * into a warning. It is deliberately narrow: a missed warning is fine, a false
 * warning is not. See propertyLinter.ts for the async schema wiring.
 *
 * Checked: a plain identifier at the start of a comparison directly in the
 * WHERE clause of a SELECT with ONE literal type, joined by AND/OR, optionally
 * in parentheses. For a dotted chain only the first segment is checked.
 * Skipped: `_vars`, `this`/`self`/`root`, `t.x`-style references, calls, and
 * anything else the scanner does not recognise (it then stops scanning).
 */
import type { Diagnostic } from '@codemirror/lint'
import { maskEcSource } from './diagnostics'
import { ID_SPACE_PREFIXES } from '../../lib/ec-grammar'

/** Field names of a type, or undefined when they are not known for certain. */
export type FieldsOf = (type: string) => string[] | undefined

/** Fields every object has. Never warned about, even when a schema is partial. */
const GENERIC_FIELDS = new Set([
  'id', 'rid', 'name', 'description', 'classname', 'parent', 'organisation',
  'children', 'created', 'createddate', 'lastmodifieddate', 'modifieddate',
  'owner', 'location', 'type',
])

/** Words that are never a property name on the left of a comparison. */
const NOT_PROPERTY = new Set([
  'this', 'self', 'root', 'true', 'false', 'missing', 'null', 'today', 'bop', 'eop',
  'if', 'then', 'else', 'elseif', 'endif', 'select', 'from', 'where', 'and', 'or', 'not',
  'in', 'contains', 'like', 'order', 'group', 'limit', 'return',
])

/** Words that end a comparison value (and with it, the clause). */
const VALUE_STOP = new Set([
  'and', 'or', 'then', 'else', 'elseif', 'endif', 'order', 'group', 'limit',
  'select', 'from', 'where',
])

const SELECT_FROM_RE = /\bSELECT\s+([A-Za-z]\w*)\s+FROM\b/gi
const SOURCE_WHERE_RE = /\s*[\w.]+(?:\([^()]*\))?(?:\.\w+(?:\([^()]*\))?)*\s+WHERE\b/iy
const IDENT_RE = /[A-Za-z_]\w*/y
const OP_RE = /(?:<>|!=|<=|>=|==|=|<|>)|(?:NOT\s+)?(?:LIKE|IN|CONTAINS)\b/iy
const NOT_RE = /NOT\b/iy
const AND_OR_RE = /(?:AND|OR)\b/iy
const WORD_RE = /\w+/y

function sticky(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at
  return re.exec(text)
}

function skipWs(code: string, at: number): number {
  while (at < code.length && /\s/.test(code[at])) at++
  return at
}

/** Index just past the `)` matching the `(` at `open`, or -1. */
function closeParen(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++
    else if (code[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]
}

/** The known field closest to `typed` (edit distance <= 2, or same prefix). */
export function suggestField(typed: string, fields: string[]): string | undefined {
  const t = typed.toLowerCase()
  if (t.length < 2) return undefined
  let best: string | undefined
  let bestScore = Infinity
  for (const f of fields) {
    const l = f.toLowerCase()
    let score = Infinity
    if (t.length >= 3) { const d = distance(t, l); if (d <= 2) score = d }
    if (score === Infinity && l.length > t.length && l.startsWith(t)) score = 2.5
    if (score === Infinity && t.length >= 4 && t.startsWith(l) && l.length >= 3) score = 2.6
    if (score < bestScore || (score === bestScore && best !== undefined && f.length < best.length)) {
      best = f
      bestScore = score
    }
  }
  return best
}

/** Warnings for properties the selected type does not have. Pure. */
export function computeWherePropertyDiagnostics(text: string, fieldsOf: FieldsOf): Diagnostic[] {
  if (!/\bSELECT\b/i.test(text) || !/\bWHERE\b/i.test(text)) return []
  const { code } = maskEcSource(text)
  const diags: Diagnostic[] = []
  const cache = new Map<string, string[] | undefined>()
  const lookup = (type: string): string[] | undefined => {
    const key = type.toLowerCase()
    if (!cache.has(key)) cache.set(key, fieldsOf(type))
    return cache.get(key)
  }

  const check = (type: string, ident: string, from: number): void => {
    const fields = lookup(type)
    if (!fields) return
    const lower = ident.toLowerCase()
    if (GENERIC_FIELDS.has(lower) || fields.some(f => f.toLowerCase() === lower)) return
    const hint = suggestField(ident, fields)
    diags.push({
      from,
      to: from + ident.length,
      severity: 'warning',
      message: `"${ident}" is not a property of ${type}.` + (hint ? ` Did you mean "${hint}"?` : ''),
    })
  }

  const scanClause = (type: string, start: number): void => {
    let p = start
    let depth = 0
    for (;;) {
      // Condition start: any number of `(` and `NOT`.
      for (;;) {
        p = skipWs(code, p)
        if (code[p] === '(') { depth++; p++; continue }
        const not = sticky(NOT_RE, code, p)
        if (not && /[\s(]/.test(code[p + 3] ?? '')) { p += 3; continue }
        break
      }
      const id = sticky(IDENT_RE, code, p)
      if (!id) return
      const ident = id[0]
      const identStart = p
      let q = p + ident.length
      const isCall = code[q] === '('
      const dotted = code[q] === '.'
      // Rest of the left side: `.member` and `(args)` segments.
      for (;;) {
        if (code[q] === '.') {
          const m = sticky(IDENT_RE, code, q + 1)
          if (!m) return
          q += 1 + m[0].length
        } else if (code[q] === '(') {
          const end = closeParen(code, q)
          if (end < 0) return
          q = end
        } else break
      }
      q = skipWs(code, q)
      const op = sticky(OP_RE, code, q)
      if (!op) return
      const lower = ident.toLowerCase()
      const plain = !isCall && !ident.startsWith('_') && !NOT_PROPERTY.has(lower)
        && !(dotted && ID_SPACE_PREFIXES.has(ident))
      if (plain) check(type, ident, identStart)

      // Value: runs to AND/OR, a stop word, an unmatched `)` or the line end.
      let v = q + op[0].length
      let vd = 0
      while (v < code.length) {
        const c = code[v]
        if (c === '\n' || c === '\r') { if (vd === 0) break }
        else if (c === '(') vd++
        else if (c === ')') { if (vd === 0) break; vd-- }
        else if (vd === 0 && /\w/.test(c) && !/[\w.]/.test(code[v - 1] ?? '')) {
          const w = sticky(WORD_RE, code, v)![0]
          if (VALUE_STOP.has(w.toLowerCase())) break
          v += w.length
          continue
        }
        v++
      }

      p = skipWs(code, v)
      while (code[p] === ')') {
        if (depth === 0) return
        depth--
        p = skipWs(code, p + 1)
      }
      const join = sticky(AND_OR_RE, code, p)
      if (!join) return
      p += join[0].length
    }
  }

  SELECT_FROM_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SELECT_FROM_RE.exec(code)) !== null) {
    const src = sticky(SOURCE_WHERE_RE, code, m.index + m[0].length)
    if (!src) continue
    scanClause(m[1], src.index + src[0].length)
  }
  return diags.sort((a, b) => a.from - b.from)
}
