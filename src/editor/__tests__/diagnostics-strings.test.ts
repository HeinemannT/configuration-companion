/**
 * The EC checker reads strings and comments as the editor's tokenizer does:
 * a string may span lines, a backslash escapes a quote, and a quote inside a
 * comment is plain text. Only a string still open at the end of the script is
 * an error.
 */
import { describe, it, expect } from 'vitest';
import { computeEcDiagnostics, maskEcSource } from '../ec/diagnostics';

const errors = (text: string) => computeEcDiagnostics(text).filter(d => d.severity === 'error');

describe('EC checker: string literals over several lines', () => {
  it('accepts a string that continues on the next lines', () => {
    const text = [
      '_facts := _x.scenario + "',
      'Causes: " + _x.causes.whenMissing("") + "',
      'Effects: " + _x.effects.whenMissing("")',
      '_facts',
    ].join('\n');
    expect(errors(text)).toEqual([]);
  });

  it('accepts a string over several lines with CRLF line breaks', () => {
    const text = '_a := "first\r\nsecond\r\nthird"\r\n_a';
    expect(errors(text)).toEqual([]);
  });

  it('does not count IF or ENDIF inside a multi-line string', () => {
    const text = '_t := "Say IF\nnot ENDIF ENDIF"\n_t';
    expect(errors(text)).toEqual([]);
  });

  it('accepts escaped quotes inside a string', () => {
    expect(errors('_q := "He said \\"hi\\" and left"')).toEqual([]);
    expect(errors('_q := "a \\"quoted\nword\\" over two lines"')).toEqual([]);
    expect(errors("_q := 'it\\'s fine'")).toEqual([]);
  });

  it('ignores a quote inside a line comment', () => {
    expect(errors('_x := 1 // don"t count this quote\n_y := 2')).toEqual([]);
    expect(errors("// it's a comment\n_y := 2")).toEqual([]);
  });

  it('ignores a quote inside a block comment over several lines', () => {
    expect(errors('/* a "quote\nand another\' */\n_y := 2')).toEqual([]);
  });

  it('reads // inside a string as text, not as a comment', () => {
    expect(errors('_u := "https://example.test/a"')).toEqual([]);
  });

  it('still reports a string that is never closed, on the line that opens it', () => {
    const text = '_a := 1\n_b := "never closed\n_c := 3';
    const diags = errors(text);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe('Unclosed string literal');
    expect(diags[0].from).toBe(text.indexOf('"'));
    expect(diags[0].to).toBe(text.indexOf('\n', text.indexOf('"')));
  });

  it('still reports a bare IF outside strings', () => {
    const diags = errors('_s := "x\ny" + IF _a THEN 1 ELSE 2 ENDIF');
    expect(diags.map(d => d.message)).toEqual([
      'Bare IF after `+` is a parse error. Wrap as `(IF ... ENDIF)` to use IF as an expression.',
    ]);
  });

  it('keeps every offset and line break of the source', () => {
    const text = '_a := "x\ny" // c\n/* d\ne */ _b';
    const { code } = maskEcSource(text);
    expect(code).toHaveLength(text.length);
    expect(code.split('\n')).toHaveLength(text.split('\n').length);
    expect(code).toBe('_a := " \n "     \n    \n     _b');
  });
});
