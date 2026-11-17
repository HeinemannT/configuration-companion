/**
 * Test stand-in for the browser's inline-script execution. happy-dom does not
 * run <script> elements, so this compiles the text with V8 (node:vm) the way
 * Chrome would run a classic inline script: a syntax error does not throw to
 * the caller but fires the window `error` event with the script line; an
 * uncaught exception does the same. Stack frames name the script by its
 * `//# sourceURL`, as they do in Chrome.
 *
 * What this does NOT reproduce: the sandbox CSP (eval refusal, blocked inline
 * script) and the exact `lineno` Chrome puts on the error event. Those are
 * live-browser checks.
 */
import vm from 'node:vm'
import type { ScriptRunner } from '../sandbox'

function dispatch(win: Window, err: unknown, fallbackLine?: number): void {
  const e = err as Error
  const line = Number(/cvo-preview\.js:(\d+)/.exec(e?.stack ?? '')?.[1]) || fallbackLine || 0
  win.dispatchEvent(new ErrorEvent('error', {
    message: `Uncaught ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}`,
    lineno: line,
    colno: 1,
    error: err,
    cancelable: true,
  }))
}

export const nodeScriptRunner: ScriptRunner = (doc, text) => {
  const win = doc.defaultView as Window
  let script: vm.Script
  try {
    script = new vm.Script(text, { filename: 'cvo-preview.js' })
  } catch (e) {
    dispatch(win, e)
    return
  }
  try {
    // The script reads `window`; give it the document's window.
    const g = globalThis as { window?: unknown }
    const prev = g.window
    g.window = win
    try { script.runInThisContext() } finally { g.window = prev }
  } catch (e) {
    dispatch(win, e)
  }
}
