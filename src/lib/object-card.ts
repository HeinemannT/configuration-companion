/**
 * Shared object hover card — ONE builder for the badge-hover card (content
 * script, `#crev-tooltip`) AND the EC editor's BID hover (iframe). Both used
 * to hand-roll their own card DOM; this is the single source so they look and
 * behave identically. Plain `document.createElement` so it works in either
 * document context (the editor runs in its own iframe document).
 *
 * The `.crev-tt-*` class contract is shared too — content-overlay.css and
 * editor.css both style these classes (light card, theme-independent).
 */
import { isUserAction } from './trusted-event'
import { shortcutLabel } from './shortcuts'
import { copyWithFeedback } from './copy-feedback'
import { h, svg } from './dom'
import { ICON_ARROWS_OUT_SIMPLE, ICON_CHECK, ICON_CODE, ICON_PENCIL, ICON_X, ICON_SHIELD_PH } from './icons'
import {
  normalizeAndValidateIdentity,
  resolveDisplayIdentity,
  type IdentityPatch,
  type IdentityField,
  type IdentitySaveResult,
} from './object-identity'
import { typeAffordances } from './widget-metadata'
import { copyLegend, distinctInstanceId, resolveCopyKind, type CopyKind } from './namespace'
import { unreadValue } from './failure-form'
import { typeLabel } from './object-window-table'

/** Shared capability policy for every object-card surface. A resolved rid or a
 * preview string does not make a non-code BMP type editable. */
export function supportsObjectCardCode(type?: string): boolean {
  return !!type && typeAffordances(type).code
}

export interface ObjectCardData {
  name?: string
  type?: string
  /** Shown in the type line when `type` is absent (e.g. "Loading…" / "Unknown"). */
  typeFallback?: string
  businessId?: string
  templateBusinessId?: string
  rid?: string
  /** Type accent colour (hex) for the header tint + dot. */
  color: string
  /** A short source excerpt to show under the facts (EC / html / js). */
  codePreview?: string
  /** Show the badge's click-modifier legend under the rows (the in-page
   *  card; the editor's BID hover has no badge to click). */
  showCopyLegend?: boolean
  /** The read of this object failed (the reason). The type line then says "could not be read"
   *  with the reason and Retry, never a type-like "Unknown". */
  unread?: string
}

export interface ObjectCardActions {
  /** Expand icon in the header — opens the full object view. Omit to hide. */
  onOpenFull?: () => void
  /** Code icon in the header — opens the EC editor / studio. Omit to hide. */
  onOpenEc?: () => void
  onOpenAccess?: () => void
  /** Pencil icon in the header. Omit on read-only card instances. */
  /** Only the edited fields (`patch`) and the values they were opened with
   *  (`expect`); an untouched field is never sent. */
  onSaveIdentity?: (patch: IdentityPatch, expect: IdentityPatch) => Promise<IdentitySaveResult>
  /** Read the object again after a failed read (shown with `unread`). */
  onRetryRead?: () => void
  /** Copy a row's value and report it (the in-page card shows the same toast
   *  as a badge). Resolves whether the copy worked. Omit to show the result
   *  in the row itself. */
  onCopy?: (kind: CopyKind) => Promise<boolean>
}

/** One copy-on-click fact row: label, then the value in muted monospace.
 *  Null when the value is empty. */
function copyRow(
  kind: CopyKind,
  k: string,
  value: string | undefined,
  onCopy?: (kind: CopyKind) => Promise<boolean>,
): HTMLElement | null {
  if (!value) return null
  const v = h('span', { class: 'crev-tt-v' }, value)
  const row = h('button', {
    class: 'crev-tt-cprow',
    type: 'button',
    'aria-label': `Copy ${k} ${value}`,
    'data-copy-kind': kind,
    onClick: (e: Event) => {
      e.stopPropagation()
      if (onCopy) {
        void onCopy(kind).then(ok => {
          if (!ok) return
          row.classList.add('crev-tt-cprow--ok')
          setTimeout(() => row.classList.remove('crev-tt-cprow--ok'), 900)
        })
        return
      }
      // "Copied" only after the write succeeded; a blocked write says so.
      void copyWithFeedback(value, v, { textTarget: v, okClass: 'crev-tt-v--ok', failClass: 'crev-tt-v--fail', ms: 900 })
    },
  }, h('span', { class: 'crev-tt-k' }, k), v) as HTMLButtonElement
  return row
}

/** The copy rows of an identity, in the order of the click scheme. The
 *  instance row appears only when it differs from the ID row. */
