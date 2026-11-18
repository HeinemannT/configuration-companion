import { describe, expect, it } from 'vitest'
import { describeEcError } from '../ec-error-copy'

const summary = (raw: string) => describeEcError(raw)?.summary

describe('describeEcError', () => {
  it('rewords a JavaCC error with a keyword token', () => {
    const raw = 'Encountered " "FROM" "FROM "" at line 1, column 8.\nWas expecting:\n    <FIRSTREF> ...'
    expect(describeEcError(raw)).toEqual({ summary: 'Unexpected "FROM" at line 1, column 8.', raw })
  })

  it('rewords a JavaCC error with a single token', () => {
    expect(summary('Encountered " .WHENMISSING( " at line 1, column 10.\nWas expecting one of: <EOF>'))
      .toBe('Unexpected ".WHENMISSING(" at line 1, column 10.')
  })

  it('names the end of the script for <EOF>', () => {
    expect(summary('Encountered "<EOF>" at line 3, column 2.\nWas expecting:\n    ")" ...'))
      .toBe('Unexpected end of the script at line 3, column 2.')
  })

  it('falls back to generic text when the token cannot be read', () => {
    expect(summary('Encountered " "a" "b" "c" " at line 2, column 4.')).toBe('Unexpected text at line 2, column 4.')
    // A token kind in angle brackets, then the text as written (seen live for `.x`).
    expect(summary('Encountered " <REFERENCE> ".x "" at line 1, column 1.\nWas expecting one of:\n    "SELECT" ...')).toBe('Unexpected ".x" at line 1, column 1.')
  })

  it('rewords the dot-name missing value form', () => {
    expect(summary('Missing value for .x at line 1, column 2')).toBe('Nothing found for ".x" at line 1, column 2.')
  })

  it('does not reword other missing value messages', () => {
    expect(describeEcError('Missing value for IF')).toBeNull()
    expect(describeEcError('Missing value for t.cc_other')).toBeNull()
  })

  it('rewords the location form without interpreting the rest', () => {
    expect(summary('location (1,8) : Type Name not found')).toBe('Line 1, column 8: Type Name not found')
  })

  it('leaves already readable messages alone', () => {
    for (const raw of [
      'Property status not found on TextElement',
      'Property other not found at line 1, column 3',
      "Can't add an object of type Kpi under t.page",
      'Failed to write description on t.el_new',
      'Error at line 271, column 11: Method size can only be on a list, text or map (near .size())',
      'EC execution timed out (5s)',
      'Not connected',
    ]) expect(describeEcError(raw)).toBeNull()
  })

  it('returns null when the text holds more than one error', () => {
    expect(describeEcError('Encountered " "FROM" "FROM "" at line 1, column 8.\nWas expecting:\n    <X> ...\nlocation (2,1) : Bad')).toBeNull()
    expect(describeEcError('Missing value for .x at line 1, column 2\nMissing value for .y at line 3, column 2')).toBeNull()
    expect(describeEcError('Encountered " "A" "A "" at line 1, column 1.\nSomething else')).toBeNull()
  })
})
