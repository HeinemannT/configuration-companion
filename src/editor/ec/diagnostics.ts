/**
 * Extended Code lint diagnostics:
 * 1. IF/ENDIF balance
 * 2. forEach colon missing
 * 3. Unclosed string literal (a string may span lines; only a string still
 *    open at the end of the script is an error)
 * 4. Bare inline IF on RHS of `:=` or `+` (parse error in EC)
 * 5. Transactional hint (use Execute not Preview)
 */
import { linter, Diagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'

// Case-insensitive: BMP dispatches `.forEach` / `.foreach` / `.FOREACH`
// identically, so the missing-colon check must fire for every casing.
const FOREACH_RE = /\.forEach\s*\(/i
const TRANSACTIONAL_RE = /\.(delete|add|update|change|move|copy|unlink|link)\s*\(/i

/** EC IF is a STATEMENT, not an expression. `_x := IF ... ENDIF` and
 *  `"str" + IF ... ENDIF` are parse errors — must be parenthesised:
 *  `_x := (IF ... ENDIF)` / `"str" + (IF ... ENDIF)`. The regex matches
 *  the assignment- or concatenation-operator followed by IF *without* an
 *  intervening `(` (the `(` between `\s+` and `IF` would block the match).
 *  Documented in skills/extended-code/reference.md §IF/THEN/ELSE rule 6. */
const BARE_IF_AFTER_OP_RE = /(:=|\+)\s+IF\b/g

/** Find every position on `line` where IF appears bare after `:=` or `+`.
 *  Returns the column range to underline (the IF token itself) plus which
 *  operator preceded it, so the linter can tailor its message. Pure helper
 *  so it can be unit-tested without an EditorView. */
export function findBareIfAfterOp(line: string): Array<{ ifStart: number; ifEnd: number; op: ':=' | '+' }> {
  // Strip comments + string literals so e.g. `"_x := IF cond"` (a string)
  // doesn't false-positive. Mirror the order used by the linter body.
  const stripped = line
    .replace(/\/\/.*$/, '')
    .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
    .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''")
  const out: Array<{ ifStart: number; ifEnd: number; op: ':=' | '+' }> = []
  BARE_IF_AFTER_OP_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BARE_IF_AFTER_OP_RE.exec(stripped)) !== null) {
    const ifEnd = m.index + m[0].length
    out.push({ ifStart: ifEnd - 2, ifEnd, op: m[1] as ':=' | '+' })
  }
  return out
}

/** Result of {@link maskEcSource}: the text with string contents and
 *  comments blanked, and where an unterminated string starts, if one does. */
export interface MaskedEcSource {
  /** Same length and line breaks as the input. Quote characters stay; the
   *  characters inside strings and every comment character become spaces. */
  code: string
  /** Offset of the opening quote of a string that is still open at the end of
   *  the text, or -1. */
  unclosedStringAt: number
}

/** Blank strings and comments the way the editor's tokenizer
 *  (language.ts) reads them: `"…"` and `'…'` with backslash escapes, which
 *  may span lines; `//` to end of line; `/* … *\/` across lines. A quote
 *  inside a comment or a `//` inside a string is ordinary text. */
export function maskEcSource(text: string): MaskedEcSource {
  const out = text.split('')
  let unclosedStringAt = -1
  let i = 0
  const blank = (at: number) => { if (out[at] !== '\n' && out[at] !== '\r') out[at] = ' ' }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') blank(i++)
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      while (i < stop) blank(i++)
      continue
    }
    if (ch === '"' || ch === "'") {
      const open = i++
      let closed = false
      while (i < text.length) {
        const c = text[i]
        if (c === '\\') { blank(i++); if (i < text.length) blank(i++); continue }
        if (c === ch) { closed = true; i++; break }
        blank(i++)
      }
      if (!closed) unclosedStringAt = open
      continue
    }
    i++
  }
  return { code: out.join(''), unclosedStringAt }
}

