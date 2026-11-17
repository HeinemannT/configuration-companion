// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { valueChips, valueId, knownValues, resolveTyped, conditionChipsHtml, suggestionRows } from './value-chips';

const render = (html: string) => { const div = document.createElement('div'); div.innerHTML = html; return div; };
const items = [{ token: 'ListPropertySetItem:scope_global', name: 'Central', id: 'scope_global' }, { token: 'ListPropertySetItem:scope_local', name: 'scope_local', id: 'scope_local' }];

it('drops the class prefix and keeps the stored token', () => {
  expect(valueId('ListPropertySetItem:type_risk')).toBe('type_risk');
  expect(valueId('role:risk_review')).toBe('role:risk_review');
  expect(valueId(3)).toBe('3');
  const chips = valueChips(['ListPropertySetItem:scope_global', 'ListPropertySetItem:scope_local', 'ListPropertySetItem:gone'], { items, complete: true });
  expect(chips.map(c => [c.name, c.id, c.missing, c.token])).toEqual([
    ['Central', 'scope_global', false, 'ListPropertySetItem:scope_global'], ['scope_local', 'scope_local', false, 'ListPropertySetItem:scope_local'], ['gone', 'gone', true, 'ListPropertySetItem:gone']]);
  // A partly loaded list cannot say a value is missing.
  expect(valueChips(['ListPropertySetItem:gone'], { items, complete: false })[0].missing).toBe(false);
});

it('finds values known on the server for a property and restores their prefix when typed bare', () => {
  const saved = [{ content: { Statement: [{ Resource: { All: [{ Condition: { Left: 'resource.Type', Right: ['ListPropertySetItem:type_process'] } }, { Condition: { Left: 'resource.other', Right: 'x' } }] } }] } }];
  const known = knownValues(saved, 'resource.Type');
  expect([...known]).toEqual(['ListPropertySetItem:type_process']);
  expect(resolveTyped(' type_process ', known)).toEqual({ value: 'ListPropertySetItem:type_process', known: true });
  expect(resolveTyped('type_pro', known)).toEqual({ value: 'type_pro', known: false });
});

it('renders names with the ID secondary, a picker for list properties and a text box with suggestions otherwise', () => {
  const list = render(conditionChipsHtml({ values: ['ListPropertySetItem:scope_global'], left: 'resource.scope', list: { items }, saved: [], attrs: 'data-path=\'["All",1]\'', path: '[&quot;All&quot;,1]', fieldName: 'Scope' }));
  expect(list.querySelector('.chip.val')!.textContent).toBe('Centralscope_global');
  expect(list.querySelector('[data-command="schema-value"]')!.textContent).toBe('Add value…');
  expect(list.querySelector('input')).toBeNull();
  const saved = [{ content: { Statement: [{ Resource: { Condition: { Left: 'resource.Type', Right: ['ListPropertySetItem:type_process'] } } }] } }];
  const text = render(conditionChipsHtml({ values: ['ListPropertySetItem:type_process', 'type_new'], left: 'resource.Type', saved, attrs: 'data-path=\'[]\'', path: '[]', fieldName: 'Type' }));
  expect([...text.querySelectorAll('.chip.val')].map(c => [c.querySelector('.nm')!.textContent, c.classList.contains('missing'), c.querySelector('.vmiss')?.textContent])).toEqual([
    ['type_process', false, undefined], ['type_new', false, undefined]]);
  // Every known value is chosen already: nothing to suggest, so no list and no button.
  expect(text.querySelector('input.value-add')!.hasAttribute('list')).toBe(false);
  expect(text.querySelector('[data-command="value-suggest"]')).toBeNull();
  const open = render(conditionChipsHtml({ values: ['type_new'], left: 'resource.Type', saved, attrs: 'data-path=\'["All",0]\'', path: '[&quot;All&quot;,0]', fieldName: 'Type' }));
  const input = open.querySelector('input.value-add')!;
  expect([...open.querySelectorAll(`#${input.getAttribute('list')} option`)].map(o => o.getAttribute('value'))).toEqual(['type_process']);
  // The button beside the box carries the condition path its command reads.
  expect(open.querySelector<HTMLElement>('[data-command="value-suggest"]')!.dataset.path).toBe('["All",0]');
  // With nothing known for the property, nothing is marked missing.
  expect(render(conditionChipsHtml({ values: ['a'], left: 'resource.name', saved: [], attrs: '', path: '[]', fieldName: 'Name' })).querySelector('.missing')).toBeNull();
});

