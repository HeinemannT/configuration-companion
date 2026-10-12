import { createFieldValue, readCreateValues } from './create-test-model.js';
import { fieldKind } from './schema-model.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderCreateTest(check, { properties, suggested, objectLabel, loaded, icon }) {
  let values, error = '';
  try { values = readCreateValues(check.proposed); } catch (e) { error = e.message; }
  const json = check.createView === 'json' || !!error;
  const field = (name, prop) => {
    const entry = createFieldValue(values, name), attr = `data-field="${esc(name)}"`, numberDraft = check.createNumberDrafts?.[name],
      kind = numberDraft !== undefined || typeof entry.value === 'number' ? 'Number' : typeof entry.value === 'boolean' ? 'Boolean' : fieldKind(prop), reference = prop?.reference || entry.kind === 'references',
      literal = entry.supplied && (entry.value === null || typeof entry.value === 'object' && !reference),
      label = prop?.label || name;
    let control;
    if (reference) {
      const ids = entry.supplied ? [entry.value].flat().filter(Boolean) : [];
      const labels = ids.map(rid => prop?.listSet?.items.find(item => item.rid === rid)?.name || objectLabel(rid));
      control = `<button type="button" class="object-picker" data-command="create-reference" ${attr} aria-label="Choose ${esc(label)}" title="${esc(labels.join(', '))}">${icon(prop?.listSet ? 'list' : 'object')}<span><strong>${esc(entry.value === null ? 'null' : entry.supplied && !ids.length ? 'Empty list' : labels.join(', ') || 'Not supplied')}</strong></span>${icon('search')}</button>`;
    } else if (literal || !prop && numberDraft === undefined || !['Number', 'Boolean', 'Text', 'System', 'Property'].includes(kind)) {
      control = `<button type="button" class="object-picker" data-command="create-literal" ${attr} aria-label="Edit ${esc(label)} as JSON"><span><strong>${esc(entry.supplied ? JSON.stringify(entry.value) : 'Not supplied')}</strong></span>${icon('json')}</button>`;
    } else if (kind === 'Boolean') {
      control = `<button type="button" class="object-picker" data-command="create-boolean" ${attr} aria-label="${esc(label)}: ${entry.supplied ? esc(entry.value) : 'Not supplied'}"><span><strong>${entry.supplied ? esc(entry.value) : 'Not supplied'}</strong></span>${icon('down')}</button>`;
    } else {
      control = `<input id="create-input-${esc(name)}" data-create-value="${esc(name)}" data-value-kind="${kind === 'Number' ? 'number' : 'text'}" type="text" ${kind === 'Number' ? 'inputmode="decimal"' : ''} value="${esc(numberDraft ?? entry.value ?? '')}" placeholder="Not supplied" aria-label="${esc(label)}" aria-invalid="${numberDraft !== undefined}" aria-describedby="create-error-${esc(name)}" spellcheck="false"><span id="create-error-${esc(name)}" class="field-error" ${numberDraft === undefined ? 'hidden' : ''}>Enter a number, for example 12.5, or omit this field.</span>`;
    }
    control = control.replace(/^<button/, `<button id="create-input-${esc(name)}"`);
    const supplied = entry.supplied || numberDraft !== undefined;
    return `<div class="create-value-row" data-create-row="${esc(name)}"><label for="create-input-${esc(name)}">${esc(label)}${label !== name ? `<code title="new.${esc(name)}">${esc(name)}</code>` : ''}</label><div class="create-value-control">${control}</div><button type="button" class="icon-button" data-command="create-omit" ${attr} ${!supplied && !check.omittedValues?.[name] ? 'disabled' : ''} title="${supplied ? 'Omit ' : 'Restore '}${esc(label)}" aria-label="${supplied ? 'Omit ' : 'Restore '}${esc(label)}">${icon(supplied ? 'close' : 'undo')}</button><button type="button" class="icon-button" data-command="create-field-menu" ${attr} title="${esc(label)} options" aria-label="${esc(label)} options">${icon('more')}</button></div>`;
  };
  const fields = values ? [...new Set([...suggested, ...(check.createFields ?? []), ...Object.keys(check.createNumberDrafts ?? {}), ...Object.keys(values.properties ?? {}), ...Object.keys(values.references ?? {})])] : [];
  return `<div class="create-values"><div class="create-values-heading"><strong>Initial values</strong><span class="spacer"></span><button type="button" class="quiet-button" data-command="create-add-field" ${!values?.type || json ? 'disabled' : ''}>${icon('plus')}Field</button><div class="choice-segment" role="group" aria-label="Create request editor"><button type="button" data-command="create-view" data-create-view="fields" aria-pressed="${!json}">Fields</button><button type="button" data-command="create-view" data-create-view="json" aria-pressed="${json}">JSON</button></div></div>${json ? `<textarea data-check="proposed" aria-label="Create request JSON" rows="5" spellcheck="false">${esc(check.proposed)}</textarea>${error ? `<p class="field-error">${esc(error)}</p>` : ''}` : `<div class="create-values-list">${fields.map(name => field(name, properties.find(p => p.accessor === name))).join('')}</div>${!fields.length ? '<p class="test-change-hint">Add only the fields you want to submit.</p>' : ''}${values?.type && !loaded ? '<p class="test-change-hint" role="status">Loading field metadata…</p>' : ''}`}</div>`;
}
