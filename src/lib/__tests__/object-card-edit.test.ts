// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { buildObjectCard, supportsObjectCardCode } from '../object-card'
import type { IdentitySaveResult } from '../object-identity'
import { asUser, userClick } from './user-event'

function editableCard(onSave = vi.fn(async (identity: { businessId?: string; name?: string; templateBusinessId?: string }, _expect?: unknown) => ({
  ok: true,
  ...identity,
} as IdentitySaveResult))) {
  return {
    card: buildObjectCard({
      businessId: 'old_id',
      name: 'Old name',
      templateBusinessId: 'old_template',
      type: 'Label',
      rid: '9007199254740993',
      color: '#8a3ffc',
    }, { onSaveIdentity: onSave }),
    onSave,
  }
}

describe('object card identity editor', () => {
  it('derives code actions from type capability, not RID or preview presence', () => {
    expect(supportsObjectCardCode('ExtendedExpression')).toBe(true)
    expect(supportsObjectCardCode('ModelPage')).toBe(false)
    expect(supportsObjectCardCode(undefined)).toBe(false)
  })

  it('presents template identity first and retains the instance as secondary context', () => {
    const { card } = editableCard()
    const rows = Array.from(card.querySelectorAll<HTMLElement>('.crev-tt-cprow'))
      .map(row => row.textContent)

    expect(rows[0]).toContain('ID')
    expect(rows[0]).toContain('old_template')
    expect(rows[1]).toContain('Instance ID')
    expect(rows[1]).toContain('old_id')
    expect(rows[2]).toContain('RID')
  })

  it('opens from the pencil and discards with Escape', () => {
    const { card, onSave } = editableCard()
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)

    const id = card.querySelector<HTMLInputElement>('input[name="businessId"]')!
    id.value = 'changed_id'
    id.dispatchEvent(new Event('input', { bubbles: true }))
    // A changed ID is unsaved: the first Escape asks, the second discards.
    id.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(card.querySelector('input[name="businessId"]')).not.toBeNull()
    expect(card.dataset.unsaved).toBe('true')
    expect(card.querySelector('.crev-tt-edit-status')!.textContent).toContain('Escape again to discard')
    id.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(card.querySelector('input[name="businessId"]')).toBeNull()
    expect(card.dataset.unsaved).toBeUndefined()
    expect(card.textContent).toContain('old_id')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('with nothing typed, Escape leaves the editor at once', () => {
    const { card } = editableCard()
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)
    const id = card.querySelector<HTMLInputElement>('input[name="businessId"]')!
    id.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(card.querySelector('input[name="businessId"]')).toBeNull()
  })

  it('edits the existing title and ID row in place', () => {
    const { card } = editableCard()
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)

    expect(card.querySelector('.crev-tt-nm > input[name="name"]')).not.toBeNull()
    expect(card.querySelector('.crev-tt-edit-idrow > input[name="businessId"]')).not.toBeNull()
    expect(card.querySelector('.crev-tt-edit-idrow > input[name="templateBusinessId"]')).not.toBeNull()
    expect(card.querySelector('.crev-tt-body input[name="name"]')).toBeNull()
    expect(card.querySelectorAll('.crev-tt-edit-idrow')).toHaveLength(2)
  })

  it('saves on Enter and shows verified inline feedback', async () => {
    const { card, onSave } = editableCard()
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)

    const id = card.querySelector<HTMLInputElement>('input[name="businessId"]')!
    const name = card.querySelector<HTMLInputElement>('input[name="name"]')!
    const template = card.querySelector<HTMLInputElement>('input[name="templateBusinessId"]')!
    id.value = 'new_id'
    name.value = 'New name'
    template.value = 'new_template'
    name.dispatchEvent(asUser(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })))
    await Promise.resolve()

    expect(onSave).toHaveBeenCalledWith({
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    }, {
      businessId: 'old_id',
      name: 'Old name',
      templateBusinessId: 'old_template',
    })
    expect(card.querySelector('.crev-tt-edit-status--success')?.textContent).toContain('Saved and verified')
  })

  it('keeps invalid IDs in the card with quiet inline validation', () => {
    const { card, onSave } = editableCard()
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)
    card.querySelector<HTMLInputElement>('input[name="businessId"]')!.value = 'bad id'
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!)

    expect(card.querySelector('.crev-tt-edit-status--error')?.textContent).toContain('letters, numbers, and underscores')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('validates the template ID in place', () => {
    const { card, onSave } = editableCard()
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)
    card.querySelector<HTMLInputElement>('input[name="templateBusinessId"]')!.value = 'bad template'
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!)

    expect(card.querySelector('.crev-tt-edit-status--error')?.textContent).toContain('template ID')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('focuses a field-addressable verification error returned by the service worker', async () => {
    const onSave = vi.fn(async (identity: { businessId?: string; name?: string; templateBusinessId?: string }, _expect?: unknown) => ({
      ok: false,
      field: 'templateBusinessId' as const,
      error: 'Template ID is already in use.',
      ...identity,
    }))
    const { card } = editableCard(onSave)
    document.body.appendChild(card)
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)
    card.querySelector<HTMLInputElement>('input[name="templateBusinessId"]')!.value = 'duplicate_template'
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!)
    await Promise.resolve()

    expect(document.activeElement).toBe(card.querySelector('input[name="templateBusinessId"]'))
    expect(card.querySelector('.crev-tt-edit-status--error')?.textContent).toContain('already in use')
    card.remove()
  })

  it('sends only the edited ID with its opened value, never the untouched name', async () => {
    const { card, onSave } = editableCard()
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)
    card.querySelector<HTMLInputElement>('input[name="businessId"]')!.value = 'new_id'
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!)
    await Promise.resolve()

    expect(onSave).toHaveBeenCalledWith({ businessId: 'new_id' }, { businessId: 'old_id' })
  })

  it('on a change in BMP keeps the typed value, shows the BMP value and overwrites on the next save', async () => {
    const onSave = vi.fn(async (_patch: { businessId?: string; name?: string }, _expect?: unknown): Promise<IdentitySaveResult> => ({
      ok: false, notSent: true, error: 'Name changed in BMP since you opened it. Nothing was saved.',
      conflict: [{ prop: 'name', opened: 'Old name', current: 'Renamed elsewhere' }],
    }))
    const { card } = editableCard(onSave)
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)
    const name = card.querySelector<HTMLInputElement>('input[name="name"]')!
    name.value = 'My name'
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!)
    await Promise.resolve()
    await Promise.resolve()

    expect(card.querySelector('.crev-tt-edit-status--error')?.textContent)
      .toBe('Changed in BMP since you opened it: Name is now "Renamed elsewhere". Save again to overwrite it, or press Escape to cancel.')
    expect(name.value).toBe('My name')
    expect(name.disabled).toBe(false)

    onSave.mockResolvedValueOnce({ ok: true, name: 'My name', businessId: 'old_id' })
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!)
    await Promise.resolve()
    expect(onSave).toHaveBeenLastCalledWith({ name: 'My name' }, { name: 'Renamed elsewhere' })
  })
  it('ignores a save, an Enter or an edit-open that page script dispatches', async () => {
    const { card, onSave } = editableCard()
    // A synthetic click does not even open the editor.
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!.click()
    expect(card.querySelector('input[name="businessId"]')).toBeNull()

    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-open')!)
    const id = card.querySelector<HTMLInputElement>('input[name="businessId"]')!
    id.value = 'forged_id'
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!.click()
    card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    id.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await Promise.resolve()
    expect(onSave).not.toHaveBeenCalled()

    // The user's own click saves.
    userClick(card.querySelector<HTMLButtonElement>('.crev-tt-edit-save')!)
    await Promise.resolve()
    expect(onSave).toHaveBeenCalledWith({ businessId: 'forged_id' }, { businessId: 'old_id' })
  })
})
