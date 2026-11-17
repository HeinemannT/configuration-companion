/**
 * The one CodeMirror look for every code surface: the Extended Code editor,
 * the CVO studio and the object window's inline editor.
 *
 * Colours come from the crev-light tokens in src/styles/tokens.css through
 * var(): chrome from the semantic layer (--bg, --layer-01, --brand, …), syntax
 * from the --ec-* palette. HighlightStyle emits CSS classes, so var() resolves
 * per page and the same code reads the same everywhere. Each page sets its own
 * font size and padding; this file owns colour and the shared chrome only.
 */
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const v = (name: string) => `var(--ec-${name})`

/** Selection and active-line tints. Every --ec-* token keeps 4.5:1 on both
 *  (tokens.css lists the numbers). */
const SELECTION = 'color-mix(in srgb, var(--brand) 12%, var(--ec-bg))'
const ACTIVE_LINE = 'color-mix(in srgb, var(--brand) 6%, transparent)'

const chrome = EditorView.theme({
  '&': { color: 'var(--text-primary)', backgroundColor: 'var(--ec-bg)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { caretColor: 'var(--brand)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--brand)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: SELECTION },
  '.cm-activeLine': { backgroundColor: ACTIVE_LINE },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--brand) 8%, transparent)', outline: '1px solid var(--brand-line)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--brand-bg)', outline: '1px solid var(--brand)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', outline: '1px dashed var(--support-error)' },
  '.cm-gutters': { backgroundColor: 'var(--ec-bg)', color: 'var(--text-helper)', border: 'none', borderRight: '1px solid var(--border-subtle)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-primary)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-helper)', cursor: 'pointer' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--layer-hover)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', borderRadius: '2px', padding: '0 4px' },

  // Search matches: a tint plus an outline, so the current match is told
  // apart by its stronger outline, not by colour alone.
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--support-warn) 22%, transparent)', outline: '1px solid color-mix(in srgb, var(--support-warn) 70%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--support-warn) 40%, transparent)', outline: '2px solid var(--text-warn)' },

  // ── Panels (find / replace) in the shared light chrome ──
  '.cm-panels': { backgroundColor: 'var(--layer-01)', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border-subtle)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border-subtle)' },
  '.cm-panel.cm-search': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', padding: '4px 36px 4px 8px', fontSize: '12px' },
  '.cm-textfield, .cm-panel.cm-search input[type=text]': {
    height: '24px', margin: '0', padding: '0 8px', backgroundColor: 'var(--bg)', color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: '12px', outline: 'none',
  },
  '.cm-textfield:focus, .cm-panel.cm-search input[type=text]:focus': { outline: '0', borderColor: 'var(--brand)', boxShadow: '0 0 0 1px var(--brand)' },
  // The option toggles show compact glyphs (Aa / .* / W; phrases in
  // cm-scaffold) as small unboxed toggles; the native checkbox is hidden and
  // the pressed state reads by tint and weight.
  '.cm-panel.cm-search label': {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '24px', height: '24px', margin: '0',
    padding: '0 6px', borderRadius: '4px', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: '12px',
    cursor: 'pointer', userSelect: 'none',
  },
  '.cm-panel.cm-search label input': { appearance: 'none', width: '0', height: '0', margin: '0', position: 'absolute' },
  '.cm-panel.cm-search label:hover': { backgroundColor: 'var(--layer-hover)', color: 'var(--text-primary)' },
  '.cm-panel.cm-search label:has(input:checked)': { backgroundColor: 'var(--brand-bg)', color: 'var(--text-brand)', fontWeight: '700', boxShadow: 'inset 0 -2px 0 var(--brand)' },
  '.cm-panel.cm-search label:has(input:focus-visible)': { outline: '2px solid var(--brand)', outlineOffset: '1px' },
  // next / previous / all / replace: small unboxed text buttons.
  '.cm-panel.cm-search button:not([name=close]), .cm-button': {
    height: '24px', margin: '0', padding: '0 8px', backgroundImage: 'none', backgroundColor: 'transparent', color: 'var(--text-secondary)',
    border: 'none', borderRadius: '4px', fontFamily: 'var(--font-ui)', fontSize: '12px', cursor: 'pointer',
  },
  '.cm-panel.cm-search button:not([name=close]):hover, .cm-button:hover': { backgroundColor: 'var(--layer-hover)', color: 'var(--text-primary)' },
  '.cm-panel.cm-search [name=close]': {
    top: '0', bottom: '0', right: '8px', margin: 'auto 0', width: '24px', height: '24px', padding: '0', border: 'none',
    background: 'none', color: 'var(--text-secondary)', fontSize: '16px', lineHeight: '1', borderRadius: '4px', cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': { backgroundColor: 'var(--layer-hover)', color: 'var(--text-primary)' },
  '.cm-panel button:focus-visible, .cm-button:focus-visible': { outline: '2px solid var(--brand)', outlineOffset: '1px' },

  // ── Tooltips and autocomplete ──
  '.cm-tooltip': { backgroundColor: 'var(--bg)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', borderRadius: '4px', boxShadow: 'var(--shadow-2)' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--border-strong)', borderBottomColor: 'var(--border-strong)' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--bg)', borderBottomColor: 'var(--bg)' },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', lineHeight: '20px', borderRadius: '2px', color: 'var(--text-primary)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--brand-bg)', color: 'var(--text-primary)', boxShadow: 'inset 2px 0 var(--brand)' },
  '.cm-completionDetail': { color: 'var(--text-helper)', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-completionInfo': { padding: '4px 8px', fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-secondary)' },

  // ── Lint: shape and colour (wavy underline + gutter glyph), message
  //    carries a left rule so error and warning differ beyond hue. ──
  '.cm-diagnostic': { padding: '4px 8px', fontFamily: 'var(--font-ui)', fontSize: '12px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--support-error)' },
  '.cm-diagnostic-warning': { borderLeft: '3px dashed var(--text-warn)' },
  '.cm-diagnostic-info': { borderLeft: '3px dotted var(--text-helper)' },
})