/** Every diagnostic for `text`. Pure, so it can be tested without an
 *  EditorView; {@link extendedLinter} only hands it the document. */
export function computeEcDiagnostics(text: string): Diagnostic[] {
  const { code, unclosedStringAt } = maskEcSource(text)
  const lines = code.split('\n')
  const diags: Diagnostic[] = []

  let ifDepth = 0
  let lineFrom = 0

  for (let i = 0; i < lines.length; i++) {
    // Strings and comments are blanked, so a comment-only line is empty and
    // a keyword or quote inside a string or comment is never counted.
    const raw = lines[i]
    const lineTo = lineFrom + raw.length

    if (raw.trim()) {
      // IF/ENDIF balance
      const ifCount = (raw.match(/\bIF\b/g) || []).length
      const endifCount = (raw.match(/\bENDIF\b/g) || []).length
      // Subtract ENDIF from count of IF on same line to handle same-line IF ENDIF
      ifDepth += ifCount - endifCount
      if (ifDepth < 0) {
        // Extra ENDIF
        const col = raw.indexOf('ENDIF')
        diags.push({
          from: lineFrom + (col >= 0 ? col : 0),
          to: lineFrom + (col >= 0 ? col + 5 : raw.length),
          severity: 'error',
          message: 'ENDIF without matching IF',
        })
        ifDepth = 0
      }

      // forEach colon check — detect .forEach( and verify colon after iterator variable
      const foreachMatch = raw.match(FOREACH_RE)
      if (foreachMatch) {
        const afterParen = raw.slice(raw.indexOf('(', foreachMatch.index!) + 1)
        // If line has the opening ( but argument part has no colon, warn
        if (!afterParen.includes(':') && !afterParen.trimEnd().endsWith(')')) {
          diags.push({
            from: lineFrom,
            to: lineTo,
            severity: 'warning',
            message: 'forEach body requires ":" after iterator variable',
          })
        }
      }

      // Bare inline IF on RHS — needs parens.
      for (const hit of findBareIfAfterOp(raw)) {
        diags.push({
          from: lineFrom + hit.ifStart,
          to: lineFrom + hit.ifEnd,
          severity: 'error',
          message: hit.op === ':='
            ? 'Bare IF after `:=` is a parse error. Wrap as `(IF ... ENDIF)` to use IF as an expression.'
            : 'Bare IF after `+` is a parse error. Wrap as `(IF ... ENDIF)` to use IF as an expression.',
        })
      }
    }

    lineFrom = lineTo + 1 // +1 for newline
  }

  // A string may span lines; it is only an error when the script ends inside
  // it. Mark the line that opens it.
  if (unclosedStringAt >= 0) {
    const lineEnd = text.indexOf('\n', unclosedStringAt)
    diags.push({
      from: unclosedStringAt,
      to: lineEnd < 0 ? text.length : lineEnd,
      severity: 'error',
      message: 'Unclosed string literal',
    })
  }

  // IF without ENDIF (end of document)
  if (ifDepth > 0) {
    const lastLineFrom = text.lastIndexOf('\n') + 1
    diags.push({
      from: lastLineFrom,
      to: text.length,
      severity: 'error',
      message: `${ifDepth} IF block${ifDepth > 1 ? 's' : ''} not closed with ENDIF`,
    })
  }

  // Transactional hint — info only
  const transMatch = TRANSACTIONAL_RE.exec(text)
  if (transMatch) {
    diags.push({
      from: text.indexOf(transMatch[0]),
      to: text.indexOf(transMatch[0]) + transMatch[0].length,
      severity: 'info',
      message: 'Script contains transactional operations. Use Execute (not Preview) to commit changes.',
    })
  }

  return diags
}

export const extendedLinter = linter((view: EditorView): Diagnostic[] =>
  computeEcDiagnostics(view.state.doc.toString()))
