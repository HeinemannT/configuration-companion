import { activePBACExpressions, PBAC_COMPARISONS, isPBACAction, isPBACEffect, pbacEffect,
  isPBACGrouping, isPBACLeft, isPBACReference, isPBACSubject, classifyPBACRight, DENY_IGNORED } from './pbac-syntax';

const object = (node: unknown): node is Record<string, any> => node !== null && typeof node === 'object' && !Array.isArray(node);
const displayPath = (segments: readonly (string | number)[]) => segments.reduce((label: string, key, index) => typeof key === 'number'
  ? label + (index === 1 && segments[0] === 'Statement' ? ' ' + (key + 1) : '[' + key + ']')
  : label + (label ? '.' : '') + key, '') || 'Policy';

/** Local syntax only. BMP validates the referenced entities in the target environment. */
export interface PolicyIssue { severity: string; path: string; segments: (string | number)[]; message: string }
export function policyDiagnostics(value: unknown): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const issue = (segments: (string | number)[], message: string, severity = 'error') => issues.push({ severity, path: displayPath(segments), segments, message });
  const expression = (node: unknown, path: (string | number)[]): void => {
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
      else body.forEach((child: unknown, index: number) => expression(child, [...here, index]));
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
    if (Object.hasOwn(body, 'Roles') && (!Array.isArray(body.Roles) || body.Roles.some((role: unknown) => typeof role !== 'string' || !role)))
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
  value.Statement.forEach((s: unknown, index: number) => {
    const path: (string | number)[] = ['Statement', index];
    if (!object(s)) { issue(path, 'Use a statement object.'); return; }
    if (!(s.Subject === '*' || Array.isArray(s.Subject) && s.Subject.length && s.Subject.every(isPBACSubject)))
      issue([...path, 'Subject'], 'Use "*" or a list of role:<ID> / user:<ID> subjects.');
    // BMP is grant-only: the engine only checks whether an effect is Allow. It
    // accepts a stored Deny, so that is a warning, not a blocking error.
    if (!isPBACEffect(s.Effect)) issue([...path, 'Effect'], 'Use Effect "Allow". The server grants access only through Allow statements.');
    else if (pbacEffect(s.Effect) === 'Deny') issue([...path, 'Effect'], DENY_IGNORED, 'warning');
    if (!Array.isArray(s.Action) || s.Action.some((a: unknown) => !isPBACAction(a)))
      issue([...path, 'Action'], 'Use a list of actions: Create, Read, Update, or Delete.');
    else if (!s.Action.length) issue([...path, 'Action'], 'No actions selected; this statement grants nothing.', 'warning');
    expression(s.Resource, [...path, 'Resource']);
  });
  return issues;
}
