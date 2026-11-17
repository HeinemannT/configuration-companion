import { EditorView } from '@codemirror/view';
import { foldable, foldedRanges, foldEffect, unfoldEffect, foldGutter } from '@codemirror/language';
import { icon } from './icons';

function foldedAt(view, line) {
  let range;
  foldedRanges(view.state).between(line.from, line.to, (from, to) => { range ??= { from, to }; });
  return range;
}
function changeFold(view, range, opening) {
  const start = view.state.doc.lineAt(range.from).from, rect = view.scrollDOM.getBoundingClientRect();
  const coords = view.coordsAtPos(start);
  const margin = coords ? Math.max(8, Math.min(opening ? Math.min(100, rect.height / 3) : rect.height - 45, coords.top - rect.top)) : 12;
  const head = view.state.selection.main.head;
  view.dispatch({ effects: [(opening ? unfoldEffect : foldEffect).of(range), EditorView.scrollIntoView(start, { y: 'start', yMargin: margin })],
    ...(!opening && head > range.from && head < range.to ? { selection: { anchor: range.from } } : {}) });
}
export function pbacFoldGutter() {
  return foldGutter({
    markerDOM(open) {
      const marker = document.createElement('span'); marker.className = 'pbac-fold-chevron';
      marker.innerHTML = icon('down'); marker.dataset.expanded = String(open);
      marker.title = open ? 'Collapse block' : 'Expand block'; return marker;
    },
    domEventHandlers: {
      mousedown: (_view, _line, event) => { event.preventDefault(); return true; },
      click(view, line, event) {
        event.preventDefault();
        const folded = foldedAt(view, line), range = folded ?? foldable(view.state, line.from, line.to);
        if (range) changeFold(view, range, !!folded);
        return true;
      }
    }
  });
}
export function expandFoldWidget(view, element) {
  // Resolve the live position: edits before this widget may have moved its range.
  const range = foldedAt(view, view.lineBlockAt(view.posAtDOM(element)));
  if (range) changeFold(view, range, true);
}
