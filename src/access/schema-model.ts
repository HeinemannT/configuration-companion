// The type context is scoped to the current branch and operand; new never borrows resource.
// Policy JSON and BMP property metadata cross this boundary untyped.
export type PolicyJson = any;
export type PropertyMeta = any;

export function typeContext(root: PolicyJson, path: readonly (string | number)[], scope: string): string[] {
  const guaranteed = (node: PolicyJson): string[] => {
    if (!node || typeof node !== 'object') return [];
    const c = node.Condition;
    if (c?.Left === scope + '.type' && ['=', 'Equal', 'ExactTypeOf', 'ContainsAny'].includes(c.Comparison ?? '=')) {
      const values = Array.isArray(c.Right) ? c.Right : [c.Right];
      if (['=', 'Equal'].includes(c.Comparison ?? '=') && values.length > 1) return [];
      if (c.Comparison === 'ExactTypeOf' && Array.isArray(c.Right)) return [];
      return values.filter((v: unknown): v is string => typeof v === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(v));
    }
    if (Array.isArray(node.All)) return node.All.flatMap(guaranteed);
    if (Array.isArray(node.Any) && node.Any.length) {
      const branches: string[][] = node.Any.map(guaranteed);
      return branches.every((b: string[]) => b.length) ? branches.flat() : [];
    }
    return [];
  };
  const found: string[] = [];
  let node: PolicyJson = root;
  for (let i = 0; i <= path.length; i++) {
    if (node?.All && path[i] === 'All' && Number.isInteger(path[i + 1])) {
      node.All.forEach((child: PolicyJson, index: number) => {
        if (index !== path[i + 1]) found.push(...guaranteed(child));
      });
    } else if (node?.Condition || i === path.length) found.push(...guaranteed(node));
    node = node?.[path[i]];
  }
  return [...new Set(found)];
}

export function fieldKind(prop: PropertyMeta): string {
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

export function listChoiceRows(prop: PropertyMeta) {
  return (prop?.listSet?.items ?? []).map((item: PolicyJson) => ({
    rid: item.token,
    id: item.id,
    label: item.name,
    token: item.token,
    itemRid: item.rid,
    setRid: prop.listSet.rid,
    secondary: item.id,
    icon: 'list',
    depth: 0,
    reason: item.id ? '' : 'This item needs an ID before it can be used in a policy.'
  }));
}

export function chooseListValue(prop: PropertyMeta, tokens: string[], multi: boolean) {
  const known = new Set(listChoiceRows(prop).filter((r: { reason: string }) => !r.reason).map((r: { token: string }) => r.token));
  if (tokens.some((t: string) => !known.has(t))) throw Error('Choose an item from this property’s list.');
  if (!multi && tokens.length !== 1) throw Error('Choose one list item.');
  return multi ? [...tokens] : tokens[0];
}

// Match the typed token, never the label or the numeric RID. Two items may share a name.
export function selectedListItems(prop: PropertyMeta, value: unknown) {
  const items = new Map<unknown, PolicyJson>((prop?.listSet?.items ?? []).map((item: PolicyJson): [unknown, PolicyJson] => [item.token, item]));
  return (Array.isArray(value) ? value : [value]).filter(token => token !== '' && token != null).map((token: any) => {
    const item = items.get(token);
    return { token, label: item?.name || (prop?.listSet?.partial ? String(token).split(':').slice(1).join(':') || String(token) : 'Unresolved item'), id: item?.id || String(token), known: !!item };
  });
}

// Picking a different field is one undoable edit. Never carry a value into another list.
export function changeField(condition: PolicyJson, left: string) {
  if (condition.Left === left) return {
    ...condition
  };
  return {
    ...condition,
    Left: left,
    Right: Array.isArray(condition.Right) ? [] : ''
  };
}
