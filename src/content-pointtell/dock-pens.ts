/**
 * Point and tell: the pens of the dock, drawn as objects. Upright, nib at the top, 32 x 128: the brush pen
 * (white body, purple nib) and the eraser. Only the upper part shows in the dock; the active pen lifts.
 * Gradient ids are fixed: the dock is the only place these are drawn on a page.
 */
const NS = 'http://www.w3.org/2000/svg';

const defs = (id: string, c: [string, string, string]): string => `<defs>
  <linearGradient id="${id}b" x1="0" x2="1"><stop offset="0" stop-color="#e4e8ee"/><stop offset=".22" stop-color="#ffffff"/><stop offset=".62" stop-color="#f1f3f6"/><stop offset="1" stop-color="#c9cfd8"/></linearGradient>
  <linearGradient id="${id}c" x1="0" x2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset=".45" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[2]}"/></linearGradient>
  <linearGradient id="${id}m" x1="0" x2="1"><stop offset="0" stop-color="#aab1bc"/><stop offset=".35" stop-color="#f6f7f9"/><stop offset=".7" stop-color="#c3c9d2"/><stop offset="1" stop-color="#8f97a3"/></linearGradient>
</defs>`;

const STROKE = 'stroke="rgba(20,22,28,.18)" stroke-width=".5"';

/** The brush pen: purple nib, a steel ferrule, a white body with one purple band. */
export function brushPenSvg(): string {
  const g = 'ptpb';
  return `<svg viewBox="0 0 32 128" xmlns="${NS}" aria-hidden="true">${defs(g, ['#a774ff', '#8a3ffc', '#5f20c4'])}
  <path d="M16 3.5C14.9 8 12.4 13.5 12.1 21.5L19.9 21.5C19.6 13.5 17.1 8 16 3.5Z" fill="url(#${g}c)"/>
  <path d="M15.1 9C14.2 12.5 13.6 16 13.5 20" stroke="#fff" stroke-width=".7" stroke-linecap="round" opacity=".55" fill="none"/>
  <path d="M11.6 21.5H20.4L22.8 35H9.2Z" fill="url(#${g}m)" ${STROKE}/>
  <rect x="9" y="35" width="14" height="100" rx="3" fill="url(#${g}b)" ${STROKE}/>
  <rect x="9" y="41" width="14" height="5" fill="url(#${g}c)"/>
  <rect x="11" y="37" width="1.5" height="88" rx=".75" fill="#fff" opacity=".9"/>
</svg>`;
}

/** The eraser: a pale block with a lilac sleeve. */
export function eraserSvg(): string {
  const g = 'ptpe';
  return `<svg viewBox="0 0 32 128" xmlns="${NS}" aria-hidden="true"><defs><linearGradient id="${g}e" x1="0" x2="1"><stop offset="0" stop-color="#e9ecf1"/><stop offset=".3" stop-color="#fbfcfd"/><stop offset="1" stop-color="#cdd3dc"/></linearGradient></defs>
  <path d="M8 12.5Q8 9.5 11 9L22 7.2Q24 7 24 9V32H8Z" fill="url(#${g}e)" stroke="rgba(20,22,28,.2)" stroke-width=".5"/>
  <rect x="7.2" y="27" width="17.6" height="100" rx="2" fill="#efe7ff" stroke="rgba(106,38,214,.25)" stroke-width=".5"/>
  <rect x="7.2" y="33" width="17.6" height="2" fill="#8a3ffc" opacity=".55"/><rect x="9.2" y="30" width="1.5" height="80" rx=".75" fill="#fff" opacity=".8"/>
</svg>`;
}

export const DOCK_ICONS = {
  undo: '<svg viewBox="0 0 24 24"><path d="M9 5L4.5 9.5 9 14"/><path d="M5 9.5h9a5 5 0 0 1 0 10h-2"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 5l4.5 4.5L15 14"/><path d="M19 9.5h-9a5 5 0 0 0 0 10h2"/></svg>',
  clear: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  shot: '<svg viewBox="0 0 24 24"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H8l1.2-2h5.6L16 7h2.5A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.2"/></svg>',
} as const;
