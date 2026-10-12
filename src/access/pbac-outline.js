import { pbacActions, pbacEffect } from './pbac-syntax.js';
import { typeContext } from './schema-model.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : JSON.stringify(value) ?? '';
const reference = value => text(value).replace(/^(resource|new)\./, '');
const list = value => Array.isArray(value) ? value.map(text).join(', ') : text(value);

/** Exact ranges from the current parsed document; never retain offsets from invalid JSON. */
export function policyOutline(analysis) {
  if (analysis.value === undefined) return { valid: false, nodes: [] };
  const make = (path, label, children = [], description = '') => {
    const range = analysis.locations.get(JSON.stringify(path));
    if (!range) return null;
    return { id: JSON.stringify(path), path, label, description, ...range, children: children.filter(Boolean) };
  };
  const expression = (value, path) => {
    if (!object(value)) return make(path, typeof value === 'string' ? value : 'Expression');
    for (const operator of ['All', 'Any']) if (Object.hasOwn(value, operator)) {
      const items = value[operator];
      return make([...path, operator], operator + (Array.isArray(items) ? ' · ' + items.length + ' conditions' : ''),
        Array.isArray(items) ? items.map((item, i) => expression(item, [...path, operator, i])) : []);
    }
    if (Object.hasOwn(value, 'Condition')) {
      const c = value.Condition;
      if (!object(c)) return make([...path, 'Condition'], 'Condition');
      const right = Array.isArray(c.Right) ? (c.Right.length === 1 ? text(c.Right[0]) : c.Right.length + ' values') : text(c.Right);
      return make([...path, 'Condition'], [reference(c.Left), c.Comparison, right.replace(/^ListPropertySetItem:/, '')].filter(Boolean).join(' '), [], text(c.Left));
    }
    for (const operator of ['HasRole', 'HasAccessTo']) if (Object.hasOwn(value, operator)) {
      const v = value[operator], ref = object(v) ? v.Reference : v;
      const label = operator === 'HasRole' ? 'Role' + (object(v) && v.Roles ? ' · ' + list(v.Roles) : '')
        : 'Access' + (object(v) && v.Action ? ' · ' + list(v.Action) : '');
      return make([...path, operator], label + (ref ? ' · ' + reference(ref) : ''));
    }
    return make(path, 'Expression');
  };
  const statements = analysis.value?.Statement;
  const nodes = Array.isArray(statements) ? statements.map((statement, index) => {
    const path = ['Statement', index];
    if (!object(statement)) return make(path, 'Rule ' + (index + 1));
    const actions = pbacActions(statement.Action);
    const types = analysis.valid ? typeContext(statement.Resource, [], actions.length === 1 && actions[0] === 'Create' ? 'new' : 'resource') : [];
    const subject = statement.Subject === '*' ? 'Everyone' : list(statement.Subject) || 'Subjects';
    const description = [statement.description, statement.title, statement.comment, statement._comment].find(v => typeof v === 'string') ?? '';
    return make(path, [pbacEffect(statement.Effect) === 'Deny' ? 'Deny' : '', actions.join(', ') || 'Rule ' + (index + 1), types.join(', ')].filter(Boolean).join(' · '), [
      make([...path, 'Subject'], subject), expression(statement.Resource, [...path, 'Resource'])
    ], description);
  }).filter(Boolean) : [];
  return { valid: true, nodes };
}
