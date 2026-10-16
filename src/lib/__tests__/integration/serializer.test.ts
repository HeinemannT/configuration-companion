/** Live, read-only test of the exact TypeScript binary transport used by the extension. */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  makeExtendedExecuteCommand,
  makeGetObjectCommand,
  makeAccessTraceCommand,
  makeLoadTypeConfigCommand,
  makeReferenceIdentityCommand,
  parseCommandResponse,
  parseEcResults,
  parseObjectData,
  registerBmpTypes,
} from '../../bmp-types'
import { extractAccessTrace } from '../../bmp-client'
import { commandResults, parseTypeCatalogue, parseReferenceIdentity } from '../../bmp-type-catalogue'
import { deserializeResponse, deserializeStream, serializeCommands } from '../../java-serial'
import { commandSignature } from '../../bmp-command-signature'
import { buildDiscoveryEc, integrationTarget, parseDiscoveryRows, type DiscoveryRow, type IntegrationTarget } from './config'

registerBmpTypes()

describe('Binary serializer integration', () => {
  let target: IntegrationTarget
  let jwt = ''
  let ticket = ''
  let organisations: DiscoveryRow[] = []

  beforeAll(async () => {
    target = integrationTarget()
    jwt = await login(target)
    ticket = await getLoginTicket(target, jwt)
    const discovery = await executeEcDirect(target, ticket, buildDiscoveryEc('Organisation'))
    if (!discovery.ok) throw new Error('Organisation discovery failed')
    organisations = parseDiscoveryRows(discovery.log)
    if (!organisations.length) throw new Error('Live discovery returned no Organisation rows')
  })

  it('authenticates and obtains a JWT without logging it', () => {
    expect(jwt).toBeTruthy()
  })

  it('serializes the Java stream header exactly', () => {
    const body = serializeCommands([makeGetObjectCommand(organisations[0].rid)])
    expect(Array.from(body.slice(0, 4))).toEqual([0xac, 0xed, 0x00, 0x05])
  })

  it('executes read-only EC through the TypeScript serializer', async () => {
    const result = await executeEcDirect(target, ticket, '_value := 1 + 1\n_value')
    expect(result.ok).toBe(true)
    expect(result.log).toContain('2')
  })

  it('deserializes a dynamically discovered BMP object', async () => {
    const source = organisations[0]
    const object = await getObject(target, ticket, source.rid)
    expect(object.rid).toBe(source.rid)
    expect(object.type).toBe('Organisation')
    expect(object.properties.name).toBe(source.name)
  })

  it('round-trips several current 64-bit RIDs', async () => {
    for (const source of organisations.slice(0, 3)) {
      const object = await getObject(target, ticket, source.rid)
      expect(object.rid).toBe(source.rid)
      expect(Number.isSafeInteger(Number(object.rid))).toBe(false)
    }
  })

  it('decodes live BMP trace durations at the request and rule levels', async () => {
    const discovery = await executeEcDirect(target, ticket, buildDiscoveryEc('Role'))
    if (!discovery.ok) throw new Error('Role discovery failed')
    const roles = parseDiscoveryRows(discovery.log)
    if (!roles.length) throw new Error('Live discovery returned no Role rows')
    const buffer = await sendCommand(target, ticket, makeAccessTraceCommand(organisations[0].rid, roles[0].rid, 'READ', 4))
    const trace = extractAccessTrace(deserializeStream(buffer, true))
    expect(trace?.durationMs).toBeGreaterThanOrEqual(0)
    expect(trace?.children.length).toBeGreaterThan(0)
    for (const child of trace!.children) {
      expect(child.durationMs).toBeGreaterThanOrEqual(0)
      expect(child.durationMs).toBeLessThanOrEqual(trace!.durationMs!)
    }
  })

  it('reads native type metadata and resolves identity in its declared ID space', async () => {
    const catalogue = parseTypeCatalogue(commandResults(deserializeStream(await sendCommand(target, ticket, makeLoadTypeConfigCommand()), true), 1)[0])
    expect(catalogue.types.Organisation.concrete).toBe(true)
    expect(catalogue.types.Organisation.parents.length).toBeGreaterThan(0)
    const source = organisations.find(o => o.businessId)
    if (!source || !catalogue.types.Organisation.idSpace) throw new Error('No Organisation with an ID space available')
    const buffer = await sendCommand(target, ticket, makeReferenceIdentityCommand(catalogue.types.Organisation.idSpace, source.businessId))
    expect(parseReferenceIdentity(commandResults(deserializeStream(buffer, true), 1)[0])).toMatchObject({ rid: source.rid, type: 'Organisation' })
  })
})

