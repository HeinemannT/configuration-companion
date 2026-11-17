import { describe, expect, it } from 'vitest'
import { childSaveRequest } from '../child-save'
import type { StudioChild } from '../../lib/types'

const conn: StudioChild = { rid: '9007199254740993', id: 'csc_1', type: 'connection', key: 'feed', url: 'u', urlParameters: '', headers: '', timeout: '30000.0' }
const table: StudioChild = { rid: '1', id: 'cvt_1', type: 'table', key: 'rows', table: '' }

describe('Studio data input save request', () => {
  it('sends the fields as before with their opened values as the expectation', () => {
    expect(childSaveRequest(conn, { url: 'v', urlParameters: '', headers: '', timeout: '100' })).toEqual({
      fields: { url: 'v', urlParameters: '', headers: '', timeout: '100' },
      expect: { key: 'feed', url: 'u', urlParameters: '', headers: '', timeout: '30000.0' },
    })
  })

  it('omits what the handler skipped before: an untouched non-integer timeout, an empty table that stays empty', () => {
    expect(childSaveRequest(conn, { url: 'u', timeout: '30000.0' }).fields).toEqual({ url: 'u' })
    expect(childSaveRequest(table, { table: '' }).fields).toEqual({})
  })

  it('sends a changed invalid value so the handler names the rejected field', () => {
    expect(childSaveRequest(conn, { timeout: '30s' }).fields).toEqual({ timeout: '30s' })
    expect(childSaveRequest({ ...table, table: 'tbl_a' }, { table: '' }).fields).toEqual({ table: '' })
  })
})
