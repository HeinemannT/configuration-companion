// The type context is scoped to the current branch and operand; new never borrows resource.
export function typeContext(root, path, scope) {
  const guaranteed = node => {
    if (!node || typeof node !== 'object') return [];
    const c = node.Condition;
    if (c?.Left === scope + '.type' && ['=', 'Equal', 'ExactTypeOf', 'ContainsAny'].includes(c.Comparison ?? '=')) {
      const values = Array.isArray(c.Right) ? c.Right : [c.Right];
      if (['=', 'Equal'].includes(c.Comparison ?? '=') && values.length > 1) return [];
      if (c.Comparison === 'ExactTypeOf' && Array.isArray(c.Right)) return [];
      return values.filter(v => typeof v === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(v));
    }
    if (Array.isArray(node.All)) return node.All.flatMap(guaranteed);
    if (Array.isArray(node.Any) && node.Any.length) {
      const branches = node.Any.map(guaranteed);
      return branches.every(b => b.length) ? branches.flat() : [];
    }
    return [];
  };
  const found = [];
  let node = root;
  for (let i = 0; i <= path.length; i++) {
    if (node?.All && path[i] === 'All' && Number.isInteger(path[i + 1])) {
      node.All.forEach((child, index) => {
        if (index !== path[i + 1]) found.push(...guaranteed(child));
      });
    } else if (node?.Condition || i === path.length) found.push(...guaranteed(node));
    node = node?.[path[i]];
  }
  return [...new Set(found)];
}

export function fieldKind(prop) {
  const cls = prop?.configClass ?? '';
  if (/Tag/.test(cls)) return 'Tags';
  if (/List/.test(cls)) return 'List';
  if (prop?.reference) return 'Reference';
  if (/Reference/.test(cls)) return 'Reference';
  if (/Boolean/.test(cls)) return 'Boolean';
  if (/Number|Integer|Decimal/.test(cls)) return 'Number';
  if (/Date/.test(cls)) return 'Date';
  if (/Text|Url/.test(cls)) return 'Text';
  return prop?.system ? 'System' : 'Property';
}

export function listChoiceRows(prop) {
  return (prop?.listSet?.items ?? []).map(item => ({
    rid: item.token,
    id: item.id,
    label: item.name,
    token: item.token,
    itemRid: item.rid,
    setRid: prop.listSet.rid,
    secondary: item.id,
    icon: 'list',
    depth: 0,
    reason: item.id ? '' : 'This item needs a business ID before it can be used in a policy.'
  }));
}

export function chooseListValue(prop, tokens, multi) {
  const known = new Set(listChoiceRows(prop).filter(r => !r.reason).map(r => r.token));
  if (tokens.some(t => !known.has(t))) throw Error('Choose an item from this property’s list.');
  if (!multi && tokens.length !== 1) throw Error('Choose one list item.');
  return multi ? [...tokens] : tokens[0];
}

// Match the typed token, never the label or the numeric RID. Two items may share a name.
export function selectedListItems(prop, value) {
  const items = new Map((prop?.listSet?.items ?? []).map(item => [item.token, item]));
  return (Array.isArray(value) ? value : [value]).filter(token => token !== '' && token != null).map(token => {
    const item = items.get(token);
    return { token, label: item?.name || (prop?.listSet?.partial ? String(token).split(':').slice(1).join(':') || String(token) : 'Unresolved item'), id: item?.id || String(token), known: !!item };
  });
}

// Picking a different field is one undoable edit. Never carry a value into another list.
export function changeField(condition, left) {
  if (condition.Left === left) return {
    ...condition
  };
  return {
    ...condition,
    Left: left,
    Right: Array.isArray(condition.Right) ? [] : ''
  };
}
