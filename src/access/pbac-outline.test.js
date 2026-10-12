import { expect, it } from 'vitest';
import { analyzePBAC } from './pbac-document.js';
import { policyOutline } from './pbac-outline.js';

const statement = { Subject: '*', Effect: 'Allow', Action: ['Create'], description: 'Create evidence', Resource: { All: [
  { Condition: { Left: 'new.type', Comparison: '=', Right: 'CeAttachment' } },
  { Any: [{ Condition: { Left: 'new.name', Comparison: 'NotEmpty' } }, { HasRole: { Reference: 'reversed.owner', Roles: ['tax_admin'] } }] },
  { HasAccessTo: 'new.parent' }
] } };
it('builds semantic labels and exact navigation ranges without treating metadata as rules', () => {
  const doc = JSON.stringify({ Version: '1.0', Statement: [statement], comment: { Statement: [statement] } });
  const result = policyOutline(analyzePBAC(doc));
  expect(result.valid).toBe(true);expect(result.nodes).toHaveLength(1);
  const rule = result.nodes[0];expect(rule.label).toBe('Create · CeAttachment');expect(rule.description).toBe('Create evidence');
  expect(JSON.parse(doc.slice(rule.from, rule.to))).toEqual(statement);
  const group = rule.children[1];expect(group.label).toBe('All · 3 conditions');
  const condition = group.children[1].children[0];
  expect(JSON.parse(doc.slice(condition.from, condition.to))).toEqual(statement.Resource.All[1].Any[0].Condition);
  expect(group.children[2].label).toBe('Access · parent');
});
it('never publishes stale locations or throws while JSON and PBAC shapes are incomplete', () => {
  for (const doc of ['{', '{"Statement":[', 'null', '{"Statement":{}}', '{"Statement":[null,{"Resource":{"All":4}}, {"Subject":4,"Resource":{"Condition":{"Left":7,"Right":{}}}}]}']) {
    const result = policyOutline(analyzePBAC(doc));expect(result.nodes).toBeInstanceOf(Array);
    if (!result.valid) expect(result.nodes).toEqual([]);
  }
});
it('keeps statement indexes and distinguishes new from current-object type constraints', () => {
  const doc = JSON.stringify({ Version: '1.0', Statement: [null, { ...statement, Resource: { Condition: { Left: 'resource.type', Comparison: '=', Right: 'CeTask' } } }] });
  const result = policyOutline(analyzePBAC(doc));
  expect(result.nodes[1].path).toEqual(['Statement', 1]);expect(result.nodes[1].label).not.toContain('CeTask');
});

it.each(['Deny','deny','DENY'])('distinguishes %s from an Allow rule for the same action and object type', effect => {
  const doc=JSON.stringify({Version:'1.0',Statement:[statement,{...statement,Effect:effect}]});
  const nodes=policyOutline(analyzePBAC(doc)).nodes;
  expect(nodes[0].label).toBe('Create · CeAttachment');expect(nodes[1].label).toBe('Deny · Create · CeAttachment');
});
