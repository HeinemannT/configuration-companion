/**
 * Code references in CodeMirror (the Extended Code window, and the object
 * window's in-place editor): the same finder (lib/code-refs), the same
 * batched resolve and the same peek card as the object window's read view.
 *
 * An editor places the caret on a plain click, so:
 *  - hover shows the card;
 *  - Ctrl/Cmd+Click (or Alt+F12 at the caret) peeks the target's code under
 *    the calling line; the same again closes it;
 *  - F12 at the caret, or the peek's open control, hands the target to
 *    `open` (the object window, at that object).
 * Links are underlined on hover only; an unresolved one gets a dashed
 * underline in the error colour.
 */

import { cmBindings, isMac } from '../lib/shortcuts'
import { Decoration, EditorView, ViewPlugin, WidgetType, closeHoverTooltips, hasHoverTooltips, hoverTooltip, keymap, type DecorationSet } from '@codemirror/view';
import { Prec, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { findCodeRefs, type CodeRef } from '../lib/code-refs';
import { CodeRefCache, type CodeRefIo } from '../lib/code-ref-client';
import type { RefTarget } from '../lib/code-ref-resolve';
import { CARD_DELAY_MS, countLines, fillRefCard, linesText, notFoundText, targetName, typeTile } from './code-links';
import { typeLabel } from '../lib/object-window-table';
import { formatCount, renderCode } from './code-view';

export interface CodeRefLinksOptions {
  /** Transport for a cache of its own, or a cache to share. */
  io?: CodeRefIo;
  cache?: CodeRefCache;
  /** Go to the target (the object window). `line`: the calling line. */
  open(target: RefTarget, line: number): void;
}

const PEEK_LINES = 12;

/** A cache answer arrived: redraw decorations and peeks. */
const refsChanged = StateEffect.define<null>();
/** Toggle the peek of the reference that starts at `pos`. */
const togglePeek = StateEffect.define<number>();

const peeks = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map(p => tr.changes.mapPos(p)) : value;
    for (const e of tr.effects) {
      if (e.is(togglePeek)) next = next.includes(e.value) ? next.filter(p => p !== e.value) : [...next, e.value];
    }
    return next;
  },
});

function refAt(refs: readonly CodeRef[], pos: number): CodeRef | undefined {
  return refs.find(r => pos >= r.start && pos <= r.end);
}

class PeekWidget extends WidgetType {
  constructor(private readonly ref: CodeRef, private readonly cache: CodeRefCache, private readonly version: number,
    private readonly open: (t: RefTarget, line: number) => void) { super(); }

  eq(other: PeekWidget): boolean {
    return other.ref.key === this.ref.key && other.ref.start === this.ref.start && other.version === this.version;
  }

  toDOM(view: EditorView): HTMLElement {
    const r = this.cache.ref(this.ref.key);
    const box = document.createElement('div');
    box.className = 'ow-peek cm-ref-peek';
    box.setAttribute('role', 'group');
    if (!r || r === 'pending' || !r.found) {
      box.textContent = r && r !== 'pending' ? notFoundText(this.ref) : 'Looking up…';
      return box;
    }
    const t = r.target;
    const code = this.cache.code(t.rid);
    if (!code) void this.cache.requestCode(t.rid, t.codeProp);
    box.setAttribute('aria-label', `Code of ${targetName(t)}, ${typeLabel(t.type)}, called on line ${this.ref.line}`);
    const head = document.createElement('div');
    head.className = 'ow-peek-h';
    const span = (cls: string, text: string) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    const total = code?.text != null ? countLines(code.text) : 0;
    const nm = span('nm', targetName(t));
    nm.title = `${targetName(t)} · ${typeLabel(t.type)}`;
    head.append(typeTile(t.type), nm, span('ui-id', t.businessId),
      span('cnt', code?.text != null ? linesText(Math.min(total, PEEK_LINES), total) : ''));
    const acts = span('acts', '');
    const mk = (label: string, text: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cm-ref-btn';
      b.textContent = text;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', e => { e.preventDefault(); fn(); });
      return b;
    };
    acts.append(
      mk(`Open ${targetName(t)} in the object window (F12)`, 'Open', () => this.open(t, this.ref.line)),
      mk(`Close the peek of ${targetName(t)}`, '×', () => view.dispatch({ effects: togglePeek.of(this.ref.start) })),
    );
    head.append(acts);
    box.append(head);
    if (!code || code.loading) box.append(span('ow-peek-note', 'Loading code…'));
    else if (code.error || code.text == null) box.append(span('ow-peek-note', code.error ? 'The code could not be read.' : 'No code.'));
    else {
      const v = renderCode(code.text.replace(/\r?\n$/, ''), {
        label: targetName(t), maxLines: PEEK_LINES,
        more: hidden => span('ow-more', `${formatCount(hidden)} more lines · Open shows all`),
      });
      v.el.removeAttribute('tabindex');
      box.append(v.el);
    }
    return box;
  }

  ignoreEvent(): boolean { return true; }
}

