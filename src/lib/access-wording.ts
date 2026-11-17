/**
 * Shared words for BMP access results, used by the Access workspace and the
 * object window's access mode alike.
 *
 * BMP's access engine is grant-only: it checks only whether a statement's
 * effect is Allow. A matched Deny statement grants nothing and blocks
 * nothing, so it is never shown as a denial.
 */

/** A Deny statement, wherever it is shown. */
export const DENY_IGNORED = 'The server ignores this statement. Deny grants nothing and blocks nothing.';
/** A Deny statement whose subject, action and resource all matched. */
export const DENY_MATCHED = 'Matched, grants nothing';
/** No statement grants the action. */
export const NOT_GRANTED = 'Not granted';
