// Shared choice behavior; stored PBAC tokens are never replaced by display labels.
export const multiComparisons = ['ContainsAny', 'ContainsAll', 'NotContainsAny', 'NotContainsAll'];
const comparisons = [
  ['=', 'is', 'Equal value · object types include subtypes', 'Equality', 'equals Equal'],
  ['!=', 'is not', 'Not equal · also matches a missing value', 'Equality', 'NotEqual unequal'],
  ['ContainsAny', 'contains any', 'At least one matches', 'Multiple values', 'one of any of overlap'],
  ['ContainsAll', 'contains all', 'Every value matches', 'Multiple values', 'all of every'],
  ['NotContainsAny', 'contains none', 'No overlap · both operands must exist', 'Multiple values', 'none of excludes without'],
  ['NotContainsAll', 'does not contain all', 'At least one absent · both operands must exist', 'Multiple values', 'not all missing'],
  ['Empty', 'is empty', 'Missing value, empty text or empty collection', 'Presence', 'blank missing null'],
  ['NotEmpty', 'is not empty', 'A nonempty value · includes 0 and false', 'Presence', 'exists present filled'],
  ['Contains', 'contains', 'One item in a collection · not a text search', 'Other comparisons', 'includes ~ tilde'],
  ['NotContains', 'does not contain', 'Inverse of contains · both operands must exist', 'Other comparisons', 'excludes !~ tilde'],
  ['ExactTypeOf', 'has exact type', 'One exact object type · excludes subtypes', 'Object type', 'class type exact']
];
const aliases = { Equal: '=', NotEqual: '!=', '~': 'Contains', '!~': 'NotContains' };
export const comparisonLabels = Object.fromEntries([
  ...comparisons.map(([token, label]) => [token, label]),
  ...Object.entries(aliases).map(([token, canonical]) => [token, comparisons.find(c => c[0] === canonical)[1]])
]);
export function comparisonHint(condition) {
  const token = aliases[condition.Comparison] ?? condition.Comparison ?? '=';
  if (['=', '!='].includes(token) && Array.isArray(condition.Right) && condition.Right.length > 1)
    return 'This compares the whole collection. Use contains any to match one of these values.';
  if (token === 'ExactTypeOf' && Array.isArray(condition.Right))
    return 'Exact type needs one type, not an array. Choose a single type in the value picker.';
  return '';
}
export function comparisonRows(current, {
  multiple = false,
  type = false
} = {}) {
  const order = multiple
    ? ['Multiple values', 'Equality', 'Object type', 'Presence', 'Other comparisons']
    : ['Equality', ...(type ? ['Object type'] : []), 'Presence', 'Multiple values', 'Object type', 'Other comparisons'];
  const rows = comparisons.map(([rid, label, secondary, group, aliases]) => ({
    rid,
    label,
    secondary,
    group,
    aliases,
    detail: rid,
    depth: 0
  }));
  if (aliases[current]) rows.push({ ...rows.find(r => r.rid === aliases[current]), rid: current, detail: current,
    secondary: 'Native alias of ' + aliases[current] + ' · preserved' });
  else if (current && !rows.some(r => r.rid === current)) rows.push({
    rid: current,
    label: current,
    secondary: 'Existing comparison · preserved',
    group: 'Existing comparison',
    detail: current,
    depth: 0
  });
  return rows.sort((a, b) => (order.includes(a.group) ? order.indexOf(a.group) : 99) - (order.includes(b.group) ? order.indexOf(b.group) :
    99));
}
export function changeComparison(condition, operator) {
  const next = structuredClone(condition);
  next.Comparison = operator;
  // Membership needs a collection. Preserve every value when leaving it, including
  // hidden values on Empty/NotEmpty, so changing an operator never deletes input.
  if (multiComparisons.includes(operator) && !Array.isArray(next.Right)) next.Right = next.Right == null || next.Right === '' ? [] : [next
    .Right
  ];
  // BMP builds both tokens even for unary comparisons. An empty type string is
  // invalid; an empty type collection is valid and has no hidden input to lose.
  if (['Empty', 'NotEmpty'].includes(operator) && /^(resource|new)\.type$/.test(next.Left) && next.Right === '') next.Right = [];
  return next;
}
export function searchChoices(rows, query) {
  const q = query.trim().toLowerCase(),
    words = q.split(/\s+/).filter(Boolean);
  const ids = r => [r.label, r.id, r.searchId === false ? '' : r.rid];
  const text = r => [...ids(r), r.secondary, r.detail, r.aliases].filter(v => v != null).join(' ').toLowerCase();
  const rank = r => ids(r).some(v => String(v ?? '').toLowerCase() === q) ? 0 : String(r.label).toLowerCase().startsWith(q) ? 1 : 2;
  return rows.filter(r => words.every(w => text(r).includes(w))).sort((a, b) => q ? rank(a) - rank(b) : 0);
}
export function toggleChoice(selected, value, exclusive) {
  if (value === exclusive) return [exclusive];
  const values = selected.filter(v => v !== exclusive);
  return values.includes(value) ? values.filter(v => v !== value) : [...values, value];
}
export function nextChoice(rows, index, key) {
  const valid = rows.slice(0, 100).map((r, i) => r.reason ? -1 : i).filter(i => i >= 0);
  if (!valid.length) return -1;
  if (key === 'Home') return valid[0];
  if (key === 'End') return valid.at(-1);
  return key === 'ArrowUp' ? (valid.filter(i => i < index).at(-1) ?? valid[0]) : (valid.find(i => i > index) ?? valid.at(-1));
}
