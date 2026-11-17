/**
 * Sandbox isolation contract.
 *
 * The CVO preview runs CVO `javascript` as the text of a script element in an
 * MV3 sandboxed page (a unique OPAQUE origin with no access to chrome.*,
 * extension storage, or the host cookies). Those are manifest properties, not
 * code properties — a well-meaning manifest edit could silently turn the
 * preview into a privilege-escalation hole or an open network path with no
 * other test noticing. This test fails loudly if any of those guarantees
 * regresses. Whether Chrome honours each directive is a live-browser check.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(
  readFileSync(new URL('../../../manifest.json', import.meta.url), 'utf8'),
) as {
  sandbox?: { pages?: string[] }
  content_security_policy?: { extension_pages?: string; sandbox?: string }
}

const SANDBOX_PAGE = 'studio/sandbox.html'
const sandboxCsp = manifest.content_security_policy?.sandbox ?? ''

/** The source list of one directive, or undefined when it is absent. */
function directive(csp: string, name: string): string[] | undefined {
  const part = csp.split(';').map(s => s.trim()).find(s => s.split(/\s+/)[0] === name)
  return part?.split(/\s+/).slice(1)
}

describe('CVO sandbox isolation contract', () => {
  it('runs the CVO preview in a declared sandboxed page', () => {
    expect(manifest.sandbox?.pages ?? []).toContain(SANDBOX_PAGE)
  })

  it('does NOT grant the sandbox same-origin access, forms, popups or top navigation', () => {
    // `allow-same-origin` would re-join the sandbox to the extension origin.
    const flags = directive(sandboxCsp, 'sandbox')
    expect(flags).toEqual(['allow-scripts'])
  })

  it('allows no eval anywhere: neither the sandbox nor the privileged pages', () => {
    expect(sandboxCsp).not.toMatch(/unsafe-eval/)
    const pages = manifest.content_security_policy?.extension_pages ?? ''
    expect(pages).toMatch(/script-src[^;]*'self'/)
    expect(pages).not.toMatch(/unsafe-eval/)
  })

  it('gives the sandbox no network and no other way out', () => {
    expect(directive(sandboxCsp, 'default-src')).toEqual(["'none'"])
    expect(directive(sandboxCsp, 'connect-src')).toEqual(["'none'"])
    expect(directive(sandboxCsp, 'form-action')).toEqual(["'none'"])
    expect(directive(sandboxCsp, 'base-uri')).toEqual(["'none'"])
    expect(directive(sandboxCsp, 'object-src')).toEqual(["'none'"])
    expect(directive(sandboxCsp, 'script-src')).toEqual(["'self'", "'unsafe-inline'", 'blob:'])
    for (const name of ['style-src', 'img-src', 'media-src', 'font-src', 'frame-src', 'worker-src']) {
      const list = directive(sandboxCsp, name)
      expect(list, name).toBeDefined()
      // Local sources only: no scheme or host that reaches the network.
      for (const src of list!) expect(["'unsafe-inline'", 'data:', 'blob:'], `${name} ${src}`).toContain(src)
    }
  })

  it('stops the preview frame from navigating to a web address from the studio page', () => {
    const html = readFileSync(new URL('../studio.html', import.meta.url), 'utf8')
    expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="frame-src 'self'">/)
  })

  it('keeps the privileged studio page OUT of the sandbox list', () => {
    expect(manifest.sandbox?.pages ?? []).not.toContain('studio/studio.html')
  })

  it('runs no eval in the preview code, and posts nothing to a wildcard target from the studio', () => {
    const code = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code('sandbox.ts')).not.toMatch(/new Function\s*\(|\beval\s*\(/)
    expect(code('studio.ts')).not.toMatch(/postMessage\(/)
    // The only wildcard post in the host is the port hand-off, which carries no data.
    expect(code('preview-host.ts').match(/postMessage\([^)]*'\*'/g)).toEqual(["postMessage(handoff, '*'"])
  })
})
