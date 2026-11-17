/**
 * @vitest-environment happy-dom
 *
 * The CVO javascript runs as the text of a script element (no eval). These
 * tests run that script text with V8 through nodeScriptRunner, because the
 * unit-test DOM does not execute scripts. The sandbox CSP itself (eval refusal,
 * inline script allowed) is not present here; see the live-check list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendScript,
  bootSandbox,
  buildCvoScript,
  CVO_LINE_OFFSET,
  defineCvoFunction,
  EVAL_BLOCKED_MESSAGE,
  isEvalBlocked,
  mapCvoLine,
  onceForEval,
  plainScriptError,
  runCvo,
  violationReporter,
  type RenderRequest,
} from '../sandbox'
import type { CvoErrorMessage, CvoSandboxOutbound } from '../cvo-protocol'
import { nodeScriptRunner } from './node-script-runner'

function req(over: Partial<RenderRequest>): RenderRequest {
  return { type: 'CVO_RENDER', runId: 1, html: '', javascript: '', data: {}, ...over }
}

function run(javascript: string, data: Record<string, unknown> = {}): { msgs: CvoSandboxOutbound[]; root: HTMLElement } {
  const msgs: CvoSandboxOutbound[] = []
  const root = document.createElement('div')
  runCvo(root, req({ javascript, data }), m => msgs.push(m), nodeScriptRunner)
  return { msgs, root }
}

const errorOf = (msgs: CvoSandboxOutbound[]) => msgs.find((m): m is CvoErrorMessage => m.type === 'CVO_ERROR')
const BARRIER = 'TEST_BARRIER'

/** Wraps the sandbox's handler on its end of the port. Each call returns a
 *  promise for the next message that handler has finished processing. */
function awaitHandled(port: MessagePort): () => Promise<void> {
  const handler = port.onmessage
  if (!handler) throw new Error('the sandbox did not take the port')
  const waiting: Array<() => void> = []
  port.onmessage = function (this: MessagePort, e: MessageEvent) {
    handler.call(this, e)
    waiting.shift()?.()
  }
  return () => new Promise<void>(resolve => { waiting.push(resolve) })
}

