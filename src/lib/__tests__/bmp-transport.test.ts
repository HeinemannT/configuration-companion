import { afterEach, describe, expect, it, vi } from 'vitest'
import { BmpTransport, BmpTransportError, commandReplayIntent } from '../bmp-transport'
import { BACKGROUND_TIMEOUT, backgroundSignal, lowPrioritySignal, promoteToUser } from '../request-class'
import { makeExtendedExecuteCommand, makeGetObjectCommand, makeUpdateCommand, registerBmpTypes } from '../bmp-types'

afterEach(() => vi.unstubAllGlobals())

function mockAuth() {
  return {
    sessionEpoch: 0,
    getLoginTicket: vi.fn().mockResolvedValue('ticket value'),
    refreshLoginTicket: vi.fn().mockResolvedValue('fresh ticket'),
    invalidateLoginTicket: vi.fn(),
    rejectCommandAuthentication: vi.fn(),
    fetchCommand: vi.fn(async (ticket: string, init: RequestInit, consume: (response: Response) => Promise<unknown>) => consume(await fetch(
      `https://bmp.test/Workspace/cs/command?LOGIN_TICKET=${encodeURIComponent(ticket)}&async=false&_noctx=true`, init))),
  }
}

describe('BmpTransport command requests', () => {
  it('reports session replacement during authentication as cancellation without dispatch', async () => {
    const auth = mockAuth()
    auth.getLoginTicket.mockImplementation(async () => { auth.sessionEpoch++; throw new Error('Superseded login') })
    const transport = new BmpTransport('https://bmp.test/', auth as never)
    await expect(transport.sendRequest(new Uint8Array([1]), 1000, 'write')).rejects.toMatchObject({ kind: 'cancelled', attempts: 0 })
    expect(auth.fetchCommand).not.toHaveBeenCalled()
  })

  it('defaults unknown commands and ambiguous EC flags to no replay', () => {
    expect(commandReplayIntent([{ $type: 'FutureCommand' }], 'read')).toBe('write')
    expect(commandReplayIntent([makeExtendedExecuteCommand('1'), { $type: 'FutureCommand' }], 'read')).toBe('write')
    const ec = makeExtendedExecuteCommand('1')
    delete ec.transactional
    expect(commandReplayIntent([ec], 'read')).toBe('write')
    expect(commandReplayIntent([makeGetObjectCommand('1')], 'write')).toBe('write')
    expect(commandReplayIntent([makeGetObjectCommand('1'), makeExtendedExecuteCommand('1')], 'read')).toBe('read')
  })
  it.each(['cancel', 'identity'] as const)('does not recover an old read after %s at the response boundary', async change => {
    const auth = mockAuth()
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (change === 'cancel') controller.abort()
      else auth.sessionEpoch++
      return new Response(null, { status: 401 })
    }))
    const transport = new BmpTransport('https://bmp.test/', auth as never)
    await expect(transport.sendRequest(new Uint8Array([1]), 1000, 'read', controller.signal)).rejects.toBeInstanceOf(BmpTransportError)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
    expect(auth.rejectCommandAuthentication).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['update', 'mixed batch', 'committed EC'] as const)('never replays %s even when a caller labels it read', async kind => {
    registerBmpTypes()
    const auth = mockAuth()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    const transport = new BmpTransport('https://bmp.test/', auth as never)
    const update = makeUpdateCommand('1', 'Organisation', { name: 'example' })
    const request = kind === 'committed EC'
      ? transport.sendStreamingCommand(makeExtendedExecuteCommand('1', { transactional: true }), 'read')
      : transport.sendCommands(kind === 'update' ? [update] : [makeGetObjectCommand('1'), update], 'read')
    await expect(request).rejects.toBeInstanceOf(BmpTransportError)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })
  it('serializes concurrent command posts sharing one transport session', async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve
    })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport(
      'https://bmp.test/Workspace/',
      mockAuth() as never,
    )

    const first = transport.sendRequest(new Uint8Array([1]), 1_000, 'read')
    const second = transport.sendRequest(new Uint8Array([2]), 1_000, 'read')

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseFirst?.(new Response(new Uint8Array([1]), { status: 200 }))
    await first
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await second

    expect(new Uint8Array(fetchMock.mock.calls[0][1].body as ArrayBuffer)).toEqual(
      new Uint8Array([1]),
    )
    expect(new Uint8Array(fetchMock.mock.calls[1][1].body as ArrayBuffer)).toEqual(
      new Uint8Array([2]),
    )
  })

  it('drops a cancelled queued command before it posts to BMP', async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve
    })
    const fetchMock = vi.fn().mockImplementationOnce(() => firstResponse)
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport(
      'https://bmp.test/Workspace/',
      mockAuth() as never,
    )
    const controller = new AbortController()

    const first = transport.sendRequest(new Uint8Array([1]), 1_000, 'read')
    const queued = transport.sendRequest(new Uint8Array([2]), 1_000, 'read', controller.signal)
      .catch(error => error)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    releaseFirst?.(new Response(new Uint8Array([1]), { status: 200 }))
    await first

    await expect(queued).resolves.toMatchObject({ kind: 'cancelled', attempts: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('continues the request queue after a failed command', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport(
      'https://bmp.test/Workspace/',
      mockAuth() as never,
    )

    const failed = transport.sendRequest(new Uint8Array([1]), 1_000, 'write').catch(error => error)
    const succeeded = transport.sendRequest(new Uint8Array([2]), 1_000, 'read')

    await expect(failed).resolves.toMatchObject({ kind: 'network', attempts: 1 })
    await expect(succeeded).resolves.toBeInstanceOf(ArrayBuffer)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses the cross-version LoginTicket path with required command flags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac, 0xed]), 1_000, 'read')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bmp.test/Workspace/cs/command?LOGIN_TICKET=ticket%20value&async=false&_noctx=true',
      expect.objectContaining({ method: 'POST', credentials: 'omit', redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer' }),
    )
  })

  it('replays a read once with a refreshed ticket after 401', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.refreshLoginTicket).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[1][0]).toContain('LOGIN_TICKET=fresh%20ticket')
  })

  it('never replays a write after 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'write').catch(e => e)

    expect(error).toBeInstanceOf(BmpTransportError)
    expect(error).toMatchObject({ kind: 'auth', status: 401, attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.rejectCommandAuthentication).toHaveBeenCalledTimes(1)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
    expect(error.message).toContain('The command was not retried')
    expect(error.message).not.toContain('expired')
  })

  it.each(['stored', 'portal'] as const)('explains rejection of a renewed %s ticket without claiming expiry', async (authMode) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = { ...mockAuth(), authMode }
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)

    expect(error).toMatchObject({ kind: 'auth', status: 401, attempts: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.refreshLoginTicket).toHaveBeenCalledTimes(1)
    expect(auth.rejectCommandAuthentication).toHaveBeenCalledTimes(1)
    expect(error.message).toContain('/cs/command (HTTP 401)')
    expect(error.message).toContain(authMode === 'stored' ? 'A new stored Studio session was also rejected' : 'A renewed portal-session ticket')
    expect(error.message).not.toMatch(/expired|fresh ticket|LOGIN_TICKET/)
  })

  it.each(['read', 'write'] as const)('stops a %s command at a gateway redirect without another login or POST', async (intent) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 307,
      headers: { Location: 'https://sso.example/sign-in?private=hidden' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, intent).catch(e => e)

    expect(error).toMatchObject({ kind: 'auth', status: 307, attempts: 1 })
    expect(error.message).toContain('redirected /cs/command')
    expect(error.message).not.toContain('private')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })

  it('recognizes an opaque browser redirect without exposing its destination', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ type: 'opaqueredirect', status: 0 })
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)

    expect(error).toMatchObject({ kind: 'auth', attempts: 1 })
    expect(error.status).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports an HTML sign-in response before binary decoding and does not log its contents', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>private sign-in state</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)

    expect(error).toMatchObject({ kind: 'auth', status: 200, attempts: 1 })
    expect(error.message).toContain('HTML sign-in page from /cs/command')
    expect(error.message).not.toContain('private')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })

  it('classifies 403 as permission failure without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)

    expect(error).toMatchObject({ kind: 'permission', status: 403, attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })

  it('replays a read once after a transient network failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })

  it('never replays a write after a transient network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'write').catch(e => e)

    expect(error).toMatchObject({ kind: 'network', attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports retry exhaustion with two attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)

    expect(error).toMatchObject({ kind: 'network', attempts: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('distinguishes caller cancellation from timeout and does not retry either', async () => {
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const cancelled = await transport.sendRequest(
      new Uint8Array([0xac]),
      1_000,
      'read',
      controller.signal,
    ).catch(e => e)
    expect(cancelled).toMatchObject({ kind: 'cancelled', attempts: 0 })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    const timedOut = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)
    expect(timedOut).toMatchObject({ kind: 'timeout', attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries transient 503 only for reads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports command identity, queue pressure, sizes, and retry count', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const outcomes: any[] = []
    transport.setOutcomeObserver(outcome => outcomes.push(outcome))

    await transport.sendRequest(
      new Uint8Array([0xac]),
      1_000,
      'read',
      undefined,
      { operation: 'TreeItemCommand', commandCount: 1 },
    )

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      ok: true,
      intent: 'read',
      operation: 'TreeItemCommand',
      commandCount: 1,
      queueDepth: 0,
      attempts: 2,
      responseBytes: 3,
    })
    expect(outcomes[0].requestBytes).toBeGreaterThan(0)
    expect(outcomes[0].queueWaitMs).toBeGreaterThanOrEqual(0)
    expect(outcomes[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  it('classifies malformed binary responses as protocol failures', () => {
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const malformed = new Uint8Array([0x00, 0x01]).buffer
    const outcomes: any[] = []
    transport.setOutcomeObserver(outcome => outcomes.push(outcome))

    expect(() => transport.deserializeResponse(malformed)).toThrow(
      expect.objectContaining({ kind: 'protocol' }),
    )
    expect(() => transport.deserializeStream(malformed)).toThrow(
      expect.objectContaining({ kind: 'protocol' }),
    )
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toMatchObject({ ok: false, intent: 'read', error: { kind: 'protocol' } })
  })
})

describe('BmpTransport request classes', () => {
  /** fetch whose answers the test releases one by one; records post order. */
  function gatedFetch() {
    const order: number[] = []
    const gates: Array<(response: Response) => void> = []
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      order.push(new Uint8Array(init.body as ArrayBuffer)[0])
      return new Promise<Response>(resolve => gates.push(resolve))
    })
    vi.stubGlobal('fetch', fetchMock)
    const release = async () => {
      await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0))
      gates.shift()!(new Response(new Uint8Array([9]), { status: 200 }))
    }
    return { order, fetchMock, release, gates }
  }
  const body = (n: number) => new Uint8Array([n])

  it('sends a waiting user request before waiting background requests, and never interrupts the post in flight', async () => {
    const g = gatedFetch()
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const inFlightSignal = backgroundSignal()
    const bg1 = transport.sendRequest(body(1), 1_000, 'read', inFlightSignal)
    await vi.waitFor(() => expect(g.fetchMock).toHaveBeenCalledTimes(1))
    const bg2 = transport.sendRequest(body(2), 1_000, 'read', backgroundSignal())
    const bg3 = transport.sendRequest(body(3), 1_000, 'read', backgroundSignal())
    const user = transport.sendRequest(body(4), 1_000, 'read')
    // Still one post at a time: the user request waits for the post in flight.
    await new Promise(r => setTimeout(r, 20))
    expect(g.fetchMock).toHaveBeenCalledTimes(1)
    expect(inFlightSignal.aborted).toBe(false)
    for (let i = 0; i < 4; i++) await g.release()
    await Promise.all([bg1, bg2, bg3, user])
    expect(g.order).toEqual([1, 4, 2, 3])
  })

  it('a user post goes between two low-priority listing posts; low ones still go before background ones', async () => {
    const g = gatedFetch()
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const listing = lowPrioritySignal(new AbortController().signal)
    const l1 = transport.sendRequest(body(1), 1_000, 'read', listing)
    await vi.waitFor(() => expect(g.fetchMock).toHaveBeenCalledTimes(1))
    // The listing's next post is already waiting when the user opens an object.
    const l2 = transport.sendRequest(body(2), 1_000, 'read', listing)
    const bg = transport.sendRequest(body(3), 1_000, 'read', backgroundSignal())
    const user = transport.sendRequest(body(4), 1_000, 'read')
    for (let i = 0; i < 4; i++) await g.release()
    await Promise.all([l1, l2, bg, user])
    expect(g.order).toEqual([1, 4, 2, 3])
    // Stopping the listing between posts drops its waiting post.
    const stop = new AbortController()
    const low = lowPrioritySignal(stop.signal)
    const a = transport.sendRequest(body(5), 1_000, 'read', low)
    await vi.waitFor(() => expect(g.fetchMock).toHaveBeenCalledTimes(5))
    const b = transport.sendRequest(body(6), 1_000, 'read', low).catch(e => e)
    stop.abort()
    await g.release()
    await a.catch(() => undefined)
    expect(await b).toMatchObject({ kind: 'cancelled' })
    expect(g.order).toEqual([1, 4, 2, 3, 5])
  })

  it('keeps first-in-first-out order inside each class', async () => {
    const g = gatedFetch()
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const first = transport.sendRequest(body(1), 1_000, 'read')
    await vi.waitFor(() => expect(g.fetchMock).toHaveBeenCalledTimes(1))
    const all = [
      first,
      transport.sendRequest(body(2), 1_000, 'read', backgroundSignal()),
      transport.sendRequest(body(3), 1_000, 'read'),
      transport.sendRequest(body(4), 1_000, 'read', backgroundSignal()),
      transport.sendRequest(body(5), 1_000, 'read'),
    ]
    for (let i = 0; i < 5; i++) await g.release()
    await Promise.all(all)
    expect(g.order).toEqual([1, 3, 5, 2, 4])
  })

  it('sends a promoted background post as a user post and no longer drops it on supersede', async () => {
    const g = gatedFetch()
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const first = transport.sendRequest(body(1), 1_000, 'read')
    await vi.waitFor(() => expect(g.fetchMock).toHaveBeenCalledTimes(1))
    const page = new AbortController()
    const older = transport.sendRequest(body(2), 1_000, 'read', backgroundSignal())
    const hoverSignal = backgroundSignal({ supersede: page.signal })
    const hover = transport.sendRequest(body(3), 1_000, 'read', hoverSignal)
    promoteToUser(hoverSignal)
    page.abort()
    for (let i = 0; i < 3; i++) await g.release()
    await Promise.all([first, older, hover])
    expect(g.order).toEqual([1, 3, 2])
  })

  it('removes a superseded background request from the queue without posting it', async () => {
    const g = gatedFetch()
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const outcomes: any[] = []
    transport.setOutcomeObserver(outcome => outcomes.push(outcome))
    const first = transport.sendRequest(body(1), 1_000, 'read', backgroundSignal())
    await vi.waitFor(() => expect(g.fetchMock).toHaveBeenCalledTimes(1))
    const page = new AbortController()
    const superseded = transport.sendRequest(body(2), 1_000, 'read', backgroundSignal({ supersede: page.signal })).catch(e => e)
    const after = transport.sendRequest(body(3), 1_000, 'read', backgroundSignal())
    page.abort()
    // It leaves at once, not when its turn comes.
    await expect(superseded).resolves.toMatchObject({ kind: 'cancelled', attempts: 0 })
    expect(outcomes).toContainEqual(expect.objectContaining({ ok: false, attempts: 0, requestBytes: 1 }))
    await g.release()
    await g.release()
    await Promise.all([first, after])
    expect(g.order).toEqual([1, 3])
  })

  it('does not interrupt a superseded background post that is already in flight', async () => {
    const g = gatedFetch()
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const page = new AbortController()
    const inFlight = transport.sendRequest(body(1), 1_000, 'read', backgroundSignal({ supersede: page.signal }))
    await vi.waitFor(() => expect(g.fetchMock).toHaveBeenCalledTimes(1))
    page.abort()
    const next = transport.sendRequest(body(2), 1_000, 'read')
    await new Promise(r => setTimeout(r, 20))
    // The lane stays held: BMP is still working on the first post.
    expect(g.fetchMock).toHaveBeenCalledTimes(1)
    await g.release()
    await expect(inFlight).resolves.toBeInstanceOf(ArrayBuffer)
    await g.release()
    await next
  })

  it('gives background posts a shorter timeout than user posts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })))
    const timeouts: number[] = []
    const original = AbortSignal.timeout.bind(AbortSignal)
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { timeouts.push(ms); return original(ms) })
    try {
      const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
      await transport.sendRequest(body(1), 30_000, 'read')
      await transport.sendRequest(body(2), 30_000, 'read', backgroundSignal())
      await transport.sendRequest(body(3), 2_000, 'read', backgroundSignal())
    } finally { spy.mockRestore() }
    expect(timeouts[0]).toBeGreaterThan(BACKGROUND_TIMEOUT)
    expect(timeouts[1]).toBeLessThanOrEqual(BACKGROUND_TIMEOUT)
    expect(timeouts[1]).toBeGreaterThan(BACKGROUND_TIMEOUT - 1_000)
    expect(timeouts[2]).toBeLessThanOrEqual(2_000)
  })

  it('rejects at once when the background request was superseded before it queued', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const page = new AbortController()
    page.abort()
    await expect(transport.sendRequest(body(1), 1_000, 'read', backgroundSignal({ supersede: page.signal })))
      .rejects.toMatchObject({ kind: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