/** One highlight style for every language. The Extended Code tags come
 *  first; the few extra tags that only the HTML / JavaScript / CSS grammars
 *  produce map onto the same palette. Weight and style carry meaning:
 *  bold = high-signal (writes, engine calls, types), italic = out-of-band
 *  (null, comments), underline = the `.expression` eval-vs-text gotcha. */
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: v('kw'), fontWeight: '500' },
  { tag: tags.special(tags.variableName), color: v('ctx') },
  { tag: tags.bool, color: v('bool') },
  { tag: tags.null, color: v('null'), fontStyle: 'italic' },
  { tag: tags.string, color: v('str') },
  { tag: tags.number, color: v('num') },
  { tag: tags.comment, color: v('cmt'), fontStyle: 'italic' },
  { tag: tags.operator, color: v('op') },
  { tag: tags.constant(tags.name), color: v('style') },
  { tag: tags.atom, color: v('date') },
  { tag: tags.function(tags.variableName), color: v('global') },
  { tag: tags.macroName, color: v('agg'), fontWeight: 'bold' },
  { tag: tags.special(tags.name), color: v('tx'), fontWeight: 'bold' },
  { tag: tags.propertyName, color: v('tbl') },
  { tag: tags.function(tags.name), color: v('read') },
  { tag: tags.className, color: v('class'), fontWeight: 'bold' },
  { tag: tags.namespace, color: v('idspace') },
  { tag: tags.attributeName, color: v('prop') },
  { tag: tags.special(tags.propertyName), color: v('expr'), textDecoration: 'underline' },
  // HTML / JavaScript / CSS only.
  { tag: tags.typeName, color: v('class') },
  { tag: tags.tagName, color: v('kw') },
  { tag: tags.definition(tags.variableName), color: v('read') },
])

/** Chrome + syntax colours, for any code surface on a crev-light page. */
export const codeTheme: Extension = [chrome, syntaxHighlighting(highlightStyle)]
