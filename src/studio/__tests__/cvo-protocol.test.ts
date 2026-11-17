import { describe, expect, it } from 'vitest'
import {
  clampPreviewHeight,
  CVO_HEIGHT_MAX,
  CVO_TEXT_LIMIT,
  isCvoPortHandoff,
  parseCvoRenderRequest,
  parseCvoSandboxOutbound,
} from '../cvo-protocol'

describe('parseCvoSandboxOutbound', () => {
  it('rejects wrong shapes', () => {
    for (const v of [
      null, 'CVO_CONSOLE', [], { type: 'CVO_UNKNOWN' },
      { type: 'CVO_CONSOLE', runId: 1, level: 'debug', text: 'x' },
      { type: 'CVO_CONSOLE', runId: -1, level: 'log', text: 'x' },
      { type: 'CVO_CONSOLE', runId: 1.5, level: 'log', text: 'x' },
      { type: 'CVO_CONSOLE', runId: '1', level: 'log', text: 'x' },
      { type: 'CVO_CONSOLE', runId: 1, level: 'log', text: { toString: () => 'x' } },
      { type: 'CVO_ERROR', runId: 1 },
      { type: 'CVO_ERROR', runId: 1, message: 'x', stack: 5 },
      { type: 'CVO_RENDERED', runId: 1, ok: 'yes' },
      { type: 'CVO_HEIGHT', runId: 1, height: NaN },
      { type: 'CVO_HEIGHT', runId: 1, height: '100' },
    ]) expect(parseCvoSandboxOutbound(v)).toBeNull()
  })

  it('returns a new object with only the known fields', () => {
    const input = { type: 'CVO_ERROR', runId: 2, message: 'boom', line: 3, column: 0, extra: { a: 1 } }
    const out = parseCvoSandboxOutbound(input)
    expect(out).toEqual({ type: 'CVO_ERROR', runId: 2, message: 'boom', line: 3 })
    expect(out).not.toBe(input)
    expect(parseCvoSandboxOutbound({ type: 'CVO_SANDBOX_READY', payload: 'x' })).toEqual({ type: 'CVO_SANDBOX_READY' })
  })

  it('cuts long text to the limit', () => {
    const out = parseCvoSandboxOutbound({ type: 'CVO_CONSOLE', runId: 1, level: 'log', text: 'x'.repeat(CVO_TEXT_LIMIT * 3) })
    expect(out && 'text' in out && out.text.length).toBe(CVO_TEXT_LIMIT + 1)
  })

  it('clamps the height', () => {
    expect(parseCvoSandboxOutbound({ type: 'CVO_HEIGHT', runId: 1, height: 1e12 })).toEqual({ type: 'CVO_HEIGHT', runId: 1, height: CVO_HEIGHT_MAX })
    expect(clampPreviewHeight(-50)).toBe(0)
    expect(clampPreviewHeight(120.2)).toBe(121)
    expect(clampPreviewHeight(Infinity)).toBeNull()
  })
})

describe('sandbox-side validation', () => {
  it('accepts a well-formed render request and copies only its fields', () => {
    const r = parseCvoRenderRequest({ type: 'CVO_RENDER', runId: 1, html: '', javascript: '', data: {}, libs: [{ rid: '123456', content: 'x', more: 1 }], extra: 1 })
    expect(r).toEqual({ type: 'CVO_RENDER', runId: 1, html: '', javascript: '', data: {}, libs: [{ rid: '123456', content: 'x' }] })
  })

  it('rejects malformed render requests', () => {
    expect(parseCvoRenderRequest({ type: 'CVO_RENDER', runId: 1, html: '', javascript: 1, data: {} })).toBeNull()
    expect(parseCvoRenderRequest({ type: 'CVO_RENDER', runId: 1, html: '', javascript: '', data: [] })).toBeNull()
    expect(parseCvoRenderRequest({ type: 'CVO_RENDER', runId: 1, html: '', javascript: '', data: {}, libs: [{ rid: '1"]', content: '' }] })).toBeNull()
  })

  it('recognises the port hand-off', () => {
    expect(isCvoPortHandoff({ type: 'CVO_PORT' })).toBe(true)
    expect(isCvoPortHandoff({ type: 'CVO_RENDER' })).toBe(false)
  })
})
