/**
 * Settings of a form element that Blueprint sets where the element is: the few a configurator
 * needs when building a form (is the field required, what is the input's key, what does the
 * button say). Everything else stays with the object window.
 *
 * One table per class. The property names come only from this table, so they are safe to put
 * into Extended Code; values are text or a yes/no.
 *
 * Pure: no DOM, no chrome.*.
 */

import { ecString as ecStr, validateRid } from '../ec-guards';
import { FLOW_LIST_MARKER, markerLines, safeWireTextEc } from '../layout-wire';
import { varyingScript } from '../script-kinds';

export type FlowSettingValue = string | boolean;
export type FlowSettingValues = Record<string, FlowSettingValue>;

export interface FlowSetting {
  /** The BMP property, as Extended Code and the object window name it. */
  prop: string;
  /** BMP's own name for the property in words; no wording of our own. */
  label: string;
  kind: 'toggle' | 'text';
  /** One line under the control: what the setting does. */
  hint?: string;
}

const KEY: FlowSetting = { prop: 'key', label: 'Key', kind: 'text', hint: 'The name code uses to read this input.' };
const ALLOW_BLANK: FlowSetting = { prop: 'allowBlank', label: 'Allow blank', kind: 'toggle' };

/** The settings Blueprint offers, by class. A class that is not listed has none here. */
export const FLOW_SETTINGS: Readonly<Record<string, readonly FlowSetting[]>> = {
  EditField: [
    { prop: 'required', label: 'Required', kind: 'toggle', hint: 'The form cannot be saved while this field is empty.' },
    { prop: 'placeholder', label: 'Placeholder', kind: 'text', hint: 'Shown in the empty field.' },
  ],
  EditPageButton: [{ prop: 'buttonText', label: 'Button text', kind: 'text' }],
  EditPageInfo: [{ prop: 'label', label: 'Label', kind: 'text' }],
  TextInput: [KEY],
  NumberInput: [KEY],
  DateInput: [KEY],
  ListInput: [KEY, ALLOW_BLANK],
  ReferenceInput: [KEY, ALLOW_BLANK, { prop: 'multiselect', label: 'Multiselect', kind: 'toggle' }],
  ButtonInput: [
    { prop: 'successMessage', label: 'Success message', kind: 'text' },
    { prop: 'failureMessage', label: 'Failure message', kind: 'text' },
  ],
};

export const flowSettingsFor = (className: string): readonly FlowSetting[] => FLOW_SETTINGS[className] ?? [];

/** The value a setting has when nothing is stored: off, or no text. */
export const emptySetting = (setting: FlowSetting): FlowSettingValue => (setting.kind === 'toggle' ? false : '');

/** `a := x, b := y` for a change() or the tail of an add(): only listed properties, in table order. */
export function settingsAssignments(className: string, values: FlowSettingValues | undefined): string[] {
  if (!values) return [];
  return flowSettingsFor(className).flatMap(setting => {
    if (!Object.hasOwn(values, setting.prop)) return [];
    const value = values[setting.prop];
    return [`${setting.prop} := ${setting.kind === 'toggle' ? (value === true ? 'TRUE' : 'FALSE') : ecStr(String(value))}`];
  });
}

/** The same values in words, for the list of changes and the review. */
export function settingsWords(className: string, values: FlowSettingValues | undefined): string {
  if (!values) return '';
  return flowSettingsFor(className).flatMap(setting => {
    if (!Object.hasOwn(values, setting.prop)) return [];
    const value = values[setting.prop];
    return [`${setting.label}: ${setting.kind === 'toggle' ? (value === true ? 'yes' : 'no') : `"${String(value)}"`}`];
  }).join(', ');
}

/** EC that reads one element's settings: one `prop|value` row per listed setting. */
export function buildFlowSettingsEc(rid: string, className: string): string {
  const rows = flowSettingsFor(className).map(setting => {
    const value = setting.kind === 'toggle'
      ? `str(_o.${setting.prop}.whenMissing(""))`
      : safeWireTextEc(`_o.${setting.prop}.whenMissing("")`);
    return `"${FLOW_LIST_MARKER}${setting.prop}|" + ${value} + "\\n"`;
  });
  return varyingScript('buildFlowSettingsEc', [`_o := lookup(${validateRid(rid)})`, rows.length ? rows.join(' + ') : '""'].join('\n'));
}

/** Parse buildFlowSettingsEc: every listed setting, with its empty value where the row is missing. */
export function parseFlowSettings(log: string, className: string): FlowSettingValues {
  const read = new Map<string, string>();
  for (const line of markerLines(log, FLOW_LIST_MARKER)) {
    const at = line.indexOf('|');
    if (at > 0) read.set(line.slice(0, at), line.slice(at + 1));
  }
  const out: FlowSettingValues = {};
  for (const setting of flowSettingsFor(className)) {
    const raw = read.get(setting.prop);
    out[setting.prop] = setting.kind === 'toggle' ? raw === 'true' : raw ?? '';
  }
  return out;
}
