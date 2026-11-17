/**
 * In-place expression editing for the object window: one CodeSurface slot on
 * the shared editor-core scaffold, with the Extended Code grammar and the
 * shared code theme (editor-core/theme.ts, the same colours as the Extended
 * Code editor). Loaded on first edit (dynamic import), so opening
 * the window does not pay for CodeMirror.
 *
 * Escape cancels the edit (the caller restores the text from before it
 * started); Mod-Enter finishes it. No chrome.*.
 */

import { cmBindings } from '../../lib/shortcuts';
import { EditorView, keymap } from '@codemirror/view';
import { baseEditingExtensions, baseKeymapBindings, codeTheme } from '../../editor-core/cm-scaffold';
import { CodeSurface, isProgrammaticSwap } from '../../editor-core/code-surface';
import { extendedLanguage } from '../../editor-core/ec/language';
import { ecBlockMatching } from '../../editor-core/ec/blockMatching';
import { codeRefLinks } from '../../editor-core/code-ref-links';
import type { CodeRefCache } from '../../lib/code-ref-client';
import type { RefTarget } from '../../lib/code-ref-resolve';

export interface CodeEditorOptions {
  code: string;
  plain?: boolean;
  label: string;
  onChange(text: string): void;
  onCancel(): void;
  onDone(): void;
  /** Code references (shared cache): Ctrl/Cmd+Click or Alt+F12 peeks, F12
   *  opens the target; a plain click keeps placing the caret. */
  refs?: { cache: CodeRefCache; open(target: RefTarget, line: number): void };
}

export interface CodeEditorHandle {
  /** Element that holds the editor; the view moves it between renders. */
  el: HTMLElement;
  getDoc(): string;
  focus(): void;
  destroy(): void;
}

export type CodeEditorFactory = (opts: CodeEditorOptions) => CodeEditorHandle;

/** Window-only sizing; colours come from the shared codeTheme. */
const windowTheme = EditorView.theme({
  '&': { fontSize: '12px' },
  '.cm-content': { fontFamily: 'var(--font-mono)', padding: '8px 0' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px' },
});

export const createCodeEditor: CodeEditorFactory = (opts) => {
  const el = document.createElement('div');
  el.className = 'ow-cm';
  el.setAttribute('aria-label', `${opts.label} editor`);
  const surface = new CodeSurface(() => el, {
    buildExtensions: () => [
      ...baseEditingExtensions(),
      codeTheme,
      windowTheme,
      ...(opts.plain ? [] : [extendedLanguage, ecBlockMatching]),
      ...(!opts.plain && opts.refs ? [codeRefLinks({ cache: opts.refs.cache, open: opts.refs.open }).extension] : []),
      EditorView.lineWrapping,
      // The edit's own keys first (lib/shortcuts.ts), so CodeMirror's
      // Mod-Enter (insert blank line) cannot shadow Finish.
      keymap.of([
        ...cmBindings([
          { id: 'objectCode.cancel', run: () => { opts.onCancel(); return true; } },
          { id: 'objectCode.done', run: () => { opts.onDone(); return true; } },
        ]),
        ...baseKeymapBindings,
      ]),
      EditorView.updateListener.of(u => {
        if (u.docChanged && !isProgrammaticSwap(u)) opts.onChange(u.state.doc.toString());
      }),
    ],
  });
  surface.setSlots([{ key: 'code', lang: opts.plain ? 'plain' : 'ec', code: opts.code }]);
  surface.activate('code');
  return {
    el,
    getDoc: () => surface.textFor('code'),
    focus: () => surface.focus(),
    destroy: () => surface.destroy(),
  };
};
