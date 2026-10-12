import { typeContext } from './schema-model.js';

const own = (object, key) => Object.hasOwn(object ?? {}, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

// Suggested fields are input locations, never permission-satisfying values.
// Only inspect native expression operands: descriptions and string literals are not fields.
export function createInputs(statement) {
  const fields = new Set();
  function walk(node) {
    if (!plain(node)) return;
    const operand = node.Condition?.Left ?? node.HasRole?.Reference ?? node.HasAccessTo?.Reference;
    const match = typeof operand === 'string' && /^new\.([A-Za-z_][A-Za-z0-9_]*)(?:\.|$)/.exec(operand);
    if (match && !['type', 'parent'].includes(match[1])) fields.add(match[1]);
    for (const key of ['All', 'Any']) if (Array.isArray(node[key])) node[key].forEach(walk);
    if (node.Not) walk(node.Not);
  }
  walk(statement?.Resource);
  return { fields: [...fields], types: typeContext(statement?.Resource, [], 'new') };
}

export function readCreateValues(text) {
  let value;
  try { value = JSON.parse(text || '{}'); } catch { throw Error('Fix the request JSON before using fields or running the test.'); }
  if (!plain(value) || ['properties', 'references'].some(key => value[key] !== undefined && !plain(value[key])))
    throw Error('Use a JSON object with properties and references objects.');
  return value;
}

export function initializeCreate(check, statement, knownTypes) {
  if (check.createInitialized) return;
  check.createInitialized = true;
  const suggested = createInputs(statement);
  check.createFields = [...new Set([...(check.createFields ?? []), ...suggested.fields])];
  try {
    const values = readCreateValues(check.proposed);
    if (check.resource) {
      // Older drafts used a prototype as the trace resource. Never relabel that
      // prototype as the destination of a normal creation request.
      check.resource = typeof values.parent_rid === 'string' ? values.parent_rid : '';
    }
    if (!values.type && suggested.types.length === 1 && knownTypes.includes(suggested.types[0])) {
      values.type = suggested.types[0];
      check.proposed = JSON.stringify(values, null, 2);
    }
  } catch { /* Preserve unfinished JSON. */ }
}

export function createFieldValue(values, field) {
  if (field === 'parent') return { kind: 'parent_rid', supplied: own(values, 'parent_rid'), value: values.parent_rid };
  for (const kind of ['references', 'properties']) if (own(values[kind], field)) return { kind, supplied: true, value: values[kind][field] };
  return { supplied: false, value: undefined };
}

// Preserve unknown fields and literal JSON types through every form edit.
export function setCreateValue(check, field, kind, value) {
  const values = readCreateValues(check.proposed);
  if (field === 'type') values.type = value;
  else if (field === 'parent') {
    if (value === undefined) delete values.parent_rid;
    else values.parent_rid = value;
    check.resource = typeof value === 'string' ? value : check.resource;
  } else {
    for (const key of ['references', 'properties']) if (values[key]) delete values[key][field];
    if (value !== undefined) {
      if (!['references', 'properties'].includes(kind)) throw Error('Choose a field with known metadata, or edit its JSON value.');
      values[kind] ??= {};
      Object.defineProperty(values[kind], field, { value, enumerable: true, configurable: true, writable: true });
    }
    check.createFields = [...new Set([...(check.createFields ?? []), field])];
  }
  check.proposed = JSON.stringify(values, null, 2);
  if (check.createNumberDrafts) delete check.createNumberDrafts[field];
  if (check.result) check.result.stale = true;
}

// Keep unfinished numeric text separate from the last valid request. Native
// number inputs expose an empty value for tokens such as "-" or "1e".
export function setCreateNumber(check, field, text) {
  const trimmed = text.trim(), value = trimmed === '' ? undefined : Number(trimmed);
  if (trimmed && (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) || !Number.isFinite(value))) {
    check.createNumberDrafts = { ...check.createNumberDrafts, [field]: text };
    if (check.result) check.result.stale = true;
    return false;
  }
  setCreateValue(check, field, 'properties', value);
  return true;
}

export function omitCreateValue(check, field) {
  const current = createFieldValue(readCreateValues(check.proposed), field);
  if (!current.supplied && Object.hasOwn(check.createNumberDrafts ?? {}, field)) {
    delete check.createNumberDrafts[field];
    return;
  }
  if (current.supplied) {
    check.omittedValues = { ...check.omittedValues, [field]: current };
    setCreateValue(check, field, current.kind, undefined);
  } else if (check.omittedValues?.[field]) {
    const previous = check.omittedValues[field];
    setCreateValue(check, field, previous.kind, previous.value);
    delete check.omittedValues[field];
  }
}

// Parent is both the actual creation context and new.parent. The latter may be
// deliberately omitted for a negative test while retaining the trace context.
export function createResource(check) {
  const parent = readCreateValues(check.proposed).parent_rid;
  return typeof parent === 'string' && parent ? parent : check.resource;
}

export function testContextRids(check) {
  const ids = new Set();
  for (const scenario of [check, ...Object.values(check.scenarios ?? {})]) {
    if (scenario.resource) ids.add(scenario.resource);
    try {
      const values = readCreateValues(scenario.proposed);
      if (values.parent_rid) ids.add(values.parent_rid);
      Object.values(values.references ?? {}).flat().filter(v => typeof v === 'string').forEach(v => ids.add(v));
    } catch { /* Invalid drafts are preserved without interpreting them. */ }
  }
  return [...ids];
}