/** The extension plus its cache (the caller may share the cache). */
export function codeRefLinks(opts: CodeRefLinksOptions): { extension: Extension; cache: CodeRefCache } {
  const views = new Set<EditorView>();
  const notify = () => { for (const v of views) v.dispatch({ effects: refsChanged.of(null) }); };
  const cache = opts.cache ?? new CodeRefCache(opts.io ?? { resolve: () => Promise.resolve({}), read: () => Promise.resolve({ objects: {}, errors: {} }) });
  let unsubscribe: (() => void) | null = null;

  const build = (state: EditorState): { deco: DecorationSet; refs: CodeRef[] } => {
    const refs = findCodeRefs(state.doc.toString());
    void cache.request(refs.map(r => r.key));
    const open = state.field(peeks);
    const items: Array<{ from: number; to: number; deco: Decoration }> = [];
    for (const r of refs) {
      const st = cache.ref(r.key);
      const cls = st && st !== 'pending' && !st.found ? 'cm-xref cm-xref-nf' : 'cm-xref';
      items.push({ from: r.start, to: r.end, deco: Decoration.mark({ class: cls }) });
      if (open.includes(r.start)) {
        const line = state.doc.lineAt(r.start);
        items.push({ from: line.to, to: line.to, deco: Decoration.widget({ widget: new PeekWidget(r, cache, cache.version, opts.open), block: true, side: 1 }) });
      }
    }
    items.sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from));
    const b = new RangeSetBuilder<Decoration>();
    for (const it of items) b.add(it.from, it.to, it.deco);
    return { deco: b.finish(), refs };
  };

  // Block widgets (the peeks) must come from state, not from a plugin.
  const field = StateField.define<{ deco: DecorationSet; refs: CodeRef[] }>({
    create: state => build(state),
    update(value, tr) {
      if (tr.docChanged || tr.effects.some(e => e.is(refsChanged) || e.is(togglePeek))) return build(tr.state);
      return value;
    },
    provide: f => EditorView.decorations.from(f, v => v.deco),
  });

  const plugin = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {
      views.add(view);
      unsubscribe ??= cache.subscribe(notify);
    }
    destroy() {
      views.delete(this.view);
      if (!views.size) { unsubscribe?.(); unsubscribe = null; }
    }
  });

  const refsOf = (view: EditorView) => view.state.field(field, false)?.refs ?? findCodeRefs(view.state.doc.toString());
  const peekAt = (view: EditorView, pos: number): boolean => {
    const ref = refAt(refsOf(view), pos);
    if (!ref) return false;
    const r = cache.ref(ref.key);
    if (!r || r === 'pending' || !r.found) return false;
    // No code to show: open the object instead of doing nothing.
    if (!r.target.codeProp) { opts.open(r.target, ref.line); return true; }
    const opening = !view.state.field(peeks).includes(ref.start);
    const line = view.state.doc.lineAt(ref.start);
    view.dispatch({
      effects: [togglePeek.of(ref.start), closeHoverTooltips,
        ...(opening ? [EditorView.scrollIntoView(Math.min(line.to + 1, view.state.doc.length), { y: 'nearest', yMargin: 240 })] : [])],
    });
    return true;
  };
  const openAt = (view: EditorView, pos: number): boolean => {
    const ref = refAt(refsOf(view), pos);
    const r = ref ? cache.ref(ref.key) : undefined;
    if (!ref || !r || r === 'pending' || !r.found) return false;
    opts.open(r.target, ref.line);
    return true;
  };

  const hover = hoverTooltip((view, pos) => {
    const ref = refAt(refsOf(view), pos);
    if (!ref) return null;
    return {
      pos: ref.start, end: ref.end, above: false,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-ref-card-host';
        const card = document.createElement('div');
        dom.append(card);
        // The card's open button: the object window, like F12 at the caret.
        const fill = () => fillRefCard(card, ref, cache, 'editor', t => {
          view.dispatch({ effects: closeHoverTooltips });
          opts.open(t, ref.line);
        });
        fill();
        // The card fills in as the identity and the code arrive.
        const timer = window.setInterval(fill, 250);
        return { dom, destroy: () => window.clearInterval(timer) };
      },
    };
  }, { hoverTime: CARD_DELAY_MS });

  const extension: Extension = [
    peeks,
    field,
    plugin,
    hover,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(isMac() ? e.metaKey : e.ctrlKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null || !peekAt(view, pos)) return false;
        e.preventDefault();
        return true;
      },
    }),
    keymap.of(cmBindings([
      { id: 'codeRef.peek', run: view => peekAt(view, view.state.selection.main.head) },
      { id: 'codeRef.open', run: view => openAt(view, view.state.selection.main.head) },
    ]).map(b => ({ ...b, preventDefault: false }))),
    // Escape closes the innermost thing first: the card, then the last peek;
    // only then may it reach the editor's own Escape (closing the window).
    Prec.highest(keymap.of([{
      key: 'Escape',
      run: view => {
        if (hasHoverTooltips(view.state)) { view.dispatch({ effects: closeHoverTooltips }); return true; }
        const open = view.state.field(peeks);
        if (!open.length) return false;
        view.dispatch({ effects: togglePeek.of(open[open.length - 1]) });
        return true;
      },
    }])),
  ];
  return { extension, cache };
}
