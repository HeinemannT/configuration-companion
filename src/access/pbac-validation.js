import { activePBACExpressions, PBAC_COMPARISONS, isPBACAction, isPBACEffect,
  isPBACGrouping, isPBACLeft, isPBACReference, isPBACSubject, classifyPBACRight } from './pbac-syntax.js';

const object = node => node !== null && typeof node === 'object' && !Array.isArray(node);
const displayPath = segments => segments.reduce((label, key, index) => typeof key === 'number'
  ? label + (index === 1 && segments[0] === 'Statement' ? ' ' + (key + 1) : '[' + key + ']')
  : label + (label ? '.' : '') + key, '') || 'Policy';

/** Local syntax only. BMP validates the referenced entities in the target environment. */
export function policyDiagnostics(value) {
  const issues = [];
  const issue = (segments, message, severity = 'error') => issues.push({ severity, path: displayPath(segments), segments, message });
  const expression = (node, path) => {
    if (!object(node)) { issue(path, 'Use a resource expression object.'); return; }
    const kinds = activePBACExpressions(node);
    if (kinds.length !== 1) {
      issue(path, Object.hasOwn(node, 'Not') ? 'Not is not a PBAC expression. Use a negated comparison such as NotEqual or NotContainsAny.' :
        'Use exactly one of All, Any, Condition, HasRole, or HasAccessTo.');
      return;
    }
    const kind = kinds[0], body = node[kind], here = [...path, kind];
    if (kind === 'All' || kind === 'Any') {
      if (!Array.isArray(body)) issue(here, 'Use a list of resource expressions.');
      else body.forEach((child, index) => expression(child, [...here, index]));
      return;
    }
    if (kind === 'Condition') {
      if (!object(body)) { issue(here, 'Use a condition object with Left and Comparison.'); return; }
      if (!isPBACLeft(body.Left)) issue([...here, 'Left'], 'Use resource, resource.<property ID>, or new.<property ID>.');
      if (!PBAC_COMPARISONS.has(body.Comparison))
        issue([...here, 'Comparison'], 'Unsupported comparison: ' + JSON.stringify(body.Comparison) + '. Use a supported PBAC comparison.');
      const right = classifyPBACRight(body.Left, body.Right);
      if (right.problem) issue([...here, 'Right'], right.problem);
      return;
    }
    if (typeof body === 'string') {
      if (!isPBACReference(body)) issue(here, 'Use resource.<property ID>, new.<property ID>, or reversed.<property ID>.');
      return;
    }
    if (!object(body)) { issue(here, 'Use a reference string or an object with Reference.'); return; }
    if (!isPBACReference(body.Reference))
      issue([...here, 'Reference'], 'Use resource.<property ID>, new.<property ID>, or reversed.<property ID>.');
    // Gson distinguishes an absent optional field from an explicit JSON null.
    if (Object.hasOwn(body, 'Roles') && (!Array.isArray(body.Roles) || body.Roles.some(role => typeof role !== 'string' || !role)))
      issue([...here, 'Roles'], 'Use a list of role IDs, without the role: prefix.');
    if (kind === 'HasAccessTo') {
      if (Object.hasOwn(body, 'Action') && !isPBACAction(body.Action)) issue([...here, 'Action'], 'Use Create, Read, Update, or Delete; omit Action to inherit the current action.');
      if (Object.hasOwn(body, 'Grouping') && !isPBACGrouping(body.Grouping)) issue([...here, 'Grouping'], 'Use All or Any.');
    }
  };
  if (!object(value)) { issue([], 'Use a JSON object.'); return issues; }
  if (!Array.isArray(value.Statement) || !value.Statement.length) {
    issue(['Statement'], 'Add at least one statement.'); return issues;
  }
  if (value.Version !== '1.0') issue(['Version'], 'Set Version to "1.0".');
  value.Statement.forEach((s, index) => {
    const path = ['Statement', index];
    if (!object(s)) { issue(path, 'Use a statement object.'); return; }
    if (!(s.Subject === '*' || Array.isArray(s.Subject) && s.Subject.length && s.Subject.every(isPBACSubject)))
      issue([...path, 'Subject'], 'Use "*" or a list of role:<ID> / user:<ID> subjects.');
    if (!isPBACEffect(s.Effect)) issue([...path, 'Effect'], 'Effect must be Allow or Deny.');
    if (!Array.isArray(s.Action) || s.Action.some(a => !isPBACAction(a)))
      issue([...path, 'Action'], 'Use a list of actions: Create, Read, Update, or Delete.');
    else if (!s.Action.length) issue([...path, 'Action'], 'No actions selected; this statement grants nothing.', 'warning');
    expression(s.Resource, [...path, 'Resource']);
  });
  return issues;
}
