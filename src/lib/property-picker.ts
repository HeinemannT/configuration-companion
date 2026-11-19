import { h, svg } from './dom';
import { ICON_CARET_DOWN } from './icons';
import { typeBadge } from './type-badge';

export interface PropertyPickerOption {
  /** Exact EditField.propertyMapping accessor written back to BMP. */
  value: string;
  /** Stable master property ID shown as the primary identity when available. */
  propertyId?: string;
  /** Effective label for the owning object type. */
  label?: string;
  /** Concrete MethodConfig class used by the shared property badge. */
  configClass?: string;
  /** A BMP system property (id, name, parent, ...): listed after the type's own, folded. */
  system?: boolean;
  /** Who already maps this property on the same form; it stays selectable. */
  mappedBy?: string;
}

export interface PropertyPickerOptions {
  value: string;
  options?: readonly PropertyPickerOption[];
  onChange(value: string): void;
  density?: 'standard' | 'compact';
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  allowClear?: boolean;
}

interface OpenPicker {
  root: HTMLElement;
  close(): void;
}

const openPickers = new Set<OpenPicker>();
let outsideListenerInstalled = false;
let pickerId = 0;

function ensureOutsideListener(): void {
  if (outsideListenerInstalled) return;
  outsideListenerInstalled = true;
  document.addEventListener('mousedown', event => {
    const target = event.target;
    for (const picker of [...openPickers]) {
      if (!picker.root.isConnected) {
        openPickers.delete(picker);
      } else if (!(target instanceof Node) || !picker.root.contains(target)) {
        picker.close();
      }
    }
  }, true);
}

const FAMILY_ALIASES = new Map<string, string>([
  ['txt', 'text'],
  ['text', 'text'],
  ['richtext', 'text'],
  ['num', 'number'],
  ['number', 'number'],
  ['date', 'date'],
  ['bool', 'choice'],
  ['choice', 'choice'],
  ['list', 'choice'],
  ['tag', 'choice'],
  ['ref', 'reference'],
  ['reference', 'reference'],
]);

function optionFamily(configClass = ''): string {
  const type = configClass.toLocaleLowerCase();
  if (type.includes('reference')) return 'reference';
  if (type.includes('number') || type.includes('progress')) return 'number';
  if (type.includes('date')) return 'date';
  if (type.includes('boolean') || type.includes('list') || type.includes('tag') || type.includes('status')) {
    return 'choice';
  }
  if (type.includes('text') || type.includes('url')) return 'text';
  return 'other';
}

function displayId(option: PropertyPickerOption): string {
  return option.propertyId?.trim() || option.value;
}

function badgeType(option: PropertyPickerOption): string | undefined {
  const type = option.configClass?.trim();
  if (!type || type === 'Property') return undefined;
  // Backward compatibility for cached schema payloads created before the
  // linked master's MethodConfig class was included explicitly.
  return type.endsWith('PropertyConfig')
    ? `${type.slice(0, -'PropertyConfig'.length)}MethodConfig`
    : type;
}

