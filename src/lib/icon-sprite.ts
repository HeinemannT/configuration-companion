/** SVG symbol sprite of the extension pages (object window, code search, Compare, side panel):
 *  16px stroke icons. Drawn with the DOM kit's icon() (lib/dom.ts). The object-type glyphs
 *  (`o-*`) come from lib/object-glyphs.ts, the one icon set for BMP object types. */
import { GLYPH_SYMBOLS } from './object-glyphs';

export const ICON_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="i-back" viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></symbol>
<symbol id="i-fwd" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5"/></symbol>
<symbol id="i-copy" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></symbol>
<symbol id="i-check" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></symbol>
<symbol id="i-popout" viewBox="0 0 16 16"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5"/></symbol>
<symbol id="i-expand" viewBox="0 0 16 16"><path d="M8 2.5v4M6 4.5l2 2 2-2M8 13.5v-4M6 11.5l2-2 2 2M3 8h10"/></symbol>
<symbol id="i-collapse" viewBox="0 0 16 16"><path d="M8 6.5v-4M6 4.5l2-2 2 2M8 9.5v4M6 11.5l2 2 2-2M3 8h10"/></symbol>
<symbol id="i-ownwin" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M2.5 6.5h11"/></symbol>
<symbol id="i-chev" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></symbol>
<symbol id="i-image" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7" r="1"/><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 3"/></symbol>
<symbol id="i-link" viewBox="0 0 16 16"><path d="M6.8 9.2l2.4-2.4M7.2 4.8l.9-.9a2.4 2.4 0 013.4 3.4l-.9.9M8.8 11.2l-.9.9a2.4 2.4 0 01-3.4-3.4l.9-.9"/></symbol>
<symbol id="i-right" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></symbol>
<symbol id="i-dots" viewBox="0 0 16 16"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.2"/></symbol>
<symbol id="i-refs" viewBox="0 0 16 16"><path d="M6.5 10.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM9 9l4.5 4.5M11 4.5h3M12.5 3v3"/></symbol>
<symbol id="i-clock" viewBox="0 0 16 16"><path d="M8 13.5a5.5 5.5 0 100-11 5.5 5.5 0 000 11zM8 5v3.2l2 1.3"/></symbol>
<symbol id="i-plug" viewBox="0 0 16 16"><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 01-7 0zM8 11.5v2M2.5 2.5l11 11"/></symbol>
<symbol id="k-text" viewBox="0 0 16 16"><path d="M4 4.5h8M8 4.5V12"/></symbol>
<symbol id="k-num" viewBox="0 0 16 16"><path d="M6.5 3l-1 10M10.5 3l-1 10M3.5 6.5H13M3 9.5h9.5"/></symbol>
<symbol id="k-bool" viewBox="0 0 16 16"><rect x="2" y="5" width="12" height="6" rx="3"/><circle cx="11" cy="8" r="1.4"/></symbol>
<symbol id="k-choice" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M5.8 7.2L8 9.4l2.2-2.2"/></symbol>
<symbol id="k-code" viewBox="0 0 16 16"><path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5"/></symbol>
<symbol id="k-file" viewBox="0 0 16 16"><path d="M9 2.5H5A1.5 1.5 0 0 0 3.5 4v8A1.5 1.5 0 0 0 5 13.5h6a1.5 1.5 0 0 0 1.5-1.5V6zM9 2.5V6h3.5"/></symbol>
<symbol id="k-date" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/></symbol>
<symbol id="k-refs" viewBox="0 0 16 16"><path d="M2.5 4.5h6M2.5 8h4M2.5 11.5h6M10 6l3 2-3 2"/></symbol>
<symbol id="k-other" viewBox="0 0 16 16"><circle cx="8" cy="8" r="1.6"/></symbol>
<symbol id="i-list" viewBox="0 0 16 16"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></symbol>
<symbol id="i-arrow" viewBox="0 0 16 16"><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5"/></symbol>
<symbol id="i-search" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/></symbol>
<symbol id="i-out" viewBox="0 0 16 16"><path d="M5 11l6-6M6 5h5v5"/></symbol>
<symbol id="i-info" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 7.5v3.2M8 5.3v.1"/></symbol>
<symbol id="i-share" viewBox="0 0 16 16"><circle cx="4.5" cy="8" r="1.8"/><circle cx="11.5" cy="4.5" r="1.8"/><circle cx="11.5" cy="11.5" r="1.8"/><path d="M6.1 7.2l3.8-1.9M6.1 8.8l3.8 1.9"/></symbol>
<symbol id="i-tree" viewBox="0 0 16 16"><path d="M3 3.5h4M5 3.5v9M5 8h3M5 12.5h3M10 6.5h3v3h-3zM10 11h3v3h-3z" transform="translate(0 -1)"/></symbol>
<symbol id="k-view" viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6h11M6 6v7"/></symbol>
<symbol id="k-set" viewBox="0 0 16 16"><path d="M3 4h10M3 8h10M3 12h6"/></symbol>
<symbol id="k-text" viewBox="0 0 16 16"><path d="M3.5 5V4h9v1M8 4v8M6.5 12h3"/></symbol>
<symbol id="k-number" viewBox="0 0 16 16"><path d="M6.5 3 5.5 13M10.5 3l-1 10M3.5 6h9M3 10h9"/></symbol>
<symbol id="k-date" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/></symbol>
<symbol id="k-choice" viewBox="0 0 16 16"><rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M6 7.3l2 2 2-2"/></symbol>
<symbol id="k-ref" viewBox="0 0 16 16"><path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.7.7M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7"/></symbol>
<symbol id="k-label" viewBox="0 0 16 16"><path d="M4 12.5 8 3.5l4 9M5.6 9.5h4.8"/></symbol>
<symbol id="k-group" viewBox="0 0 16 16"><path d="M5.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1.5M10.5 3H12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1.5"/></symbol>
<symbol id="k-button" viewBox="0 0 16 16"><rect x="2.5" y="5" width="11" height="6" rx="2"/><path d="M5.5 8h5"/></symbol>
<symbol id="k-notify" viewBox="0 0 16 16"><path d="M4.5 11V7a3.5 3.5 0 0 1 7 0v4l1 1h-9zM6.8 13.5h2.4"/></symbol>
<symbol id="k-field" viewBox="0 0 16 16"><rect x="2.5" y="4.5" width="11" height="7" rx="1.5"/><path d="M5 8h2.5"/></symbol>
<symbol id="k-code" viewBox="0 0 16 16"><path d="M6 5 3 8l3 3M10 5l3 3-3 3"/></symbol>
<symbol id="k-container" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke-dasharray="2.5 2"/></symbol>
<symbol id="k-page" viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="9" height="11" rx="1.5"/><path d="M6 6h4M6 9h4"/></symbol>
<symbol id="k-pagebreak" viewBox="0 0 16 16"><path d="M2.5 8h2.5M7 8h2M11 8h2.5M6 4.5l2-2 2 2M6 11.5l2 2 2-2"/></symbol>
<symbol id="k-colbreak" viewBox="0 0 16 16"><path d="M8 2.5v2.5M8 7v2M8 11v2.5M4.5 6l-2 2 2 2M11.5 6l2 2-2 2"/></symbol>
<symbol id="k-scorecard" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 11V8.5M8 11V5.5M10.5 11V7"/></symbol>
<symbol id="k-braces" viewBox="0 0 16 16"><path d="M6 3.5H5.5A1.5 1.5 0 0 0 4 5v1.5A1.5 1.5 0 0 1 2.5 8 1.5 1.5 0 0 1 4 9.5V11a1.5 1.5 0 0 0 1.5 1.5H6M10 3.5h.5A1.5 1.5 0 0 1 12 5v1.5A1.5 1.5 0 0 0 13.5 8a1.5 1.5 0 0 0-1.5 1.5V11a1.5 1.5 0 0 1-1.5 1.5H10"/></symbol>
<symbol id="k-checklist" viewBox="0 0 16 16"><path d="M2.5 4.5l1 1 2-2M2.5 10.5l1 1 2-2M8 4.5h5.5M8 10.5h5.5"/></symbol>
<symbol id="k-check" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8.5l2 2 3-4"/></symbol>
<symbol id="k-risk" viewBox="0 0 16 16"><path d="M8 2.5l6 10.5H2zM8 6.8v3M8 11.5v.1"/></symbol>
<symbol id="k-template" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6h11M6 6v7.5"/></symbol>
<symbol id="k-spacer" viewBox="0 0 16 16"><path d="M3 8h3M10 8h3"/></symbol>
<symbol id="k-chart" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 8h11M8 2.5v11"/></symbol>
<symbol id="k-table" viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M2.5 9.8h11M6.5 6.5V13"/></symbol>
<symbol id="k-desc" viewBox="0 0 16 16"><path d="M3 4.5h4M3 8h10M3 11.5h7"/></symbol>
<symbol id="k-create" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 5.5v5M5.5 8h5"/></symbol>
<symbol id="k-object"viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2"/></symbol>
<symbol id="i-pencil" viewBox="0 0 16 16"><path d="M10.5 3.5l2 2-7 7-3 .8.8-3z"/></symbol>
<symbol id="i-undo" viewBox="0 0 16 16"><path d="M6 4.5 3.5 7 6 9.5M4 7h5a3 3 0 0 1 0 6H6.5"/></symbol>
<symbol id="i-plus" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9"/></symbol>
<symbol id="i-compare" viewBox="0 0 16 16"><rect x="2.5" y="3" width="4.5" height="10" rx="1"/><rect x="9" y="3" width="4.5" height="10" rx="1"/></symbol>
<symbol id="i-lock" viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></symbol>
<symbol id="i-shield" viewBox="0 0 16 16"><path d="M8 2.5l4.5 1.6v4c0 2.6-1.8 4.3-4.5 5.4-2.7-1.1-4.5-2.8-4.5-5.4v-4z"/><circle cx="8" cy="7" r="1.1"/><path d="M8 8.1v2"/></symbol>
<symbol id="i-user" viewBox="0 0 16 16"><circle cx="8" cy="5.5" r="2.5"/><path d="M3 13c.5-2.5 2.5-3.5 5-3.5s4.5 1 5 3.5"/></symbol>
<symbol id="i-role" viewBox="0 0 16 16"><circle cx="6" cy="6" r="2"/><path d="M2.5 12.5c.4-2 1.8-3 3.5-3s3.1 1 3.5 3"/><circle cx="11.5" cy="6.5" r="1.5"/><path d="M11 9.6c1.6 0 2.5.9 2.8 2.4"/></symbol>
<symbol id="i-allow" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="currentColor" stroke="none"/><path d="M5.2 8.2l2 2 3.6-4" stroke="var(--bg, #fff)" stroke-width="1.75"/></symbol>
<symbol id="i-deny" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/></symbol>
<symbol id="i-warn" viewBox="0 0 16 16"><path d="M8 2.8 14 13H2z"/><path d="M8 6.8v2.7M8 11.4v.1"/></symbol>
<symbol id="i-x" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></symbol>
<symbol id="i-dash" viewBox="0 0 16 16"><path d="M5 8h6"/></symbol>
<symbol id="i-expall" viewBox="0 0 16 16"><path d="M5 3.5l3 3 3-3M5 12.5l3-3 3 3"/></symbol>
<symbol id="i-colall" viewBox="0 0 16 16"><path d="M5 6.5l3-3 3 3M5 9.5l3 3 3-3"/></symbol>
<symbol id="i-pin" viewBox="0 0 16 16"><path d="M10 2.5 13.5 6l-2 .8-2.6 2.6.4 2.6-1.1 1.1L3 8.3l1.1-1.1 2.6.4 2.6-2.6z"/><path d="M5.6 10.4 2.5 13.5"/></symbol>
<symbol id="i-swap" viewBox="0 0 16 16"><path d="M3 5h9m-2.5-2.5L12 5l-2.5 2.5M13 11H4m2.5-2.5L4 11l2.5 2.5"/></symbol>
<symbol id="i-ok" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><path d="m5.2 8.2 2 2 3.8-4"/></symbol>
<symbol id="i-no" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.6v4.2"/><circle cx="8" cy="11.2" r=".9" fill="currentColor" stroke="none"/></symbol>
<symbol id="i-retry" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v2.5h-2.5"/></symbol>
${GLYPH_SYMBOLS}
</defs></svg>`;
