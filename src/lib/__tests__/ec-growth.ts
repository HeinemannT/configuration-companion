/**
 * Finds text that grows once per element of a loop in an Extended Code script.
 *
 * The server copies the left operand of every text `+`, so `_r := _r + row`
 * inside `list.forEach( … )` costs the square of the list's length. A loop is
 * accepted when its list is cut with `.first(n)`, when a counter cuts it
 * (`IF _n < 200 THEN` around the append), or when the text it appends to is
 * started again inside the loop (a row built per element). Appending
 * inside `list.calculate( … )` to a text of the outer script is the same
 * growth; a row built and returned per element is not.
 *
 * Works on the script text a builder returns, line by line: the builders write
 * one statement per line and open a loop with `.forEach(` or `.calculate(` at
 * the end of a line.
 */

export interface Growth {
  /** The text that grows. */
  variable: string;
  /** The line that opens the loop. */
  loop: string;
  /** The appending line. */
  line: string;
}

/** Parentheses opened minus closed on a line, outside text literals. */
function parenDelta(line: string): number {
  let depth = 0, inText = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inText) { if (c === '\\') i++; else if (c === '"') inText = false; continue; }
    if (c === '"') inText = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return depth;
}

const OPENS_LOOP = /\.(forEach|calculate)\(\s*(_\w+\s*:)?\s*$/;
const APPEND = /^\s*(?:IF .* THEN\s+)?(_\w+) := \1 \+ (.*)$/;
const COUNTED = /^\s*IF _\w+ <=? \d+ THEN\s*$/;
const ASSIGN = /^\s*(_\w+) := (.*)$/;

/** Variables that hold text somewhere in the script: started as `""` or given a text literal. */
function textVariables(lines: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const m = ASSIGN.exec(l);
    if (m && m[2].includes('"')) out.add(m[1]);
  }
  return out;
}

export function growingTexts(script: string): Growth[] {
  const lines = script.split('\n');
  const text = textVariables(lines);
  // Lists cut where they are made: `_l := ….first(200)`.
  const cut = new Set(lines.map(l => ASSIGN.exec(l)).filter(m => m && /\.first\(\s*\d+\s*\)\s*$/.test(m[2])).map(m => m![1]));
  const found: Growth[] = [];
  interface Loop { open: string; depth: number; capped: boolean; started: Set<string>; ifs: boolean[] }
  const loops: Loop[] = [];
  let depth = 0;
  for (const line of lines) {
    const append = APPEND.exec(line);
    const assign = ASSIGN.exec(line);
    if (loops.length) {
      // `IF _n < 200 THEN … ENDIF` around the append: a counter cuts the loop.
      const ifs = loops.at(-1)!.ifs;
      if (/^\s*IF .* THEN\s*$/.test(line)) ifs.push(COUNTED.test(line));
      else if (/^\s*ELSE\s*$/.test(line) && ifs.length) ifs[ifs.length - 1] = false;
      else if (/^\s*ENDIF\s*$/.test(line)) ifs.pop();
      if (append && text.has(append[1]) && loops.some(l => l.ifs.includes(true))) {
        // counted
      } else if (append && text.has(append[1])) {
        // The innermost loop that neither starts this text again nor is cut.
        const outer = loops.filter(l => !l.started.has(append[1]));
        const open = outer.find(l => !l.capped);
        if (open && outer.length) found.push({ variable: append[1], loop: open.open.trim(), line: line.trim() });
      } else if (assign) {
        loops.at(-1)!.started.add(assign[1]);
      }
    }
    const before = depth;
    depth += parenDelta(line);
    if (OPENS_LOOP.test(line) && depth > before) {
      loops.push({ open: line, depth: before, capped: /\.first\(\s*\d+\s*\)/.test(line) || cut.has(/^\s*(_\w+)\./.exec(line)?.[1] ?? ''), started: new Set(), ifs: [] });
    }
    while (loops.length && depth <= loops.at(-1)!.depth) loops.pop();
  }
  return found;
}
