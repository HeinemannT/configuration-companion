/**
 * Code search: what a query matches, and how the server narrows the objects
 * that can match it. Pure; shared by the search engine (service worker) and
 * the search window (highlighting).
 *
 * Every query compiles to ONE line matcher (a regular expression, so plain
 * text, whole word and regex searches all mark their matches the same way)
 * and a server prefilter. The prefilter is always a superset of the objects
 * the matcher accepts: the engine reads the code of every candidate and the
 * matcher decides. That is what makes the result complete.
 *
 * Prefilters (measured on BMP 5.6.17; a scan of 1,825 tables takes about
 * 50 ms on the server either way):
 *  - `indexOf`: case-sensitive substring. Extended Code has no case
 *    conversion, so it serves the match-case search and any query without
 *    cased letters, where case does not matter.
 *  - `wildcard`: `text = "*piece*piece*"`. The wildcard comparison is the only
 *    case-insensitive primitive of Extended Code, and it matches across line
 *    breaks. `*`, `?`, `{` and `}` are pattern characters (`{` alone raises
 *    WildcardErr), so the pattern keeps only the printable ASCII runs of the
 *    query without them, joined by `*`: a superset of the case-insensitive
 *    substring.
 *  - `all`: no server filter (a regular expression without a fixed piece of
 *    text). Every object of the scope is a candidate.
 */

import { formatEcLiteral } from './ec-guards';

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export type Prefilter =
  /** Any of the needles occurs (case-sensitive). */
  | { kind: 'indexOf'; needles: string[]; exact: boolean }
  /** `code = pattern` (case-insensitive wildcard). */
  | { kind: 'wildcard'; pattern: string; exact: boolean }
  /** Every object is a candidate. */
  | { kind: 'all'; exact: false };

export interface CompiledSearch {
  /** Match ranges `[start, end)` on one line. */
  ranges(line: string): Array<[number, number]>;
  prefilter: Prefilter;
}

const WORD = '[A-Za-z0-9_]';

/** Characters the wildcard comparison treats as pattern syntax, plus the two
 *  an EC string literal would need escaped. */
const WILDCARD_BREAK = /[*?{}"\\]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the text has letters with an upper and a lower case form. */
export function hasCase(s: string): boolean {
  return s.toLowerCase() !== s.toUpperCase();
}

/** Case-insensitive wildcard pattern that every text containing `s` (in any
 *  case) satisfies, or null when no usable piece is left. */
export function wildcardPattern(s: string): string | null {
  const pieces: string[] = [];
  let cur = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e || WILDCARD_BREAK.test(ch)) {
      if (cur) pieces.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) pieces.push(cur);
  if (!pieces.length) return null;
  return `*${pieces.join('*')}*`;
}

/** True when the wildcard pattern says exactly "contains `s`". */
function wildcardIsExact(s: string, pattern: string | null): boolean {
  return pattern === `*${s}*`;
}

/** Escape text for an EC double-quoted string literal (formatEcLiteral); null
 *  when it holds a line break (the search prefilter never sends one). */
export function ecStringLiteral(s: string): string | null {
  if (/[\r\n]/.test(s)) return null;
  return formatEcLiteral(s);
}

/**
 * The longest piece of literal text every match of `source` must contain, or
 * '' when there is none that is sure. Conservative: a top-level alternation,
 * groups, classes and escapes end a piece, and a character followed by an
 * optional quantifier is dropped.
 */
export function requiredLiteral(source: string): string {
  // A top-level `|` means no single piece is required.
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return '';
  }
  const runs: string[] = [];
  let run = '';
  const end = () => { if (run) runs.push(run); run = ''; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '*' || c === '?' || (c === '{' && /^\{0*(,\d*)?\}/.test(source.slice(i)))) {
      // The last character was optional.
      run = run.slice(0, -1);
      end();
      if (c === '{') i = source.indexOf('}', i);
      if (source[i + 1] === '?' || source[i + 1] === '+') i++;
      continue;
    }
    if (c === '+' || (c === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(i)))) {
      // Repeated at least once: the character stays, the piece ends.
      end();
      if (c === '{') i = source.indexOf('}', i);
      if (source[i + 1] === '?' || source[i + 1] === '+') i++;
      continue;
    }
    if (c === '\\') {
      if (next != null && /[^A-Za-z0-9]/.test(next)) {
        // An escaped punctuation character is literal, unless a quantifier follows.
        run += next;
        i++;
      } else {
        end();
        i++;
        // \x41, \u0041, \cX, \p{…}, \k<…>: skip their arguments.
        if (next === 'x') i += 2;
        else if (next === 'u') i += source[i + 1] === '{' ? source.indexOf('}', i) - i : 4;
        else if (next === 'c') i += 1;
        else if ((next === 'p' || next === 'P') && source[i + 1] === '{') i = source.indexOf('}', i);
        else if (next === 'k' && source[i + 1] === '<') i = source.indexOf('>', i);
      }
      continue;
    }
    if (c === '[') {
      end();
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++;
      while (j < source.length && source[j] !== ']') { if (source[j] === '\\') j++; j++; }
      i = j;
      // A quantifier after the class does not touch the run (already ended).
      continue;
    }
    if (c === '(') {
      end();
      let d = 1;
      let j = i + 1;
      let cls = false;
      while (j < source.length && d > 0) {
        const cj = source[j];
        if (cj === '\\') { j += 2; continue; }
        if (cls) { if (cj === ']') cls = false; }
        else if (cj === '[') cls = true;
        else if (cj === '(') d++;
        else if (cj === ')') d--;
        j++;
      }
      i = j - 1;
      continue;
    }
    if (c === '.' || c === '^' || c === '$' || c === ')' || c === '|') { end(); continue; }
    run += c;
  }
  end();
  // A trailing piece of a quantified run was handled above; pick the longest.
  return runs.reduce((best, r) => (r.length > best.length ? r : best), '');
}

