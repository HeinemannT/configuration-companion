import { expect, test } from 'vitest';
import { analyzePBAC } from './pbac-document.js';
import { policyDiagnostics } from './pbac-validation.js';
import { isPBACAction, isPBACEffect, isPBACGrouping, classifyPBACRight } from './pbac-syntax.js';
import { expressionKind } from './builder-model.js';

const policy = Resource => ({ Version: '1.0', Statement: [{ Subject: '*', Effect: 'Allow', Action: ['Read'], Resource }] });
const condition = (Left, Right, Comparison = '=') => ({ Condition: { Left, Comparison, Right } });
test('native expression activation ignores null siblings without discarding them in Rules', () => {
  const resource = { ...condition('resource.name', 'Title'), All: null, Any: null };
  expect(policyDiagnostics(policy(resource))).toEqual([]);
  expect(expressionKind(resource)).toBe('Condition');
  expect(policyDiagnostics(policy({ All: null, Any: null }))[0].message).toMatch(/exactly one/);
  expect(policyDiagnostics(policy({ ...resource, All: [] }))[0].message).toMatch(/exactly one/);
});

test('optional reference-check fields accept omission but reject explicit null', () => {
  for (const kind of ['HasRole', 'HasAccessTo']) {
    const value = { Reference: 'resource.parent' };
    expect(policyDiagnostics(policy({ [kind]: value }))).toEqual([]);
    expect(policyDiagnostics(policy({ [kind]: { ...value, Roles: [] } }))).toEqual([]);
    for (const field of kind === 'HasRole' ? ['Roles'] : ['Roles', 'Action', 'Grouping']) {
      const issues = policyDiagnostics(policy({ [kind]: { ...value, [field]: null } }));
      expect(issues).toHaveLength(1);
      expect(issues[0].segments).toEqual(['Statement', 0, 'Resource', kind, field]);
    }
  }
});

test('native enums ignore casing, not whitespace or trailing newlines', () => {
  for (const [validate, value] of [[isPBACAction, 'read'], [isPBACEffect, 'deny'], [isPBACGrouping, 'any']]) {
    expect(validate(value)).toBe(true);
    expect(validate(value.toUpperCase())).toBe(true);
    for (const bad of [value + '\n', ' ' + value, value + ' ', null, 1]) expect(validate(bad)).toBe(false);
  }
});

test('Right validation follows native dispatch precedence, including unary comparisons', () => {
  const invalid = [
    ['resource.type', 42], ['resource.type', undefined], ['resource.type', null], ['new.type', ['Organisation', 1]],
    ['resource', 'untyped'], ['resource', ['Organisation:valid', 'untyped']], ['resource', null],
    ['resource.model', false], ['resource.model', ['Model', null]], ['resource.name', 'Organisation:'],
  ];
  for (const [left, right] of invalid) for (const op of ['=', 'Empty', 'NotEmpty']) {
    const issues = policyDiagnostics(policy(condition(left, right, op)));
    expect(issues).toHaveLength(1);
    expect(issues[0].segments.at(-1)).toBe('Right');
  }
  const valid = [
    ['resource.name', null], ['resource.name', undefined], ['resource.name', { x: 1 }],
    ['resource', []], ['resource.type', []], ['new.type', ['Organisation']], ['resource.model', 'Default'],
    ['resource.type', 'user'], ['resource.type', 'Organisation:root'], ['resource.model', 'Organisation:root'],
    ['resource.name', ['Organisation:root', 'literal']],
  ];
  for (const [left, right] of valid) expect(policyDiagnostics(policy(condition(left, right)))).toEqual([]);
  expect(classifyPBACRight('resource.type', 'user').kind).toBe('user');
  expect(classifyPBACRight('resource.type', 'Organisation:root').kind).toBe('objects');
  expect(classifyPBACRight('resource.name', ['Organisation:root', 'literal']).kind).toBe('literal');
});

test('diagnostics locate decoded keys and repeated nested fields without text searches', () => {
  let text = JSON.stringify(policy({ All: [condition('resource.name', 'a'), condition('resource.name', 'b', '>=')] }), null, 2);
  text = text.replaceAll('"Comparison"', '"Comp\\u0061rison"');
  const result = analyzePBAC(text);
  expect(result.issues).toHaveLength(1);
  const issue = result.issues[0];
  expect(text.slice(issue.from, issue.to)).toBe('">="');
  expect(issue.from).toBe(text.indexOf('">="'));
  expect(issue.segments).toEqual(['Statement', 0, 'Resource', 'All', 1, 'Condition', 'Comparison']);
  expect(result.valid).toBe(false);
});

test('missing fields mark their nearest existing container', () => {
  const doc = policy({ All: [condition('resource.name', 'ok'), { Condition: { Left: 'resource.type' } }] });
  const text = JSON.stringify(doc, null, 2), { issues } = analyzePBAC(text);
  expect(issues).toHaveLength(2);
  for (const issue of issues) {
    expect(text.slice(issue.from, issue.to)).toBe('{');
    expect(issue.from).toBe(text.lastIndexOf('{'));
  }
});

test('empty and malformed documents remain diagnosable and all highlight spans are ordered', () => {
  for (const text of ['', ' ', '{', '{"a":', '{"a":"bad\\q"}', '{"a": tru}', 'false true', 'null']) {
    const result = analyzePBAC(text);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    let end = 0;
    for (const span of result.spans) {
      expect(span.from).toBeGreaterThanOrEqual(end);
      expect(span.to).toBeLessThanOrEqual(text.length);
      end = span.to;
    }
  }
});
