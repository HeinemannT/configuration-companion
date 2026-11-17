/**
 * @vitest-environment happy-dom
 *
 * Browsers queue `selectionchange` as a task; happy-dom fires it synchronously
 * unless src/test-setup.ts queues it. A focused CodeMirror view writes the DOM
 * selection during its update and flushes on `selectionchange`, so a
 * synchronous event re-enters EditorView.update.
 */
import { describe, it, expect, vi } from 'vitest'
import { EditorView } from '@codemirror/view'

describe('selectionchange timing in the test DOM', () => {
  it('reaches listeners once, after the current task', async () => {
    const text = document.createTextNode('abc')
    document.body.appendChild(text)
    const listener = vi.fn()
    document.addEventListener('selectionchange', listener)
    try {
      document.getSelection()!.collapse(text, 1)
      expect(listener).not.toHaveBeenCalled()
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('selectionchange', listener)
      text.remove()
    }
  })

  it('lets a focused editor move its selection without re-entering update', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ doc: 'hello world', parent })
    try {
      view.focus()
      expect(() => view.dispatch({ selection: { anchor: 3 } })).not.toThrow()
      expect(() => view.dispatch({ changes: { from: 0, insert: 'X' }, selection: { anchor: 1 } })).not.toThrow()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(view.state.doc.toString()).toBe('Xhello world')
      expect(view.state.selection.main.head).toBe(1)
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})
