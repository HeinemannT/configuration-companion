/**
 * One word for changes that are not yet written to BMP: "unsaved", on every
 * surface (object window, Extended Code editor, Studio, Blueprint, Access,
 * identity edit, Connect). Blueprint's former "staged" meant the same thing
 * (held in this browser, nothing written yet), so it uses the same word.
 *
 * And one rule for every surface that holds unsaved work: on close, on
 * switching object and on losing its page or server, ask once and name what
 * would be lost; never lose it silently; never ask when nothing is unsaved.
 */

/** "1 unsaved change", "3 unsaved changes". */
export function unsavedCount(n: number): string {
  return `${n} unsaved change${n === 1 ? '' : 's'}`;
}

/** Confirm title: "Discard 3 unsaved changes?"; without a count "Discard unsaved changes?". */
export function discardTitle(n?: number): string {
  return n && n > 0 ? `Discard ${unsavedCount(n)}?` : 'Discard unsaved changes?';
}

/** The rule: ask only when something is unsaved. */
export function mustAskBeforeLeaving(unsaved: number | boolean): boolean {
  return typeof unsaved === 'boolean' ? unsaved : unsaved > 0;
}

/** Labels of the confirm buttons, the same everywhere. */
export const DISCARD_LABEL = 'Discard';
export const KEEP_EDITING_LABEL = 'Keep editing';
