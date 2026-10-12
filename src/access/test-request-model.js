const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const rid = value => typeof value === 'string' && /^\d+$/.test(value);
export function renameExample(object) {
  return object?.name ? object.name + ' (test)' : '';
}
export function proposedForTest(check, object) {
  if (!['Create', 'Update'].includes(check.action)) return undefined;
  if (check.action === 'Create' && Object.keys(check.createNumberDrafts ?? {}).length) throw Error('Complete or omit the unfinished number before running the test.');
  if (check.action === 'Update' && check.updateMode !== 'custom') {
    if (!object?.type) throw Error('Choose an object from the picker to prepare a rename test.');
    const name = check.rename ?? renameExample(object);
    if (!name.trim()) throw Error('Enter a new name for the rename test.');
    if (name === object.name) throw Error('Use a different name to test a change.');
    return {
      type: object.type,
      properties: {
        name
      }
    };
  }
  let value;
  try {
    value = JSON.parse(check.proposed);
  } catch {
    throw Error('Fix the proposed-values JSON before running the test.');
  }
  if (!plain(value) || typeof value.type !== 'string' || !value.type.trim()) throw Error(
    'Proposed values need an object type, for example {"type":"Organisation","properties":{"name":"Example"}}.');
  if (check.action === 'Update' && object?.type && value.type !== object.type) throw Error('Use the selected object type: ' + object.type + '.');
  if (Object.keys(value).some(k => !['type', 'properties', 'references', 'parent_rid'].includes(k))) throw Error(
    'Put field values inside properties or references.');
  if (value.properties !== undefined && (!plain(value.properties) || Object.values(value.properties).some(v => v !== null && !['string',
      'number', 'boolean'
    ].includes(typeof v)))) throw Error('Properties must contain text, numbers, booleans, or null.');
  if (value.references !== undefined && (!plain(value.references) || Object.values(value.references).some(v => v !== null && !rid(v) && !(
      Array.isArray(v) && v.every(rid))))) throw Error('Reference values must be internal RID strings, lists of RID strings, or null.');
  if (value.parent_rid !== undefined && value.parent_rid !== null && !rid(value.parent_rid)) throw Error('The parent RID must be a string.');
  return value;
}
export function switchTestAction(check, action) {
  if (check.action === action) return check;
  const next = structuredClone(check),
    previous = next.action;
  next.proposedDrafts = {
    ...next.proposedDrafts
  };
  if (['Create', 'Update'].includes(previous)) next.proposedDrafts[previous] = next.proposed;
  // Actor is shared; each action owns its object, submitted values and last result.
  const keys = ['resource', 'proposed', 'rename', 'updateMode', 'createFields', 'createLabels', 'createNumberDrafts', 'omittedValues', 'createView', 'createInitialized', 'result', 'rerunRequired'];
  next.scenarios = { ...next.scenarios, [previous]: Object.fromEntries(keys.filter(k => check[k] !== undefined).map(k => [k, structuredClone(check[k])])) };
  const restored = next.scenarios[action];
  for (const key of keys) delete next[key];
  next.action = action;
  if (restored) {
    Object.assign(next, structuredClone(restored));
    if (next.result) next.result = next.result.running ? { error: 'This test was interrupted. Run it again.' } : { ...next.result, stale: true };
  } else {
    next.resource = action === 'Create' || previous === 'Create' ? '' : check.resource;
    next.proposed = next.proposedDrafts[action] ?? '{}';
    next.result = null;
  }
  return next;
}
