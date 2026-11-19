/**
 * One setting of a form element as a labelled control (lib/layout/flow-settings.ts). Used by the
 * editor of the selected element; every change is staged like any other Blueprint edit.
 */
import type { FlowSetting } from '../lib/layout/flow-settings';
import { changeFlowSetting } from './actions';

/** One setting as a labelled control. The hover names the property as Extended Code does. */
export function settingControl(setting: FlowSetting, value: string | boolean): HTMLElement {
  const row = document.createElement('label');
  row.className = `bp-set-row kind-${setting.kind}`;
  const name = document.createElement('span'); name.className = 'bp-set-l'; name.textContent = setting.label;
  row.title = setting.hint ? `${setting.prop}. ${setting.hint}` : setting.prop;
  if (setting.kind === 'toggle') {
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = value === true;
    box.addEventListener('change', () => changeFlowSetting(setting.prop, box.checked));
    row.append(box, name);
  } else {
    const field = document.createElement('input'); field.type = 'text'; field.className = 'bp-set-t'; field.value = String(value ?? '');
    field.spellcheck = false; field.dataset.prop = setting.prop;
    // Staged when the field is left or Enter is pressed, not on every key.
    field.addEventListener('change', () => changeFlowSetting(setting.prop, field.value));
    field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); field.blur(); } });
    field.setAttribute('value', field.value);
    row.append(name, field);
  }
  return row;
}
