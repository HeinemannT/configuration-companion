// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { statementCardHtml, fieldChangeHtml, scopeTargetHtml, scopeTitle } from './review-card';
import { diffStatements } from './policy-diff.js';

const typeList = (values) => ({ Effect: 'Allow', Subject: '*', Action: ['Read'],
  Resource: { All: [{ Condition: { Left: 'resource.Type', Comparison: 'ContainsAny', Right: values.map(v => 'ListPropertySetItem:' + v) } }] } });
const render = (html) => { const div = document.createElement('div'); div.innerHTML = html; return div; };

it('names the server, policy and statement, then shows only the added value in full', () => {
  const values = ['type_risk', 'type_control', 'type_requirement_coverage_long_identifier'];
  const [change] = diffStatements([typeList(values)], [typeList([...values, 'type_process'])]);
  const card = render(statementCardHtml(change, { policy: { name: 'Record owners', id: 'record_owner_access' }, server: 'DEV QA' }));
  expect(card.querySelector('.rv-target').textContent).toBe('Saves to DEV QA · policy Record owners record_owner_access, statement 1');
  expect(card.querySelector('.rv-diffs').textContent).toBe('Added type_process to “Type contains any”.');
  const rows = [...card.querySelectorAll('.rv-delta')];
  expect(rows).toHaveLength(1);
  // Nothing was removed, so there is no Before side; the After side holds the new value alone.
  expect([...rows[0].querySelectorAll('.bf > span:first-child')].map(s => s.textContent)).toEqual(['After']);
  expect([...rows[0].querySelectorAll('.rv-v')].map(v => [v.className.trim(), v.lastElementChild.textContent])).toEqual([['rv-v ad', 'type_process']]);
  expect(card.textContent).not.toContain('ListPropertySetItem');
});

it('shows a removed value on the Before side with its sign, and escapes values', () => {
  const [change] = diffStatements([typeList(['a', '<b>'])], [typeList(['a'])]);
  const card = render(statementCardHtml(change, { policy: { name: 'P' }, server: 'S' }));
  expect([...card.querySelectorAll('.bf > span:first-child')].map(s => s.textContent)).toEqual(['Before']);
  expect(card.querySelector('.rv-v.rm').textContent).toBe('−removed: <b>');
  expect(card.querySelector('.rv-v.rm b:not(.rv-sign)')).toBeNull();
});

it('renders a field change with names first and RIDs as secondary text', () => {
  const { html, keys } = fieldChangeHtml({ field: 'managers', referenceConfig: '9000000000000000901' }, { field: 'viewers', referenceConfig: '9000000000000000902' }, () => undefined);
  expect(keys).toEqual(['field', 'referenceConfig']);
  const card = render(html);
  expect([...card.querySelectorAll('.rv-v')].map(v => v.textContent)).toEqual(['managersRID 9000000000000000901', 'viewersRID 9000000000000000902']);
  expect(fieldChangeHtml({ field: 'a' }, { field: 'a' }, () => undefined)).toEqual({ html: '', keys: [] });
});

it('says where a field assignment or delegation saves to and titles a field assignment in plain words', () => {
  const card = render(scopeTargetHtml({ kind: 'RoleAssignment', field: 'managers', source: 'Organisation' }, { roleName: 'Org <manager>', server: 'DEV QA' }));
  expect(card.querySelector('.rv-target').textContent).toBe('Saves to DEV QA · field assignment of role Org <manager>');
  expect(card.querySelector('.rv-target b:not(:first-child)').innerHTML).toBe('Org &lt;manager&gt;');
  expect(render(scopeTargetHtml({ kind: 'InwardsReferenceRoleDelegationRule' }, { roleName: 'R', server: 'S' })).textContent).toBe('Saves to S · delegation of role R');
  expect(scopeTitle({ kind: 'RoleAssignment', field: 'Organisation.managers', source: 'Organisation', name: 'Organizational Manager in Orgs' }, 'Organization Manager'))
    .toBe('Organization Manager · field managers of Organisation');
  expect(scopeTitle({ kind: 'RoleAssignment', field: '', source: 'Organisation' }, 'R')).toBe('R · no field chosen');
  expect(scopeTitle({ kind: 'InwardsReferenceRoleDelegationRule', name: 'Related controls' }, 'R')).toBe('Related controls');
});
