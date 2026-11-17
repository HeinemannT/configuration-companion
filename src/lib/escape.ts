/**
 * The one HTML escape for text that reaches an HTML string (`innerHTML`,
 * template-built markup). Escapes the five characters that can end a text
 * run or an attribute value; `null` and `undefined` become ''. Prefer DOM text
 * nodes (`textContent`, `el(...)`) where the markup is built with the DOM.
 *
 * Extended Code literals have their own escaper: `formatEcLiteral` in
 * `ec-guards.ts`.
 */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => HTML_ENTITIES[c]!);
}
