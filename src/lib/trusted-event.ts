/**
 * Only a real user action may trigger a write from the page.
 *
 * Companion's in-page controls live in the page's DOM, so page script can
 * dispatch clicks and keys on them. The browser marks events it creates from
 * real input as trusted (`isTrusted`); events made by any script are not.
 * Every in-page handler that leads to a server write or saves identity or a
 * setting checks this first and ignores a synthetic event.
 */
export function isUserAction(event: Event): boolean {
  return event.isTrusted === true;
}
