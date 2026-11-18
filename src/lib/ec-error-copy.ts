/**
 * Plain-language summaries for the few BMP parser errors that are hard to read raw.
 * Conservative: only a message that is exactly one error of a known shape is reworded.
 * Anything else returns null and the caller shows the server text unchanged.
 */

export interface EcErrorCopy {
  /** Reworded first line for the user. */
  summary: string
  /** The server text, unchanged. */
  raw: string
}

const JAVACC = /^Encountered "([\s\S]*?)" at line (\d+), column (\d+)\.(?:\r?\n([\s\S]*))?$/
const MISSING_VALUE = /^Missing value for (\.[A-Za-z_]\w*) at line (\d+), column (\d+)$/
const LOCATION = /^location \((\d+),(\d+)\) : (\S[^\r\n]*)$/
const SECOND_ERROR = /Encountered "|\bat line \d+|\blocation \(\d+,\d+\)/

/** The offending text from JavaCC's `" "KIND" "image" "` quoting, or null when unclear. */
function offendingText(inner: string): string | null {
  const t = inner.trim()
  if (t === '<EOF>' || t === '"<EOF>"') return '<EOF>'
  // `"FROM" "FROM "` or `<REFERENCE> ".x "`: the token kind, then the text as written.
  const pair = /^(?:"[^"]*"|<\w+>)\s+"([^"]*)"$/.exec(t)
  const text = (pair ? pair[1] : t.includes('"') ? '' : t).trim()
  return text || null
}

export function describeEcError(raw: string): EcErrorCopy | null {
  const text = raw.trim()
  if (!text) return null

  const parsed = JAVACC.exec(text)
  if (parsed) {
    const rest = parsed[4]
    // The only thing allowed after the first line is its own "Was expecting" list.
    if (rest !== undefined && (!/^Was expecting/.test(rest) || SECOND_ERROR.test(rest))) return null
    const where = `at line ${parsed[2]}, column ${parsed[3]}.`
    const found = offendingText(parsed[1])
    const summary = found === '<EOF>' ? `Unexpected end of the script ${where}`
      : found ? `Unexpected "${found}" ${where}`
      : `Unexpected text ${where}`
    return { summary, raw }
  }

  const missing = MISSING_VALUE.exec(text)
  if (missing) return { summary: `Nothing found for "${missing[1]}" at line ${missing[2]}, column ${missing[3]}.`, raw }

  const loc = LOCATION.exec(text)
  if (loc) return { summary: `Line ${loc[1]}, column ${loc[2]}: ${loc[3]}`, raw }

  return null
}
