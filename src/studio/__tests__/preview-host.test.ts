/**
 * @vitest-environment happy-dom
 *
 * Studio side of the preview transport: a new frame per render, one port per
 * frame, render data only on that port, nothing for a replaced frame. Frames
 * here are iframe elements whose window is a stand-in (happy-dom does not load
 * frames); the stand-in records what the studio posts to the window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEFT_PREVIEW_MESSAGE, PreviewHost, PENDING_FRAME_CLASS, formatCvoError } from '../preview-host'
import { CVO_HEIGHT_MAX, type CvoRenderRequest } from '../cvo-protocol'

interface FakeFrame {
  el: HTMLIFrameElement
  win: { postMessage: ReturnType<typeof vi.fn> }
  /** Port the studio handed to this frame, once it did. */
  port: () => MessagePort | undefined
  /** Messages this frame's port received. */
  received: unknown[]
}

const tick = () => new Promise(r => setTimeout(r, 10))
const openPorts: MessagePort[] = []

function setup() {
  const mount = document.createElement('div') // detached: happy-dom does not try to load frames
  const frames: FakeFrame[] = []
  const output = vi.fn()
  const host = new PreviewHost({
    mountPoint: () => mount,
    createFrame: () => {
      const el = document.createElement('iframe')
      const win = { postMessage: vi.fn() }
      Object.defineProperty(el, 'contentWindow', { value: win, configurable: true })
      const f: FakeFrame = {
        el, win, received: [],
        port: () => {
          const call = win.postMessage.mock.calls.find(c => (c[0] as { type?: string })?.type === 'CVO_PORT')
          const p = (call?.[2] as MessagePort[] | undefined)?.[0]
          if (p && !p.onmessage) { p.onmessage = e => f.received.push(e.data); openPorts.push(p) }
          return p
        },
      }
      frames.push(f)
      return el
    },
    onOutput: output,
  })
  const ready = (f: FakeFrame, origin = 'null') =>
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'CVO_SANDBOX_READY' }, source: f.win as unknown as Window, origin }))
  return { host, mount, frames, output, ready }
}

const req = (runId: number, secret = `s${runId}`): CvoRenderRequest =>
  ({ type: 'CVO_RENDER', runId, html: '', javascript: '', data: { secret } })

let hosts: PreviewHost[] = []
afterEach(() => {
  hosts.forEach(h => h.dispose()); hosts = []
  openPorts.splice(0).forEach(p => p.close())
})

