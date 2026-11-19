/**
 * Parse an Extended Code script on the server without running it: the text
 * goes in a branch that never runs. Measured on a BMP server: a syntax error
 * comes back as a failed run with the parser's message, a valid script as
 * "parsed", and nothing in the branch runs. An unknown ID inside the branch is
 * not reported. Pure; the service worker sends it (EC_SYNTAX_CHECK).
 */

import { describeEcError } from './ec-error-copy';

/** The text the server parses without running it: the script in a branch
 *  that never runs. A syntax error is reported; an unknown ID is not. The
 *  wrapper adds one line before the script. */
export function wrapForSyntaxCheck(text: string): string {
  return `IF 1 = 2 THEN\n${text}\nENDIF\n"parsed"`;
}

/** The server's parse answer for a wrapped script in the user's words: line
 *  numbers count the script, not the wrapper. */
export function syntaxProblemText(raw: string): string {
  const shift = (s: string) => s.replace(/\bline (\d+)/g, (_a, n: string) => `line ${Math.max(1, Number(n) - 1)}`)
    .replace(/\blocation \((\d+),/g, (_a, n: string) => `location (${Math.max(1, Number(n) - 1)},`);
  const text = shift(raw.trim());
  const described = describeEcError(text);
  const first = (described?.summary ?? text.split(/\r?\n/)[0] ?? '').trim();
  return first || 'The server could not read this script.';
}
