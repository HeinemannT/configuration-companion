export function clarityFixture() {
  const reference = (accessor, label) => ({ rid: '9000000000000000901', accessor, label, reference: true, configClass: 'ReferenceMethodConfig', targets: '[CeRiskAssessment]' });
  const scope = { rid: '9000000000000000902', accessor: 'scope', label: 'Scope', configClass: 'ListMethodConfig', reference: true,
    listSet: { rid: '9000000000000000903', id: 'review_scopes', name: 'Review scopes', items: [
      { rid: '9000000000000000904', id: 'scope_global', name: 'Central', token: 'ListPropertySetItem:scope_global' },
      { rid: '9000000000000000905', id: 'scope_regional', name: 'Central', token: 'ListPropertySetItem:scope_regional' },
      { rid: '9000000000000000906', id: 'scope_local', name: 'Local', token: 'ListPropertySetItem:scope_local' },
    ] } };
  const classes = { CeRiskAssessment: [{ ...reference('owners', 'Risk owners'), principal: true }, scope],
    CeControlMeasure: [reference('relatedRisk', 'Related risk'), reference('ownerRisk', 'Owning risk')],
    CeTask: [reference('relatedRisk', 'Related risk'), reference('assignedRisk', 'Assigned risk')] };
  const rule = effect => ({ Effect: effect, Subject: ['role:risk_review'], Action: ['Read'], Resource: { All: [
    { Condition: { Left: 'resource.type', Comparison: '=', Right: 'CeRiskAssessment' } },
    { Condition: { Left: 'resource.scope', Comparison: 'ContainsAny', Right: ['ListPropertySetItem:scope_global', 'ListPropertySetItem:scope_regional', 'ListPropertySetItem:removed'] } },
  ] } });
  const model = {
    roles: [{ rid: '9000000000000000001', id: 'risk_review', name: 'Risk review', parent: '' }],
    scope: [
      { rid: '9000000000000000002', id: 'risk_owners', name: 'Risk owners', parent: '9000000000000000001', kind: 'RoleAssignment', source: 'CeRiskAssessment', field: 'owners' },
      { rid: '9000000000000000003', id: 'related_controls', name: 'Related controls', parent: '9000000000000000002', kind: 'InwardsReferenceRoleDelegationRule', source: '', field: 'CeControlMeasure.relatedRisk', referenceConfig: '9000000000000000901' },
    ],
    policies: [{ rid: '9000000000000000004', id: 'risk_review_policy', name: 'Risk review access', parent: '', enabled: true, content: { Version: '1.0', Statement: [rule('Allow'), rule('Deny')] } }],
    globals: [], folders: [],
  };
  const snapshot = { environment: 'clarity-fixture', name: 'Interaction QA', loadedAt: new Date().toISOString(), roots: { roles: '1', policies: '2' }, model, classes: Object.fromEntries(Object.keys(classes).map(type => [type, []])), users: [], groups: [] };
  const object = { rid: '8000000000000000001', id: 'risk_01', name: 'Quarterly risk assessment', type: 'CeRiskAssessment' };
  return { snapshot, classes, object };
}