function searchableText(option: PropertyPickerOption): string {
  return [
    displayId(option),
    option.value,
    option.label,
    option.configClass,
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

/** Shared EditField property combobox used by Blueprint and the object sidebar. */
export function propertyPicker(opts: PropertyPickerOptions): HTMLElement {
  ensureOutsideListener();
  const id = ++pickerId;
  const listId = `crev-property-picker-${id}`;
  const density = opts.density ?? 'standard';
  const supplied = [...(opts.options ?? [])];
  if (opts.value && !supplied.some(option => option.value === opts.value)) {
    supplied.unshift({
      value: opts.value,
      propertyId: opts.value,
      label: `${opts.value} (current)`,
    });
  }

  const clearOption: PropertyPickerOption = { value: '', label: 'No property' };
  const choices = opts.allowClear === false ? supplied : [clearOption, ...supplied];
  let selectedValue = opts.value;
  let query = '';
  let activeIndex = 0;
  let open = false;

  const root = h('div', {
    class: `crev-property-picker crev-property-picker--${density}`,
  });
  const badgeSlot = h('span', { class: 'crev-property-picker__badge' });
  const input = h('input', {
    id: `${listId}-input`,
    class: 'crev-property-picker__input',
    type: 'text',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-controls': listId,
    'aria-expanded': 'false',
    'aria-label': opts.ariaLabel ?? 'Property',
    autocomplete: 'off',
    spellcheck: 'false',
    disabled: opts.disabled,
    placeholder: opts.placeholder ?? 'Select property',
    title: opts.title ?? 'Search by property name or ID',
  }) as HTMLInputElement;
  const toggle = h('button', {
    class: 'crev-property-picker__toggle',
    type: 'button',
    tabindex: '-1',
    'aria-label': 'Show properties',
    disabled: opts.disabled,
  }, svg(ICON_CARET_DOWN)) as HTMLButtonElement;
  const field = h('div', { class: 'crev-property-picker__field' }, badgeSlot, input, toggle);
  const list = h('div', {
    class: 'crev-property-picker__list',
    id: listId,
    role: 'listbox',
    hidden: true,
  });
  root.append(field, list);

  const selectedOption = (): PropertyPickerOption | undefined =>
    choices.find(option => option.value === selectedValue);

  const filtered = (): PropertyPickerOption[] => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const family = terms.map(term => FAMILY_ALIASES.get(term)).find(Boolean);
    const searchTerms = terms.filter(term => !FAMILY_ALIASES.has(term));
    return choices.filter(option => {
      if (family && option.value && optionFamily(option.configClass) !== family) return false;
      const haystack = option.value ? searchableText(option) : 'no property clear empty';
      return searchTerms.every(term => haystack.includes(term));
    });
  };

  const renderBadge = (): void => {
    badgeSlot.textContent = '';
    const selected = selectedOption();
    const type = selected ? badgeType(selected) : undefined;
    if (type) badgeSlot.appendChild(typeBadge(type, { size: 'xs' }));
    else badgeSlot.classList.add('is-empty');
    if (type) badgeSlot.classList.remove('is-empty');
  };

  /** The rows as listed now, in order: what the arrow keys and Enter walk over. */
  let visible: PropertyPickerOption[] = [];
  let rows: HTMLElement[] = [];
  let systemOpen = false;

  const markActive = (): void => {
    rows.forEach((row, index) => row.classList.toggle('is-active', index === activeIndex));
    if (open && rows[activeIndex]) input.setAttribute('aria-activedescendant', rows[activeIndex].id);
    else input.removeAttribute('aria-activedescendant');
  };

  const optionRow = (option: PropertyPickerOption, index: number): HTMLElement => {
    const id = option.value ? displayId(option) : '';
    const name = option.value ? (option.label && option.label !== id ? option.label : id) : 'No property';
    const type = badgeType(option);
    const row = h('div', {
      class: [
        'crev-property-picker__option',
        option.value === selectedValue ? 'is-selected' : '',
        option.value ? '' : 'is-clear',
      ].filter(Boolean).join(' '),
      id: `${listId}-option-${index}`,
      role: 'option',
      'aria-selected': String(option.value === selectedValue),
      'data-value': option.value,
      title: option.value
        ? [option.label, option.propertyId, option.value, option.configClass, option.mappedBy ? `mapped by ${option.mappedBy}` : '']
            .filter(Boolean).join(' · ')
        : 'Clear property mapping',
      },
      option.value
        ? h('span', { class: 'crev-property-picker__option-badge' },
            type ? typeBadge(type, { size: 'xs' }) : null,
          )
        : null,
      h('span', { class: 'crev-property-picker__copy' },
        h('span', { class: 'crev-property-picker__name' }, name),
        option.mappedBy ? h('span', { class: 'crev-property-picker__mapped' }, 'Mapped') : null,
        id && id !== name ? h('span', { class: 'crev-property-picker__id' }, id) : null,
      ),
    );
    row.addEventListener('mousedown', event => {
      event.preventDefault();
      select(option);
    });
    return row;
  };

  // Built once per search text. Moving the pointer or the arrow keys only moves a class.
  const renderList = (): void => {
    const results = filtered();
    const searching = Boolean(query.trim());
    const own = results.filter(option => !option.system);
    const system = results.filter(option => option.system);
    const showSystem = system.length > 0 && (systemOpen || searching || !own.some(option => option.value));
    visible = showSystem ? [...own, ...system] : own;
    activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));
    list.textContent = '';
    const found = results.filter(option => option.value).length;
    list.appendChild(h('div', { class: 'crev-property-picker__count' },
      searching ? `${found} of ${supplied.length}` : `${supplied.length} ${supplied.length === 1 ? 'property' : 'properties'}`));
    rows = [];
    own.forEach(option => { const row = optionRow(option, rows.length); rows.push(row); list.appendChild(row); });
    if (system.length) {
      const head = h('button', {
        class: `crev-property-picker__group${showSystem ? ' is-open' : ''}`,
        type: 'button',
        tabindex: '-1',
        'aria-expanded': String(showSystem),
      }, h('span', {}, 'System properties'), h('span', { class: 'crev-property-picker__group-count' }, String(system.length)));
      head.addEventListener('mousedown', event => {
        event.preventDefault();
        systemOpen = !showSystem;
        renderList();
      });
      list.appendChild(head);
      if (showSystem) system.forEach(option => { const row = optionRow(option, rows.length); rows.push(row); list.appendChild(row); });
    }
    if (!found && !rows.length) list.appendChild(h('div', { class: 'crev-property-picker__empty' }, 'No matching properties'));
    markActive();
  };

  const restoreField = (): void => {
    const selected = selectedOption();
    input.value = selected ? displayId(selected) : selectedValue;
    input.placeholder = opts.placeholder ?? 'Select property';
    query = '';
    root.classList.remove('is-searching');
    renderBadge();
  };

  const controller: OpenPicker = {
    root,
    close: () => {
      if (!open) return;
      open = false;
      list.hidden = true;
      root.classList.remove('is-open');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      openPickers.delete(controller);
      restoreField();
    },
  };

  const show = (): void => {
    if (opts.disabled) return;
    open = true;
    list.hidden = false;
    root.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    openPickers.add(controller);
    // Opening turns the value surface into a search field. Keep the selected
    // property's badge visible, but do not select/highlight its ID; that
    // produced a noisy purple text block and made the compact control look
    // broken. Escape/blur restores the selected ID.
    query = '';
    input.value = '';
    input.placeholder = 'Search properties';
    renderList();
    activeIndex = Math.max(0, visible.findIndex(option => option.value === selectedValue));
    markActive();
    rows[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    input.focus();
  };

  const select = (option: PropertyPickerOption): void => {
    selectedValue = option.value;
    controller.close();
    opts.onChange(option.value);
  };

  input.addEventListener('click', () => {
    if (!open) show();
  });
  input.addEventListener('input', () => {
    query = input.value;
    activeIndex = 0;
    root.classList.toggle('is-searching', Boolean(query));
    if (!open) show();
    else renderList();
  });
  input.addEventListener('keydown', event => {
    const results = visible;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = results.length
        ? (activeIndex + offset + results.length) % results.length
        : 0;
      markActive();
      rows[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter' && open && results[activeIndex]) {
      event.preventDefault();
      select(results[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      controller.close();
    } else if (event.key === 'Tab') {
      controller.close();
    }
  });
  toggle.addEventListener('mousedown', event => event.preventDefault());
  toggle.addEventListener('click', () => {
    if (open) controller.close();
    else show();
  });

  restoreField();
  return root;
}
