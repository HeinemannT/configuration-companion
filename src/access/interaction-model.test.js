import {
  test
} from 'vitest';
import assert from 'node:assert/strict';
import { PBAC_COMPARISONS } from './pbac-syntax.js';
import {
  ancestry,
  moveProblem,
  renameRoleReferences,
  referencedRoleIds,
  policyMatches,
  policyDiagnostics,
  objectMatches
} from './interaction-model.js';
const roles = [{
  rid: '90071992547409931',
  id: 'manager',
  name: 'Manager',
  parent: ''
}, {
  rid: '90071992547409932',
  id: 'regional',
  name: 'Regional owner',
  parent: '90071992547409931'
}, {
  rid: '90071992547409933',
  id: 'local',
  name: 'Local owner',
  parent: '90071992547409932'
}];
test('parenting rejects cycles, self and missing targets while permitting root moves', () => {
  assert.match(moveProblem(roles, roles[0].rid, roles[2].rid), /ancestor/);
  assert.match(moveProblem(roles, roles[1].rid, roles[1].rid), /own parent/);
  assert.match(moveProblem(roles, roles[1].rid, 'missing'), /available/);
  assert.equal(moveProblem(roles, roles[2].rid, ''), '');
  assert.deepEqual(ancestry(roles, roles[2].rid).map(r => r.id), ['manager', 'regional', 'local']);
});
test('role ID rename updates exact subject and nested role tokens, preserves unrelated strings and source', () => {
  const source = {
    Statement: [{
      Subject: ['role:regional', 'role:regional_other'],
      Resource: {
        Any: [{
          HasRole: {
            Roles: ['regional', 'manager'],
            Reference: 'resource.owner'
          }
        }]
      },
      _comment: 'regional'
    }]
  };
  const out = renameRoleReferences(source, 'regional', 'area_owner');
  assert.equal(out.count, 2);
  assert.deepEqual(referencedRoleIds(out.content), ['area_owner', 'regional_other', 'manager']);
  assert.equal(out.content.Statement[0]._comment, 'regional');
  assert.equal(source.Statement[0].Subject[0], 'role:regional');
});
test('policy search finds role names and conditions independently of policy names', () => {
  const p = {
    name: 'Read entities',
    id: 'access_read',
    rid: '91',
    content: {
      Statement: [{
        Subject: ['role:regional'],
        Resource: {
          Condition: {
            Left: 'resource.type',
            Right: 'Organisation'
          }
        }
      }]
    }
  };
  assert.equal(policyMatches(p, '"Regional owner" Organisation', roles), true);
  assert.equal(policyMatches(p, 'local', roles), false);
});
test('JSON diagnostics distinguish invalid policy shape from a valid draft with no grant', () => {
  assert.equal(policyDiagnostics({
    Version: '1.0',
    Statement: [{
      Subject: '*',
      Effect: 'Allow',
      Action: [],
      Resource: {
        All: []
      }
    }]
  })[0].severity, 'warning');
  assert.equal(policyDiagnostics({
    Version: '1.0',
    Statement: [{
      Subject: '*',
      Effect: 'Allow',
      Action: ['Execute'],
      Resource: {
        All: []
      }
    }]
  })[0].severity, 'error');
});

const policy = Resource => ({ Version: '1.0', Statement: [{ Subject: '*', Effect: 'Allow', Action: ['Read'], Resource }] });
test('syntax diagnostics accept native comparisons, nested groups and both reference-check forms', () => {
  const source = policy({ All: [
    { Any: [...PBAC_COMPARISONS].map(Comparison => ({ Condition: { Left: 'resource.type', Comparison, Right: 'Organisation' } })) },
    { HasRole: 'resource.parent' }, { HasAccessTo: 'new.owner' },
    { HasRole: { Reference: 'reversed.owner', Roles: ['reviewer'] } },
    { HasAccessTo: { Reference: 'resource.parent', Roles: ['auditor'], Grouping: 'ALL', Action: 'read' } }
  ] });
  source.Statement[0].Subject = ['role:reviewer', 'user:alex'];
  source.Statement[0].Effect = 'allow';
  source.Statement[0].Action = ['READ', 'update'];
  assert.deepEqual(policyDiagnostics(source), []);
});

test('unsupported comparison and expression syntax is reported at its nested field', () => {
  const source = policy({ All: [
    { Condition: { Left: 'resource.score', Comparison: '>=', Right: 75 } },
    { Not: { HasRole: 'resource.owner' } },
    { HasAccessTo: { Reference: 'user.owner', Action: 'Execute', Grouping: 'Some' } }
  ] });
  const issues = policyDiagnostics(source);
  assert.equal(issues.length, 5);
  assert.equal(issues[0].path, 'Statement 1.Resource.All[0].Condition.Comparison');
  assert.match(issues[0].message, />=/);
  assert.match(issues[1].message, /Not is not a PBAC expression/);
  assert.equal(issues[2].path, 'Statement 1.Resource.All[2].HasAccessTo.Reference');
});

test('policy syntax requires a version, a subject selector/list, and an action list', () => {
  for (const subject of ['role:reviewer', ['*'], ['group:team']]) {
    const source = policy({ All: [] }); source.Statement[0].Subject = subject;
    assert.match(policyDiagnostics(source)[0].message, /subjects/);
  }
  const source = policy({ All: [] }); delete source.Version; source.Statement[0].Action = 'Read';
  assert.deepEqual(policyDiagnostics(source).map(issue => issue.message), ['Set Version to "1.0".', 'Use a list of actions: Create, Read, Update, or Delete.']);
});

test('malformed nested expressions remain diagnosable without throwing', () => {
  for (const Resource of [null, [], { All: {} }, { HasRole: null }, { HasAccessTo: 7 }, { Condition: [] }, { All: [], Any: [] }])
    assert.ok(policyDiagnostics(policy(Resource)).some(issue => issue.severity === 'error'));
});

test('object name search does not accidentally combine name terms with RID digits', () => {
  const o = {
    name: 'Legal Entity 07',
    id: 'entity_007',
    rid: '90234567',
    type: 'Organisation',
    path: 'Organization'
  };
  assert.equal(objectMatches(o, 'Legal Entity 02'), false);
  assert.equal(objectMatches(o, 'Legal Entity 07'), true);
  assert.equal(objectMatches(o, 'Organisation Legal'), true);
  assert.equal(objectMatches(o, '90234567'), true);
});
test('exact business IDs rank before longer IDs containing the same text', async () => {
  const {
    recordSearchRank
  } = await import('./interaction-model.js');
  const records = [{
    id: 'original_tax_role_admin',
    name: 'Tax Admin'
  }, {
    id: 'tax_role_admin',
    name: 'Tax Admin'
  }];
  assert.equal([...records].sort((a, b) => recordSearchRank(a, 'tax_role_admin') - recordSearchRank(b, 'tax_role_admin'))[0].id,
    'tax_role_admin');
});
test('generated IDs remain valid for digit-led names and validation explains manual errors', async () => {
  const {
    suggestedBusinessId,
    businessIdError
  } = await import('./interaction-model.js');
  assert.equal(suggestedBusinessId('2026 reviewers', 'role'), 'role_2026_reviewers');
  assert.equal(suggestedBusinessId('Review team', 'role'), 'review_team');
  assert.equal(suggestedBusinessId('', 'role'), '');
  assert.equal(businessIdError(suggestedBusinessId('123', 'policy')), '');
  assert.match(businessIdError('123'), /Start the ID/);
});
