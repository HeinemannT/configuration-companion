import { describe, expect, it } from 'vitest';
import { growingTexts } from './ec-growth';

const script = (...lines: string[]) => lines.join('\n');

describe('growingTexts', () => {
  it('finds a text that grows once per element of a loop', () => {
    const found = growingTexts(script('_r := ""', '_l := SELECT Kpi FROM root', '_l.forEach(_o:', '     _r := _r + _o.name + ";"', ')', '_r'));
    expect(found).toEqual([{ variable: '_r', loop: '_l.forEach(_o:', line: '_r := _r + _o.name + ";"' }]);
  });

  it('finds it inside calculate when the text belongs to the outer script', () => {
    expect(growingTexts(script('_r := ""', '_x := _l.calculate(', '     _r := _r + self.name', '     ""', ')'))).toHaveLength(1);
  });

  it('finds it under a condition and in an inner loop', () => {
    expect(growingTexts(script('_r := ""', '_l.forEach(_o:', '     IF _o.name <> "" THEN _r := _r + _o.name ELSE _r := _r ENDIF', ')'))).toHaveLength(1);
    expect(growingTexts(script('_r := ""', '_l.first(5).forEach(_o:', '     _o.children().forEach(_c:', '          _r := _r + _c.name', '     )', ')'))).toHaveLength(1);
  });

  it('accepts a list cut with first(n), on the loop or where the list is made', () => {
    expect(growingTexts(script('_r := ""', '_l.first(200).forEach(_o:', '     _r := _r + _o.name', ')'))).toEqual([]);
    expect(growingTexts(script('_r := ""', '_l := (SELECT Kpi FROM root).first(200)', '_l.forEach(_o:', '     _r := _r + _o.name', ')'))).toEqual([]);
  });

  it('accepts a loop cut by a counter, but not its ELSE branch', () => {
    expect(growingTexts(script('_r := ""', '_n := 0', '_l.forEach(_o:', '     _n := _n + 1', '     IF _n <= 200 THEN', '          _r := _r + _o.name', '     ELSE', '          _r := _r', '     ENDIF', ')'))).toEqual([]);
    expect(growingTexts(script('_r := ""', '_n := 0', '_l.forEach(_o:', '     IF _n <= 200 THEN', '          _n := _n + 1', '     ELSE', '          _r := _r + _o.name', '     ENDIF', ')'))).toHaveLength(1);
  });

  it('accepts a row started again per element and rows joined once', () => {
    expect(growingTexts(script('_r := ""', '_x := _l.calculate(', '     _o := self', '     _row := ""', '     _row := _row + _o.name', '     _row', ')', '_r := _r + _x.join("").whenMissing("")'))).toEqual([]);
  });

  it('ignores numbers and parentheses inside text', () => {
    expect(growingTexts(script('_n := 0', '_t := ""', '_l.forEach(_o:', '     _n := _n + 1', '     _t := "(" + _o.name', ')'))).toEqual([]);
  });
});