async function login(target: IntegrationTarget): Promise<string> {
  const authResp = await fetch(`${target.bmpUrl}cs/authentication`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(target.bmpUser)}&password=${encodeURIComponent(target.bmpPass)}`,
    redirect: 'manual',
  })
  const cookies = authResp.headers.getSetCookie?.() ?? [authResp.headers.get('set-cookie') ?? '']
  const jsession = cookies.join(';').match(/JSESSIONID=([^;,\s]+)/)?.[1]
  if (!jsession) throw new Error(`BMP login did not return JSESSIONID (HTTP ${authResp.status})`)
  const cookie = `JSESSIONID=${jsession}`

  const gqlResp = await fetch(`${target.bmpUrl}graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      query: 'query AuthorizationCode { authorizationCode { code } }',
      variables: {},
      operationName: 'AuthorizationCode',
    }),
  })
  const gql = await readJson<{ data?: { authorizationCode?: { code?: string } } }>(gqlResp, 'BMP GraphQL authorization')
  const authCode = gql.data?.authorizationCode?.code
  if (!authCode) throw new Error('BMP GraphQL did not return an authorization code')

  const tokenResp = await fetch(`${target.bmpUrl}cstoken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grantType=authorizationCode&authorizationCode=${encodeURIComponent(authCode)}`,
  })
  const token = await readJson<{ accessToken?: string }>(tokenResp, 'BMP token exchange')
  if (!token.accessToken) throw new Error('BMP token exchange did not return an access token')
  return token.accessToken
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text()
  if (!text) throw new Error(`${label} returned an empty body (HTTP ${response.status}, ${response.url})`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${label} returned invalid JSON (HTTP ${response.status}, ${response.url})`)
  }
}

async function getLoginTicket(target: IntegrationTarget, jwt: string): Promise<string> {
  const response = await fetch(`${target.bmpUrl}ticket`, { headers: { Authorization: `Bearer ${jwt}` } })
  if (!response.ok) throw new Error(`BMP ticket exchange failed with HTTP ${response.status}`)
  const ticket = await response.text()
  if (!ticket) throw new Error('BMP ticket exchange returned an empty ticket')
  return ticket
}

async function sendCommand(target: IntegrationTarget, ticket: string, command: unknown): Promise<ArrayBuffer> {
  const body = serializeCommands([command])
  const exact = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  const params = new URLSearchParams({ LOGIN_TICKET: ticket, async: 'false', _noctx: 'true' })
  const res = await fetch(`${target.bmpUrl}cs/command?${params}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-java-serialized-object',
      'X-CS-Login-Ticket': ticket,
      'X-CS-Signature': await commandSignature(ticket, exact as ArrayBuffer),
    },
    body: exact as unknown as BodyInit,
  })
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, ' ').trim().slice(0, 240)
    throw new Error(`BMP command failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`)
  }
  return res.arrayBuffer()
}

async function executeEcDirect(target: IntegrationTarget, ticket: string, code: string) {
  const buffer = await sendCommand(target, ticket, makeExtendedExecuteCommand(code, { transactional: false }))
  return parseEcResults(deserializeStream(buffer))
}

async function getObject(target: IntegrationTarget, ticket: string, rid: string) {
  const raw = deserializeResponse(await sendCommand(target, ticket, makeGetObjectCommand(rid)))
  if (raw?.$class?.includes('ServerExceptionResponse')) throw new Error(raw.message ?? 'BMP server exception')
  const first = parseCommandResponse(raw)[0]
  if (!first) throw new Error('BMP returned an empty command response')
  const object = parseObjectData(first.response ?? first)
  if (!object) throw new Error(`BMP object ${rid} could not be parsed`)
  return object
}