function identityRows(
  identity: { rid?: string; businessId?: string; templateBusinessId?: string; type?: string },
  onCopy?: (kind: CopyKind) => Promise<boolean>,
): HTMLElement[] {
  const ident = { rid: identity.rid ?? '', ...identity }
  const id = resolveCopyKind(ident, 'id')
  const instance = distinctInstanceId(ident)
  const rid = resolveCopyKind(ident, 'rid')
  const reference = resolveCopyKind(ident, 'reference')
  return [
    copyRow('id', id.label, id.text, onCopy),
    instance ? copyRow('instance', 'Instance ID', instance, onCopy) : null,
    copyRow('rid', rid.label, rid.text, onCopy),
    copyRow('reference', reference.label, reference.text, onCopy),
  ].filter((row): row is HTMLElement => row !== null)
}

/** The card's one hint line: what each badge click copies. The Instance ID
 *  entry only where the card has an Instance ID row. The badge keys (Space,
 *  Alt+Enter, F8…) are in the `?` cheat sheet, not on the card. */
function legend(withInstance: boolean): HTMLElement {
  return h('div', { class: 'crev-tt-legend', 'aria-label': 'Badge clicks' },
    ...copyLegend(undefined, withInstance).map(([key, what]) =>
      h('span', { class: what === 'Instance ID' ? 'crev-tt-lg crev-tt-lg--instance' : 'crev-tt-lg' }, h('kbd', null, key), what)),
  )
}

/** Keep the hint row on one line: the Instance ID entry stays only while
 *  the row fits the card's width; otherwise the row is Click · Shift · Ctrl.
 *  Call once the card is laid out (it measures). */
export function fitCardLegend(card: HTMLElement): void {
  const row = card.querySelector<HTMLElement>('.crev-tt-legend')
  const instance = row?.querySelector('.crev-tt-lg--instance')
  if (!row || !instance || !row.clientWidth) return
  if (row.scrollWidth > row.clientWidth) instance.remove()
}

