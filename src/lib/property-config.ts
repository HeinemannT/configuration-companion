/** BMP uses the same MethodConfig class for a master property definition and
 * its per-object-type ClassConfig application. Applications link back to the
 * master through `linkedTo`; master definitions do not. */
export function isPropertyConfigClass(type: string): boolean {
  return type.endsWith('MethodConfig');
}

/** Historical property configs are ordinary MethodConfig objects with a
 *  time-series modifier. Presentation layers use this predicate to add the
 *  shared history mark without maintaining their own type lists. */
export function isHistoricalPropertyConfigClass(type: string): boolean {
  return isPropertyConfigClass(type) && type.startsWith('Historical');
}

export function isMasterPropertyDefinition(type: string, linkedMaster: unknown): boolean {
  return isPropertyConfigClass(type) && linkedMaster == null;
}

/** Decode an EC string literal from `genedit()` (an application's override). */
export function decodeEcLiteral(literal: string): string {
  const trimmed = literal.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) return trimmed;
  return trimmed.slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
