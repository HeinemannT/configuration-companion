// @vitest-environment happy-dom
/**
 * Blueprint's review names the acting BMP user. Blueprint is its own bundle
 * (content-blueprint.js) next to content.js in the same isolated world; only
 * content.js receives the worker's CONNECTION_STATE push.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IdentityMap } from '../../lib/types'
import { warmImports } from '../../lib/__tests__/warm-imports'

// The modules these tests load fresh in every test, once, before them.
warmImports(() => Promise.all([import('../../lib/command-actor'), import('../view-panels')]))

const connected = (user: string): IdentityMap => ({
  portal: { status: 'connected', user, source: 'portal-session' },
  command: { status: 'connected', user, source: 'portal-session' },
} as IdentityMap)

afterEach(() => { delete (globalThis as Record<string, unknown>).__crevCommandIdentities; vi.unstubAllGlobals() })

describe('acting user in the Blueprint bundle', () => {
  it('a push received by content.js is seen by a second copy of the module (the Blueprint bundle)', async () => {
    vi.resetModules()
    const contentCopy = await import('../../lib/command-actor')
    vi.resetModules()
    const blueprintCopy = await import('../../lib/command-actor')
    expect(blueprintCopy).not.toBe(contentCopy)
    const seen = vi.fn()
    const off = blueprintCopy.onCommandActorChange(seen)
    contentCopy.setCurrentIdentities(connected('admin'))
    expect(blueprintCopy.currentCommandActor()?.text).toBe('Runs as admin · browser session')
    expect(seen).toHaveBeenCalledTimes(1)
    off()
  })

  it('the review asks for its own tab\'s profile on demand and follows later changes', async () => {
    vi.resetModules()
    const sendMessage = vi.fn(async () => ({ type: 'CONNECTION_STATE', state: { identities: connected('admin'), display: 'online' } }))
    vi.stubGlobal('chrome', { runtime: { sendMessage }, storage: { session: { get: vi.fn(async () => ({})) } } })
    const { actorRow } = await import('../view-panels')
    const row = actorRow()
    document.body.appendChild(row)
    expect(row.textContent).toBe('Checking which BMP user these changes run as…')
    await vi.waitFor(() => expect(row.textContent).toBe('Runs as admin · browser session'))
    expect(sendMessage).toHaveBeenCalledWith({ type: 'GET_CONNECTION_STATE' })
    const { setCurrentIdentities } = await import('../../lib/command-actor')
    setCurrentIdentities(connected('other'))
    expect(row.textContent).toBe('Runs as other · browser session')
    expect(row.classList.contains('unverified')).toBe(false)
  })

  it('without an answer it says so', async () => {
    vi.resetModules()
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => undefined) }, storage: { session: { get: vi.fn(async () => { throw new Error('no session storage in content scripts') }) } } })
    const { actorRow } = await import('../view-panels')
    const row = actorRow()
    await vi.waitFor(() => expect(row.textContent).toContain('could not confirm which BMP user'))
    expect(row.classList.contains('unverified')).toBe(true)
  })
})