describe('PreviewHost', () => {
  it('sends the render only on the transferred port, never on the window', async () => {
    const { host, frames, ready } = setup(); hosts.push(host)
    host.render(req(1))
    expect(frames).toHaveLength(1)
    expect(frames[0].win.postMessage).not.toHaveBeenCalled() // nothing before readiness
    ready(frames[0])
    const calls = frames[0].win.postMessage.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toEqual({ type: 'CVO_PORT' }) // the window message carries no data
    expect(calls[0][2]).toHaveLength(1)
    frames[0].port()
    await tick()
    expect(frames[0].received).toEqual([req(1)])
  })

  it('ignores readiness from the wrong origin or from a window that is not the waiting frame', () => {
    const { host, frames, ready } = setup(); hosts.push(host)
    host.render(req(1))
    ready(frames[0], 'https://example.test')
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'CVO_SANDBOX_READY' }, source: { postMessage() {} } as unknown as Window, origin: 'null' }))
    expect(frames[0].win.postMessage).not.toHaveBeenCalled()
  })

  it('gives a replaced frame nothing: no new port, no later render data', async () => {
    const { host, mount, frames, ready } = setup(); hosts.push(host)
    host.render(req(1))
    ready(frames[0])
    const port1 = frames[0].port()!
    port1.postMessage({ type: 'CVO_RENDERED', runId: 1, ok: true })
    await tick()
    // The shown frame navigates (its document is replaced) and the new
    // document announces itself: it gets no port and no data.
    ready(frames[0])
    expect(frames[0].win.postMessage).toHaveBeenCalledTimes(1)

    host.render(req(2, 'second secret'))
    expect(frames).toHaveLength(2)
    expect(frames[1].el.classList.contains(PENDING_FRAME_CLASS)).toBe(true)
    // The first frame's document is replaced (navigated) and announces itself again.
    ready(frames[0])
    expect(frames[0].win.postMessage).toHaveBeenCalledTimes(1) // only the original hand-off
    ready(frames[1])
    frames[1].port()!.postMessage({ type: 'CVO_RENDERED', runId: 2, ok: true })
    await tick()

    expect(frames[0].received).toEqual([req(1)])
    expect(frames[1].received).toEqual([req(2, 'second secret')])
    expect(mount.contains(frames[0].el)).toBe(false)
    expect(frames[1].el.classList.contains(PENDING_FRAME_CLASS)).toBe(false)
    expect(host.frames()).toEqual([frames[1].el])

    // Later readiness from the removed frame still gets nothing.
    ready(frames[0])
    host.render(req(3))
    ready(frames[0])
    expect(frames[0].win.postMessage).toHaveBeenCalledTimes(1)
  })

  it('hands a frame one port only, even if it announces readiness again', () => {
    const { host, frames, ready } = setup(); hosts.push(host)
    host.render(req(1))
    ready(frames[0])
    ready(frames[0])
    expect(frames[0].win.postMessage).toHaveBeenCalledTimes(1)
  })

  it('drops a frame still loading when a newer render starts', () => {
    const { host, mount, frames, ready } = setup(); hosts.push(host)
    host.render(req(1))
    host.render(req(2))
    expect(mount.contains(frames[0].el)).toBe(false)
    ready(frames[0])
    expect(frames[0].win.postMessage).not.toHaveBeenCalled()
  })

  it('validates inbound messages, clamps the height, and drops stale output', async () => {
    const { host, frames, ready, output } = setup(); hosts.push(host)
    host.render(req(1))
    ready(frames[0])
    const p = frames[0].port()!
    p.postMessage({ type: 'CVO_HEIGHT', runId: 1, height: 1e9 })
    p.postMessage({ type: 'CVO_CONSOLE', runId: 1, level: 'evil', text: 'x' })
    p.postMessage({ type: 'CVO_CONSOLE', runId: 1, level: 'log', text: 42 })
    p.postMessage({ type: 'CVO_CONSOLE', runId: 99, level: 'log', text: 'other run' })
    p.postMessage({ type: 'CVO_CONSOLE', runId: 1, level: 'log', text: 'hello', extra: 'dropped' })
    p.postMessage({ type: 'CVO_RENDERED', runId: 1, ok: true })
    await tick()
    expect(frames[0].el.style.height).toBe(`${CVO_HEIGHT_MAX}px`)
    expect(output).toHaveBeenCalledTimes(1)
    expect(output).toHaveBeenCalledWith({ type: 'CVO_CONSOLE', runId: 1, level: 'log', text: 'hello' })

    // While a newer frame loads, the shown frame's late output is stale.
    host.render(req(2))
    p.postMessage({ type: 'CVO_CONSOLE', runId: 1, level: 'log', text: 'late' })
    await tick()
    expect(output).toHaveBeenCalledTimes(1)
  })

  it('replaces a frame that preview code navigated with a fresh render, and says so once', async () => {
    const { host, mount, frames, ready, output } = setup(); hosts.push(host)
    const load = (f: FakeFrame) => f.el.dispatchEvent(new Event('load'))
    host.render(req(1))
    load(frames[0]) // the sandbox page itself
    ready(frames[0])
    frames[0].port()!.postMessage({ type: 'CVO_RENDERED', runId: 1, ok: true })
    await tick()
    expect(output).not.toHaveBeenCalled()

    // The code navigates its frame: the browser's error page loads in it.
    load(frames[0])
    expect(mount.contains(frames[0].el)).toBe(false)
    expect(frames).toHaveLength(2)
    expect(mount.contains(frames[1].el)).toBe(true)
    expect(frames[1].el.classList.contains(PENDING_FRAME_CLASS)).toBe(false)
    expect(output).toHaveBeenCalledWith({ type: 'CVO_ERROR', runId: 1, message: LEFT_PREVIEW_MESSAGE })
    load(frames[1])
    ready(frames[1])
    frames[1].port()
    await tick()
    expect(frames[1].received).toEqual([req(1)])

    // The same code navigates the replacement too: the preview stays empty, no loop.
    load(frames[1])
    expect(frames).toHaveLength(2)
    expect(host.frames()).toEqual([])
    expect(output).toHaveBeenCalledTimes(1)
  })

  it('the sandbox page loading after the hand-off is not taken for a navigation', async () => {
    const { host, frames, ready, output } = setup(); hosts.push(host)
    host.render(req(1))
    ready(frames[0])
    frames[0].el.dispatchEvent(new Event('load'))
    expect(host.frames()).toEqual([frames[0].el])
    expect(output).not.toHaveBeenCalled()
  })

  it('reset removes every frame and closes the ports', async () => {
    const { host, mount, frames, ready, output } = setup(); hosts.push(host)
    host.render(req(1))
    ready(frames[0])
    const p = frames[0].port()!
    host.reset()
    expect(mount.children).toHaveLength(0)
    p.postMessage({ type: 'CVO_CONSOLE', runId: 1, level: 'log', text: 'after reset' })
    await tick()
    expect(output).not.toHaveBeenCalled()
  })
})

describe('formatCvoError', () => {
  it('adds the user line and column when known', () => {
    expect(formatCvoError({ type: 'CVO_ERROR', runId: 1, message: 'boom', line: 3, column: 7 })).toBe('boom (line 3, column 7)')
    expect(formatCvoError({ type: 'CVO_ERROR', runId: 1, message: 'boom' })).toBe('boom')
  })
})
