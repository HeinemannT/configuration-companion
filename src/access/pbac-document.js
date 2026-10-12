import { parser as jsonParser } from '@lezer/json';
import { PBAC_EXPRESSIONS, PBAC_COMPARISONS, isPBACAction, isPBACEffect,
  isPBACGrouping, isPBACLeft, isPBACReference, isPBACSubject, classifyPBACRight } from './pbac-syntax.js';
import { policyDiagnostics } from './pbac-validation.js';
import { isPBACAnnotation } from './pbac-annotations.js';

const statementFields = { Subject: 'subjects', Effect: 'effect', Action: 'actions', Resource: 'expression' };
const expressionFields = { All: 'expressions', Any: 'expressions', Condition: 'condition', HasRole: 'roleCheck', HasAccessTo: 'accessCheck' };
function fieldScope(scope, key) {
  if (scope === 'comment' || scope !== 'literal' && isPBACAnnotation(key)) return 'comment';
  if (scope === 'document' && key === 'Statement') return 'statements';
  if (['document', 'statement'].includes(scope) && Object.hasOwn(statementFields, key)) return statementFields[key];
  if (['document', 'expression'].includes(scope) && Object.hasOwn(expressionFields, key)) return expressionFields[key];
  if (scope === 'condition') return { Left: 'left', Right: 'right', Comparison: 'comparison' }[key] || 'literal';
  if (['roleCheck', 'accessCheck'].includes(scope)) {
    if (key === 'Reference') return 'reference';
    if (key === 'Roles') return 'roles';
    if (scope === 'accessCheck') return { Action: 'action', Grouping: 'grouping' }[key] || 'literal';
  }
  return 'literal';
}
function keyKind(key, scope) {
  if (scope === 'comment' || scope !== 'literal' && isPBACAnnotation(key)) return 'comment';
  if (scope === 'document' && ['Version', 'Statement'].includes(key) ||
    ['document', 'statement'].includes(scope) && Object.hasOwn(statementFields, key)) return 'structure';
  return ['document', 'expression'].includes(scope) && PBAC_EXPRESSIONS.has(key) ? 'logic' : 'key';
}
function stringKind(value, scope, inArray, right) {
  if (scope === 'comment') return 'comment';
  if (scope === 'roles' && inArray) return 'role';
  if (scope === 'subjects') {
    if (!inArray && value === '*') return 'atom';
    if (inArray && isPBACSubject(value)) return value.startsWith('role:') ? 'role' : 'subject';
  }
  if (scope === 'effect' && isPBACEffect(value) || scope === 'action' && isPBACAction(value) ||
    scope === 'actions' && inArray && isPBACAction(value)) return 'action';
  if (scope === 'comparison' && PBAC_COMPARISONS.has(value)) return 'operator';
  if (scope === 'grouping' && isPBACGrouping(value)) return 'logic';
  if (scope === 'left' && isPBACLeft(value) ||
    ['reference', 'roleCheck', 'accessCheck'].includes(scope) && isPBACReference(value)) return 'reference';
  if (scope === 'right' && right && !right.problem) {
    if (right.kind === 'user') return 'reference';
    if (['objects', 'types', 'models'].includes(right.kind)) return 'typed';
  }
  return 'string';
}

/** One document revision produces both highlight spans and located diagnostics.
 * Lezer owns JSON syntax/recovery; JSON.parse owns values. PBAC owns semantics.
 * Paths use decoded keys and numeric indices, never a text search for a key.
 */
export function analyzePBAC(text) {
  const tree = jsonParser.parse(text), spans = [], locations = new Map();
  let value, syntaxError;
  try { value = JSON.parse(text); } catch (error) { syntaxError = error; }
  const decode = node => {
    try { return JSON.parse(text.slice(node.from, node.to)); } catch { return undefined; }
  };
  const mark = (node, type) => {
    if (node.to > node.from) spans.push({ from: node.from, to: node.to, type });
  };
  const punctuation = node => {
    if (node.type.isError) mark(node, 'invalid');
    else mark(node, 'punctuation');
  };
  const visit = (node, scope, path, data, inArray = false, right) => {
    locations.set(JSON.stringify(path), { from: node.from, to: node.to });
    if (node.name === 'Object') {
      // Only expression/statements arrays introduce semantic object scopes.
      if (inArray) scope = { statements: 'statement', expressions: 'expression', comment: 'comment' }[scope] || 'literal';
      else if (!['document', 'statement', 'expression', 'condition', 'roleCheck', 'accessCheck', 'comment'].includes(scope)) scope = 'literal';
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== 'Property') { punctuation(child); continue; }
        const name = child.firstChild, key = decode(name);
        mark(name, key === undefined ? 'invalid' : keyKind(key, scope));
        const nextScope = fieldScope(scope, key);
        for (let part = name.nextSibling; part; part = part.nextSibling) {
          if (part.name === ':' || part.type.isError) { punctuation(part); continue; }
          // Whole-operand semantics require a complete JSON value. Incomplete
          // edits keep ordinary JSON colors until their meaning is known.
          const operand = nextScope === 'right' && !syntaxError ? classifyPBACRight(data?.Left, data?.Right) : undefined;
          visit(part, nextScope, [...path, key], data?.[key], false, operand);
        }
      }
    } else if (node.name === 'Array') {
      if (scope !== 'comment' && (inArray || !['statements', 'expressions', 'subjects', 'actions', 'roles', 'right'].includes(scope))) scope = 'literal';
      let index = 0;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (['[', ']', ','].includes(child.name) || child.type.isError) { punctuation(child); continue; }
        visit(child, scope, [...path, index], data?.[index], true, right);
        index++;
      }
    } else if (node.name === 'String') {
      const decoded = decode(node);
      mark(node, decoded === undefined ? 'invalid' : stringKind(decoded, scope, inArray, right));
    } else if (node.name === 'Number') mark(node, scope === 'comment' ? 'comment' : 'number');
    else if (['True', 'False', 'Null'].includes(node.name)) mark(node, scope === 'comment' ? 'comment' : 'atom');
    else punctuation(node);
  };
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) visit(node, 'document', [], value);
  const range = segments => {
    let path = [...segments], found = locations.get(JSON.stringify(path));
    while (!found && path.length) { path.pop(); found = locations.get(JSON.stringify(path)); }
    if (!found) return { from: 0, to: Math.min(1, text.length) };
    // Missing fields mark the containing object's opening delimiter, not an
    // unrelated occurrence of the same field name somewhere else in the policy.
    return path.length === segments.length ? found : { from: found.from, to: Math.min(found.from + 1, found.to) };
  };
  let issues;
  if (syntaxError) {
    let from = Number(syntaxError.message.match(/position (\d+)/)?.[1] ?? NaN);
    if (!Number.isFinite(from)) {
      tree.iterate({ enter(node) { if (!Number.isFinite(from) && node.type.isError) from = node.from; } });
    }
    from = Math.min(Number.isFinite(from) ? from : 0, text.length);
    issues = [{ severity: 'error', path: 'JSON', segments: [], message: syntaxError.message, from, to: Math.min(from + 1, text.length) }];
  } else issues = policyDiagnostics(value).map(issue => ({ ...issue, ...range(issue.segments) }));
  return { tree, value, spans, issues, locations, valid: !issues.some(issue => issue.severity === 'error') };
}