it('offers the known values not chosen yet, by ID and in order, and adds the stored token', () => {
  const known = new Set(['ListPropertySetItem:type_risk', 'type_b', 'ListPropertySetItem:type_a10', 'ListPropertySetItem:type_a9', 3]);
  expect(suggestionRows(['ListPropertySetItem:type_risk'], known).map(r => [r.label, r.rid, r.secondary])).toEqual([
    ['type_a9', 'ListPropertySetItem:type_a9', 'ListPropertySetItem:type_a9'], ['type_a10', 'ListPropertySetItem:type_a10', 'ListPropertySetItem:type_a10'], ['type_b', 'type_b', '']]);
});

const chipsOf = (input: Partial<Parameters<typeof conditionChipsHtml>[0]>) => [...render(conditionChipsHtml({ values: [], left: 'resource.scope', saved: [], attrs: '', path: '[]', fieldName: 'F', ...input }))
  .querySelectorAll('.chip.val')].map(c => [c.querySelector('.nm')!.textContent, c.querySelector('.vmiss')?.textContent ?? null]);

it('marks a value only when the complete list of the property does not hold it', () => {
  expect(chipsOf({ values: ['ListPropertySetItem:scope_global', 'ListPropertySetItem:gone'], list: { items } })).toEqual([['Central', null], ['gone', 'not found on this server']]);
});

it('marks nothing while the list is unknown, empty or still loading, and re-evaluates when it arrives', () => {
  const values = ['ListPropertySetItem:scope_global', 'ListPropertySetItem:gone'];
  expect(chipsOf({ values, list: { items: [], partial: true } })).toEqual([['scope_global', null], ['gone', null]]);
  expect(chipsOf({ values, list: { partial: true } })).toEqual([['scope_global', null], ['gone', null]]);
  expect(chipsOf({ values, list: { items: items.slice(0, 1), partial: true } })).toEqual([['Central', null], ['gone', null]]);
  // The same values once the full list has loaded (the editor renders the chips again).
  expect(chipsOf({ values, list: { items } })).toEqual([['Central', null], ['gone', 'not found on this server']]);
  // A free-text property: values saved elsewhere are not a list of valid values.
  const saved = [{ content: { Condition: { Left: 'resource.name', Right: ['a'] } } }];
  expect(chipsOf({ values: ['a', 'b'], left: 'resource.name', saved })).toEqual([['a', null], ['b', null]]);
});

it('never marks class names in a type condition: the type catalogue is not every class the server accepts', () => {
  // Policy "Forms and Surveys Management": platform classes outside root.classConfig's children.
  const values = ['ReportFormEnrollment', 'AnsweredReportFormEnrollment', 'Enrollment', 'ReportForms', 'TaskFormEnrollment', 'ReportFormMappingConfig', 'CeRiskAssessment'];
  expect(chipsOf({ values, left: 'new.type', types: ['CeRiskAssessment', 'CeIssue', 'Organisation'] })).toEqual(values.map(v => [v, null]));
  // Also while the catalogue is empty (not loaded).
  expect(chipsOf({ values, left: 'resource.type', types: [] })).toEqual(values.map(v => [v, null]));
});

it('compares exact stored tokens, as the server does: a case or prefix variant is not a list item', () => {
  // Type values are exact simple class names; with no complete type list no variant is marked.
  expect(chipsOf({ values: ['ceriskassessment', 'com.corporater.CeRiskAssessment'], left: 'new.type', types: ['CeRiskAssessment'] }).map(([, n]) => n)).toEqual([null, null]);
  // List values are the stored token, prefix included and case-sensitive.
  expect(chipsOf({ values: ['ListPropertySetItem:scope_global', 'ListPropertySetItem:SCOPE_GLOBAL', 'scope_global'], list: { items } }))
    .toEqual([['Central', null], ['SCOPE_GLOBAL', 'not found on this server'], ['scope_global', 'not found on this server']]);
});