export function buildObjectCard(data: ObjectCardData, actions: ObjectCardActions = {}): HTMLElement {
  const typeName = data.type ? typeLabel(data.type) : data.typeFallback ?? 'Not read yet'
  let businessId = data.businessId ?? ''
  let name = data.name ?? ''
  let templateBusinessId = data.templateBusinessId ?? ''

  const headActions: HTMLElement[] = []
  if (actions.onOpenAccess) {
    const label = data.type === 'Role' ? 'Open role in Access' : 'Open policy in Access'
    headActions.push(h('button', { class: 'crev-tt-open', type: 'button', title: label, 'aria-label': label,
      onClick: (event: Event) => { event.stopPropagation(); actions.onOpenAccess!() },
    }, svg(ICON_SHIELD_PH)))
  }
  if (actions.onSaveIdentity) {
    headActions.push(h('button', {
      class: 'crev-tt-open crev-tt-edit-open',
      type: 'button',
      title: 'Edit identity',
      'aria-label': 'Edit identity',
    }, svg(ICON_PENCIL)))
  }
  if (actions.onOpenEc) {
    headActions.push(h('button', {
      class: 'crev-tt-open',
      type: 'button',
      title: 'Open in the Extended Code editor',
      'aria-label': 'Open in the Extended Code editor',
      onClick: (e: Event) => { e.stopPropagation(); actions.onOpenEc!() },
    }, svg(ICON_CODE)))
  }
  if (actions.onOpenFull) {
    headActions.push(h('button', {
      class: 'crev-tt-open',
      type: 'button',
      title: data.showCopyLegend ? `Open full object view (or double-click the badge, or ${shortcutLabel('inspect.open')} on it)` : 'Open full object view',
      'aria-label': 'Open full object view',
      onClick: (e: Event) => { e.stopPropagation(); actions.onOpenFull!() },
    }, svg(ICON_ARROWS_OUT_SIMPLE)))
  }

  const displayedIdentity = () => resolveDisplayIdentity({
    rid: data.rid,
    businessId,
    templateBusinessId,
  })
  const nameEl = h('div', { class: 'crev-tt-nm' }, name || displayedIdentity().primary || '(unnamed)')
  const actionBar = h('div', { class: 'crev-tt-actions' }, ...headActions)
  const body = h('div', { class: 'crev-tt-body' })
  const band = h('div', { class: 'crev-tt-band' },
      h('div', { class: 'crev-tt-hd' },
        nameEl,
        data.unread && !data.type
          ? h('div', { class: 'crev-tt-ty crev-tt-unread' }, unreadValue(data.unread, actions.onRetryRead))
          : h('div', { class: 'crev-tt-ty' },
            h('span', { class: 'crev-tt-tydot' }),
            typeName,
          ),
      ),
      actionBar,
    )
  const card = h('div', { class: 'crev-tt-card' },
    band,
    body,
  )
  card.style.setProperty('--tt-color', data.color)
  /** In the page the card is reached from its badge with Enter / ArrowDown
   *  and walked with the arrow keys (content-tooltip.ts), so its buttons are
   *  not tab stops of their own. */
  const roving = (): void => {
    if (!data.showCopyLegend) return
    for (const b of card.querySelectorAll<HTMLButtonElement>('.crev-tt-cprow, .crev-tt-open:not(.crev-tt-edit-save):not(.crev-tt-edit-discard)')) b.tabIndex = -1
  }

  const renderReadMode = (): void => {
    card.classList.remove('crev-tt-card--editing')
    delete card.dataset.unsaved
    const display = displayedIdentity()
    nameEl.textContent = name || display.primary || '(unnamed)'
    actionBar.replaceChildren(...headActions)
    body.replaceChildren(...identityRows({ rid: data.rid, businessId, templateBusinessId, type: data.type }, actions.onCopy))
    if (data.showCopyLegend) body.append(legend(!!distinctInstanceId({ rid: data.rid ?? '', businessId, templateBusinessId })))
    roving()
    if (card.isConnected) fitCardLegend(card)
  }

  const renderEditMode = (): void => {
    if (!actions.onSaveIdentity) return
    card.classList.add('crev-tt-card--editing')

    const idInput = h('input', {
      class: 'crev-tt-edit-input crev-tt-edit-id',
      name: 'businessId',
      value: businessId,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': templateBusinessId ? 'Instance ID' : 'Object ID',
    }) as HTMLInputElement
    const nameInput = h('input', {
      class: 'crev-tt-edit-input crev-tt-edit-name',
      name: 'name',
      value: name,
      autocomplete: 'off',
      'aria-label': 'Object name',
    }) as HTMLInputElement
    const templateInput = templateBusinessId
      ? h('input', {
          class: 'crev-tt-edit-input crev-tt-edit-id',
          name: 'templateBusinessId',
          value: templateBusinessId,
          autocomplete: 'off',
          spellcheck: 'false',
          'aria-label': 'Template ID',
        }) as HTMLInputElement
      : null
    const focusIdentityField = (field: IdentityField | undefined): void => {
      const inputByField: Record<IdentityField, HTMLInputElement | null> = {
        businessId: idInput,
        name: nameInput,
        templateBusinessId: templateInput,
      }
      if (field) inputByField[field]?.focus()
    }
    const status = h('div', {
      class: 'crev-tt-edit-status',
      role: 'status',
      'aria-live': 'polite',
    })
    const saveButton = h('button', {
      class: 'crev-tt-open crev-tt-edit-save',
      type: 'button',
      title: 'Save and verify',
      'aria-label': 'Save and verify',
      onClick: (event: Event) => {
        event.preventDefault()
        event.stopPropagation()
        // A save writes to BMP: only a real click, never one dispatched by page script.
        if (!isUserAction(event)) return
        void submitIdentity()
      },
    }, svg(ICON_CHECK)) as HTMLButtonElement
    const discardButton = h('button', {
      class: 'crev-tt-open crev-tt-edit-discard',
      type: 'button',
      title: 'Discard changes',
      'aria-label': 'Discard changes',
      onClick: (event: Event) => {
        event.stopPropagation()
        renderReadMode()
      },
    }, svg(ICON_X)) as HTMLButtonElement

    const setError = (message: string): void => {
      status.className = 'crev-tt-edit-status crev-tt-edit-status--error'
      status.textContent = message
    }
    const submitIdentity = async (): Promise<void> => {
      const validation = normalizeAndValidateIdentity({
        businessId: idInput.value,
        name: nameInput.value,
        ...(templateInput ? { templateBusinessId: templateInput.value } : {}),
      })
      if (!validation.ok) {
        setError(validation.error)
        focusIdentityField(validation.field)
        return
      }
      const {
        businessId: nextId,
        name: nextName,
        templateBusinessId: nextTemplateId,
      } = validation.value
      if (nextId === businessId && nextName === name && nextTemplateId === templateBusinessId) {
        renderReadMode()
        return
      }

      // Send only what was edited, with the value it was opened with: a rename
      // made elsewhere is not reverted by an ID edit (and the reverse).
      const patch: IdentityPatch = {}
      const expect: IdentityPatch = {}
      if (nextId !== businessId) { patch.businessId = nextId; expect.businessId = businessId ?? '' }
      if (nextName !== name) { patch.name = nextName; expect.name = name ?? '' }
      if (nextTemplateId !== undefined && nextTemplateId !== templateBusinessId) {
        patch.templateBusinessId = nextTemplateId
        expect.templateBusinessId = templateBusinessId ?? ''
      }

      idInput.disabled = true
      nameInput.disabled = true
      if (templateInput) templateInput.disabled = true
      saveButton.disabled = true
      discardButton.disabled = true
      status.className = 'crev-tt-edit-status crev-tt-edit-status--saving'
      status.textContent = 'Saving and verifying\u2026'

      try {
        const result = await actions.onSaveIdentity!(patch, expect)
        if (!result.ok && result.conflict?.length) {
          // Review: the card now compares with the BMP values; the typed values
          // stay. Saving again overwrites knowingly, Escape cancels.
          for (const c of result.conflict) {
            if (c.prop === 'businessId') businessId = c.current
            else if (c.prop === 'name') name = c.current
            else if (c.prop === 'templateBusinessId') templateBusinessId = c.current
          }
          idInput.disabled = false
          nameInput.disabled = false
          if (templateInput) templateInput.disabled = false
          saveButton.disabled = false
          discardButton.disabled = false
          const now = result.conflict
            .map(c => `${c.prop === 'businessId' ? 'ID' : c.prop === 'name' ? 'Name' : 'Template ID'} is now "${c.current}"`)
            .join(', ')
          setError(`Changed in BMP since you opened it: ${now}. Save again to overwrite it, or press Escape to cancel.`)
          return
        }
        if (!result.ok) {
          idInput.disabled = false
          nameInput.disabled = false
          if (templateInput) templateInput.disabled = false
          saveButton.disabled = false
          discardButton.disabled = false
          setError(result.error ?? 'Could not verify the saved values.')
          focusIdentityField(result.field)
          return
        }

        businessId = result.businessId ?? nextId
        name = result.name ?? nextName
        templateBusinessId = result.templateBusinessId ?? nextTemplateId ?? templateBusinessId
        status.className = 'crev-tt-edit-status crev-tt-edit-status--success'
        status.replaceChildren(svg(ICON_CHECK), 'Saved and verified')
        setTimeout(renderReadMode, 700)
      } catch {
        idInput.disabled = false
        nameInput.disabled = false
        if (templateInput) templateInput.disabled = false
        saveButton.disabled = false
        discardButton.disabled = false
        setError('Could not save and verify the changes.')
      }
    }
    // Unsaved name or ID: the card is not closed by a click outside, and Escape asks once
    // (a second Escape discards). Nothing typed: Escape leaves at once.
    const changed = (): boolean => idInput.value !== (businessId ?? '') || nameInput.value !== (name ?? '')
      || (!!templateInput && templateInput.value !== (templateBusinessId ?? ''))
    const markUnsaved = (): void => {
      if (changed()) card.dataset.unsaved = 'true'
      else delete card.dataset.unsaved
    }
    let escapeArmed = false
    const askKeep = (): void => {
      escapeArmed = true
      status.className = 'crev-tt-edit-status crev-tt-edit-status--warn'
      status.textContent = 'Unsaved name or ID. Press Enter to save, or Escape again to discard.'
    }
    card.addEventListener('crev-card-keep', askKeep)
    const handleEditKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (changed() && !escapeArmed) { askKeep(); return }
        renderReadMode()
        return
      }
      escapeArmed = false
      if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (!isUserAction(event)) return
        void submitIdentity()
      }
    }
    idInput.addEventListener('keydown', handleEditKey)
    nameInput.addEventListener('keydown', handleEditKey)
    templateInput?.addEventListener('keydown', handleEditKey)
    for (const input of [idInput, nameInput, templateInput]) input?.addEventListener('input', markUnsaved)

    actionBar.replaceChildren(saveButton, discardButton)
    nameEl.replaceChildren(nameInput)
    body.replaceChildren(
      ...[
        templateInput
          ? h('div', { class: 'crev-tt-cprow crev-tt-edit-idrow' },
              h('span', { class: 'crev-tt-k' }, 'Template ID'),
              templateInput,
            )
          : null,
      ].filter((row): row is HTMLElement => row !== null),
      h('div', { class: 'crev-tt-cprow crev-tt-edit-idrow' },
        h('span', { class: 'crev-tt-k' }, templateInput ? 'Instance ID' : 'ID'),
        idInput,
      ),
      ...[
        copyRow('rid', 'RID', data.rid, actions.onCopy),
      ].filter((row): row is HTMLElement => row !== null),
      status,
    )
    nameInput.focus()
    nameInput.select()
  }

  headActions[0]?.classList.contains('crev-tt-edit-open')
    && headActions[0].addEventListener('click', (event) => {
      event.stopPropagation()
      if (!isUserAction(event)) return
      renderEditMode()
    })

  renderReadMode()

  if (data.codePreview) {
    const code = h('pre', { class: 'crev-tt-code' }, data.codePreview)
    card.appendChild(code)
  }
  return card
}
