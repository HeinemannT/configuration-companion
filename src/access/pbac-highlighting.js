import { analyzePBAC } from './pbac-document.js';

// Shared by CodeMirror and read-only policy excerpts. Classification follows JSON
// context, so a role mentioned in a comment is not presented as a role reference.
// VS Code Light+ syntax vocabulary, extended for PBAC. The lighter teal/green/
// magenta tones are darkened to remain readable on Companion's selection fill.
// https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults/themes
export const PBAC_STYLES = {
  structure: { color: '#0451a5', fontWeight: '400' },
  key: { color: '#0451a5', fontWeight: '400' },
  logic: { color: '#9b00c1', fontWeight: '700' },
  role: { color: '#126b80', fontWeight: '400' },
  subject: { color: '#126b80', fontWeight: '400' },
  action: { color: '#0062aa', fontWeight: '400' },
  reference: { color: '#001080', fontWeight: '400' },
  operator: { color: '#795e26', fontWeight: '400' },
  typed: { color: '#126b80', fontWeight: '400' },
  comment: { color: '#007000', fontWeight: '400' },
  string: { color: '#a31515', fontWeight: '400' },
  number: { color: '#087443', fontWeight: '400' },
  atom: { color: '#0000ff', fontWeight: '400' },
  punctuation: { color: '#3b3b3b', fontWeight: '400' },
  invalid: { color: '#b52020', fontWeight: '400', textDecoration: 'underline wavy' },
};
export function pbacPaletteCSS() {
  return '/* Generated from pbac-highlighting.js. */\n' + Object.entries(PBAC_STYLES).map(([name, style]) =>
    '.pbac-' + name + '{' + Object.entries(style).map(([key, value]) =>
      key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + ':' + value).join(';') + '}').join('\n') + '\n';
}
// Preserve line-relative, lossless tokens for read-only previews.
export function tokenizePBAC(text) {
  const { spans } = analyzePBAC(text);
  let offset = 0, index = 0;
  return text.split('\n').map(line => {
    const tokens = [];
    let position = offset;
    const end = offset + line.length;
    while (position < end) {
      while (index < spans.length && spans[index].to <= position) index++;
      const span = spans[index];
      const inside = span && span.from <= position;
      const to = Math.min(end, inside ? span.to : span?.from ?? end);
      tokens.push({ from: position - offset, to: to - offset, type: inside ? span.type : null, text: text.slice(position, to) });
      position = to;
    }
    offset = end + 1;
    return tokens;
  });
}
