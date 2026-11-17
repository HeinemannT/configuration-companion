/**
 * Canned EC logs in the framed encoding (ec-parser.ts: constant markers,
 * length-framed fields).
 */
import { framedText, STATIC_EC_FRAME } from '../ec-parser';

export const TEST_FRAME = STATIC_EC_FRAME;

/** Framed rows followed by the completion marker. */
export function framedLog(rows: ReadonlyArray<ReadonlyArray<string>>, frame = TEST_FRAME): string {
  return framedText(rows, true, frame);
}

/** Framed rows without the completion marker (a cut-off answer). */
export function framedLogCut(rows: ReadonlyArray<ReadonlyArray<string>>, frame = TEST_FRAME): string {
  return framedText(rows, false, frame);
}

/** The markers of the old wire (before length framing), which some tests
 *  still use to write canned answers readably; `fromSepLog` converts. */
export const OLD_FRAME = { sep: '~CREV_SEP~', row: '~CREV_ROW~', field: '~CREV_FIELD~' } as const;

/** Convert a canned answer written in the old `{sep}key{sep}value\n` block
 *  form (with old framed rows nested in a value) into the current wire: one
 *  `[key, value]` row per block, the completion marker for `{sep}DONE`. A
 *  text without the separator is returned as it is. */
export function fromSepLog(log: string, sep: string = OLD_FRAME.sep): string {
  if (!log.includes(sep)) return log;
  const parts = log.split(sep);
  const rows: string[][] = [];
  let done = false;
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i];
    if (key === 'DONE' || key.startsWith('DONE\n')) { done = true; break; }
    let value = parts[i + 1] ?? '';
    if (value.endsWith('\n')) value = value.slice(0, -1);
    if (value.includes(OLD_FRAME.row)) {
      const nested = value.split(OLD_FRAME.row).slice(1).map(r => (r.endsWith('\n') ? r.slice(0, -1) : r).split(OLD_FRAME.field));
      value = framedText(nested, false);
    } else if (/^\n+$/.test(value)) {
      value = ''; // an empty list block written with its line breaks
    }
    rows.push([key, value]);
  }
  return framedText(rows, done);
}