/** The engine's words for common pattern mistakes, in plain words. */
const PATTERN_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/^unterminated group$/i, 'A "(" is not closed with ")".'],
  [/^unmatched '\)'$/i, 'A ")" has no "(" before it.'],
  [/^unterminated character class$/i, 'A "[" is not closed with "]".'],
  [/^nothing to repeat$/i, '"*", "+", "?" or "{" has nothing before it to repeat. Write \\* (and so on) to find the character itself.'],
  [/^lone quantifier brackets$/i, 'A "{" or "}" stands alone. Write \\{ or \\} to find it.'],
  [/^\\ at end of pattern$/i, 'The pattern ends with a single "\\". Write \\\\ to find a backslash.'],
  [/^incomplete quantifier$/i, 'A "{" is not closed with "}". Write \\{ to find it.'],
  [/^invalid (unicode )?escape$/i, 'A "\\" is followed by a character that cannot be escaped here.'],
  [/^invalid group$/i, 'A group starts with "(?" that is not valid.'],
  [/^numbers out of order in \{\} quantifier$/i, 'In {m,n} the first number is larger than the second.'],
  [/^range out of order in character class$/i, 'A range in [...] runs backwards, for example [z-a].'],
];

/** What is wrong with a pattern, in plain words (null: it is valid). The
 *  engine's SyntaxError message without the pattern it repeats
 *  ("Invalid regular expression: /to(day/u: Unterminated group"). */
export function patternProblem(query: string): string | null {
  try { new RegExp(query, 'u'); return null; } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // "Invalid regular expression: /<pattern>/<flags>: <reason>" (V8).
    const m = /^Invalid regular expression: \/[\s\S]*\/[a-z]*: ([^:]+)$/.exec(raw);
    const reason = (m?.[1] ?? raw.replace(/^Invalid regular expression:\s*/i, '')).trim();
    const plain = PATTERN_WORDS.find(([re]) => re.test(reason))?.[1];
    if (plain) return plain;
    const s = reason.replace(/\.$/, '');
    return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : 'The pattern is not valid.';
  }
}

/** Compile a query. Returns `{ error }` for an invalid regular expression or
 *  an empty query. */
export function compileSearch(o: SearchOptions): CompiledSearch | { error: string } {
  const q = o.query;
  if (!q.trim()) return { error: 'Enter something to search for.' };
  let body: string;
  if (o.regex) {
    const problem = patternProblem(q);
    if (problem) return { error: `Not a valid regular expression: ${problem}` };
    body = `(?:${q})`;
  } else {
    body = escapeRegExp(q);
  }
  const source = o.wholeWord ? `(?<!${WORD})${body}(?!${WORD})` : body;
  const re = new RegExp(source, `gu${o.caseSensitive ? '' : 'i'}`);
  const ranges = (line: string): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m[0].length === 0) {
        // An empty match (e.g. `x*`) marks nothing; step past it.
        re.lastIndex++;
        if (re.lastIndex > line.length) break;
        continue;
      }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  };
  const literal = o.regex ? requiredLiteral(q) : q;
  const exactText = !o.regex && !o.wholeWord;
  let prefilter: Prefilter;
  if (!literal || (o.regex && literal.length < 2)) {
    prefilter = { kind: 'all', exact: false };
  } else if (o.caseSensitive || !hasCase(literal)) {
    prefilter = ecStringLiteral(literal) == null
      ? { kind: 'all', exact: false }
      : { kind: 'indexOf', needles: [literal], exact: exactText };
  } else {
    const pattern = wildcardPattern(literal);
    prefilter = pattern
      ? { kind: 'wildcard', pattern, exact: exactText && wildcardIsExact(literal, pattern) }
      : { kind: 'all', exact: false };
  }
  return { ranges, prefilter };
}

/** Prefilter of a "Used in code" search: code that names the object's
 *  business ID or its RID. Every reference form contains one of them. */
export function referencePrefilter(target: { rid: string; businessId: string }): Prefilter {
  const needles = [target.businessId, target.rid].filter(n => n && ecStringLiteral(n) != null);
  return needles.length ? { kind: 'indexOf', needles, exact: false } : { kind: 'all', exact: false };
}