describe('wrapped CVO script', () => {
  it('keeps function-body semantics: top-level return, local var, plain this', () => {
    const g = globalThis as Record<string, unknown>
    const { msgs, root } = run([
      `var leaked = 1`,
      `_data.element.textContent = String(this === window)`,
      `return`,
      `_data.element.textContent = 'after return'`,
    ].join('\n'))
    expect(msgs).toContainEqual({ type: 'CVO_RENDERED', runId: 1, ok: true })
    expect(root.textContent).toBe('true')
    expect(g.leaked).toBeUndefined()

    const strict = run(`'use strict'\n_data.element.textContent = String(this)`)
    expect(strict.root.textContent).toBe('undefined')
  })

  it('reports a runtime error at the line of the user code, not the wrapper', () => {
    const { msgs } = run(`var a = 1\nvar b = 2\nnull.x\n`)
    const err = errorOf(msgs)
    expect(err?.line).toBe(3)
    expect(err?.column).toBeGreaterThan(0)
    expect(err?.stack).toContain('cvo-preview.js:3:')
    expect(msgs).toContainEqual({ type: 'CVO_RENDERED', runId: 1, ok: false })
  })

  it('reports a syntax error as CVO_ERROR with the user line, and does not run the code', () => {
    const { msgs, root } = run(`_data.element.textContent = 'ran'\nvar ok = 1\nvar = ;`)
    const err = errorOf(msgs)
    expect(err?.message).toMatch(/^SyntaxError/)
    expect(err?.line).toBe(3)
    expect(root.textContent).toBe('')
    expect(msgs).toContainEqual({ type: 'CVO_RENDERED', runId: 1, ok: false })
    expect(msgs.filter(m => m.type === 'CVO_ERROR')).toHaveLength(1)
  })

  it('shows only the JavaScript message and line of a syntax error, not the DOM call that ran it', () => {
    // Chrome names the appendChild that inserted the script in the message.
    // A stand-in window: the error event stays out of the test page's window.
    const win = new EventTarget()
    const doc = { defaultView: win } as unknown as Document
    const chromeLike = () => {
      win.dispatchEvent(new ErrorEvent('error', {
        message: "Uncaught SyntaxError: Failed to execute 'appendChild' on 'Node': Unexpected token ';'",
        lineno: 4, colno: 5, cancelable: true,
      }))
    }
    const defined = defineCvoFunction(doc, ['var a = 1', 'var b = 2', 'var = ;'].join('\n'), chromeLike)
    expect(defined).toEqual({ error: { message: "SyntaxError: Unexpected token ';'", line: 3, column: 5 } })
    expect(plainScriptError("Uncaught SyntaxError: Failed to execute 'appendChild' on 'Node': Invalid or unexpected token")).toBe('SyntaxError: Invalid or unexpected token')
    expect(plainScriptError('Uncaught TypeError: x is not a function')).toBe('TypeError: x is not a function')
  })

  it('reports a script the policy blocked (no function, no error event)', () => {
    const msgs: CvoSandboxOutbound[] = []
    runCvo(document.createElement('div'), req({ javascript: 'var x = 1' }), m => msgs.push(m), () => { /* blocked */ })
    expect(errorOf(msgs)?.message).toMatch(/security policy blocked the script/)
    expect(msgs).toContainEqual({ type: 'CVO_RENDERED', runId: 1, ok: false })
  })

  it('treats </script> inside the code as plain JavaScript text', () => {
    const js = `var s = '</script><b>x</b>'\n_data.element.textContent = s`
    expect(buildCvoScript(js)).toContain(`'</script><b>x</b>'`)
    const { msgs, root } = run(js)
    expect(root.textContent).toBe('</script><b>x</b>')
    expect(root.querySelector('b')).toBeNull()
    expect(msgs).toContainEqual({ type: 'CVO_RENDERED', runId: 1, ok: true })
  })

  it('hands the script text to the DOM unparsed, so </script> cannot end it early', () => {
    const js = `var s = '</script><img src=x>'`
    const added: HTMLScriptElement[] = []
    const spy = vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(n: T): T => { added.push(n as unknown as HTMLScriptElement); return n })
    try { appendScript(document, buildCvoScript(js)) } finally { spy.mockRestore() }
    expect(added).toHaveLength(1)
    expect(added[0].tagName).toBe('SCRIPT')
    expect(added[0].textContent).toBe(buildCvoScript(js))
    expect(added[0].children).toHaveLength(0)
  })

  it('maps script lines to user lines, clamped to the code', () => {
    expect(CVO_LINE_OFFSET).toBe(1)
    expect(mapCvoLine(2, 'a\nb')).toBe(1)
    expect(mapCvoLine(4, 'a\nb')).toBe(2) // the wrapper's closing line → last user line
    expect(mapCvoLine(1, 'a\nb')).toBe(1)
    expect(mapCvoLine(0, 'a')).toBeUndefined()
  })

  it('removes the define hook after the run', () => {
    defineCvoFunction(document, 'var x = 1', nodeScriptRunner)
    expect((window as unknown as Record<string, unknown>).__cvoPreviewDefine).toBeUndefined()
  })
})

describe('eval refused by the preview policy', () => {
  const chromeRefusal = `Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: "script-src 'self' 'unsafe-inline' blob:".`

  it('recognises the refusal', () => {
    expect(isEvalBlocked(new EvalError(chromeRefusal))).toBe(true)
    expect(isEvalBlocked(undefined, `Uncaught EvalError: ${chromeRefusal}`)).toBe(true)
    expect(isEvalBlocked(new TypeError('x is not a function'))).toBe(false)
  })

  it('shows the plain message when CVO code calls eval', () => {
    const { msgs } = run(`throw new EvalError(${JSON.stringify(chromeRefusal)})`)
    expect(errorOf(msgs)?.message).toBe(EVAL_BLOCKED_MESSAGE)
  })

  it('reports a violation event for eval once, also when the code caught the error itself', () => {
    const msgs: CvoSandboxOutbound[] = []
    const emit = onceForEval(m => msgs.push(m))
    const report = violationReporter(emit, () => 4)
    report({ blockedURI: 'eval', effectiveDirective: 'script-src' })
    emit({ type: 'CVO_ERROR', runId: 4, message: EVAL_BLOCKED_MESSAGE })
    expect(msgs).toEqual([{ type: 'CVO_ERROR', runId: 4, message: EVAL_BLOCKED_MESSAGE }])
  })

  it('warns once per directive and origin for other blocked requests', () => {
    const msgs: CvoSandboxOutbound[] = []
    const report = violationReporter(m => msgs.push(m), () => 1)
    report({ blockedURI: 'https://example.test/a?x=1', effectiveDirective: 'connect-src' })
    report({ blockedURI: 'https://example.test/b', effectiveDirective: 'connect-src' })
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ type: 'CVO_CONSOLE', level: 'warn' })
    expect((msgs[0] as { text: string }).text).toContain('https://example.test')
    expect((msgs[0] as { text: string }).text).not.toContain('x=1')
  })
})

describe('sandbox shell: port-only messaging', () => {
  let teardown: (() => void) | null = null
  afterEach(() => { teardown?.(); teardown = null; document.body.replaceChildren() })

  it('announces readiness without data, ignores renders on the window, and answers only on the port', async () => {
    const parent = { postMessage: vi.fn() }
    teardown = bootSandbox(window, { parent, run: nodeScriptRunner })
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    expect(parent.postMessage.mock.calls[0]).toEqual([{ type: 'CVO_SANDBOX_READY' }, '*'])

    const render = req({ runId: 9, html: '<p id="p"></p>', javascript: `_data.element.querySelector('#p').textContent = _data.secret`, data: { secret: 's1' } })
    // A render posted on the window (the old transport) is ignored.
    window.dispatchEvent(new MessageEvent('message', { data: render, source: parent as unknown as Window }))
    expect(document.getElementById('cvo-root')).toBeNull()

    const channel = new MessageChannel()
    const got: unknown[] = []
    channel.port1.onmessage = e => got.push(e.data)
    // A port from anything but the parent is ignored: the sandbox never
    // listens on it, so a request sent there cannot reach the sandbox.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'CVO_PORT' }, source: { postMessage() {} } as unknown as Window, ports: [channel.port2] }))
    expect(channel.port2.onmessage).toBeNull()
    channel.port1.postMessage(render)
    expect(document.getElementById('cvo-root')).toBeNull()

    const real = new MessageChannel()
    const answers: CvoSandboxOutbound[] = []
    const barriers: Array<() => void> = []
    real.port1.onmessage = e => {
      if ((e.data as { type?: unknown }).type === BARRIER) barriers.shift()?.()
      else answers.push(e.data as CvoSandboxOutbound)
    }
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'CVO_PORT' }, source: parent as unknown as Window, ports: [real.port2] }))
    const handled = awaitHandled(real.port2)
    // Messages on one port arrive in order, so once a barrier posted from the
    // sandbox's end comes back, every answer the sandbox posted before it is in.
    const answersIn = () => new Promise<void>(resolve => { barriers.push(resolve); real.port2.postMessage({ type: BARRIER }) })

    real.port1.postMessage(render)
    await handled()
    expect(document.getElementById('p')?.textContent).toBe('s1')
    await answersIn()
    expect(answers).toContainEqual({ type: 'CVO_RENDERED', runId: 9, ok: true })

    // One render per frame: a second request on the same port is ignored.
    real.port1.postMessage({ ...render, runId: 10, data: { secret: 's2' } })
    await handled()
    expect(document.getElementById('p')?.textContent).toBe('s1')
    await answersIn()
    expect(answers.some(m => 'runId' in m && m.runId === 10)).toBe(false)
    // Nothing but readiness ever went to the window.
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    expect(got).toEqual([])
    channel.port1.close(); real.port1.close()
  })
})
