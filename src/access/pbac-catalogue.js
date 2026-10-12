import { fieldKind } from './schema-model.js';
import { rankCompletions } from './completion-ranking.js';
import { genericFields, genericField } from './pbac-fields.js';

const row = (value, detail = '', info = '') => ({ value, detail, info });

/** Lazy, bounded metadata for JSON completion. A refresh invalidates in-flight results. */
export function createPBACCatalogue({ getSnapshot, getRoles, getClasses, loadSchema, api }) {
  async function choices(request, signal, snapshot) {
    const query = request.query.trim(), classes = getClasses();
    const term = query.replace(/^(role|user|ListPropertySetItem):|^(resource|new)\./, '').toLowerCase();
    const bounded = rows => rankCompletions(rows, query);
    if (request.kind === 'types') return bounded(Object.keys(classes).map(type => row(type)));
    if (request.kind === 'subjects') {
      if (request.rolePrefix && query.startsWith('user:')) {
        if (term.length < 2) return [];
        const result = await api({ operation: 'principals', kind: 'User', query: term.slice(0, 200) }, { signal });
        return result.choices.filter(r => r.id).slice(0, 80).map(r => row('user:' + r.id, r.name));
      }
      return bounded(getRoles().filter(r => r.id).map(r => row((request.rolePrefix ? 'role:' : '') + r.id, r.name)));
    }
    const type = request.types?.length === 1 ? request.types[0] : null;
    if (type && Object.hasOwn(classes, type)) await loadSchema(type);
    if (signal.aborted || snapshot !== getSnapshot()) return [];
    const props = type ? getClasses()[type] ?? [] : [];
    if (request.kind === 'properties' && ['resource', 'new'].includes(request.scope)) {
      const builtins = genericFields(request.scope, request.reference);
      const known = new Set(builtins.map(p => p.accessor));
      const rows = [...builtins.map(p => row(p.expression, p.label, p.description)), ...props.filter(p => !known.has(p.accessor) && (!request.reference || p.reference))
        .map(p => row(request.scope + '.' + p.accessor, p.label || p.accessor, fieldKind(p)))];
      return bounded([...new Map(rows.map(r => [r.value, r])).values()]);
    }
    if (request.kind === 'values') {
      const prop = genericField(request.scope + (request.field ? '.' + request.field : '')) ?? props.find(p => p.accessor === request.field);
      if (prop?.listSet) {
        let items = prop.listSet.items;
        if (prop.listSet.partial) {
          const result = await api({ operation: 'listItems', set: prop.listSet.rid, query: term.slice(0, 200), selected: [] }, { signal });
          items = result.choices;
        }
        return bounded(items.filter(item => item.id).map(item => row(item.token, item.name)));
      }
      if (prop?.principal) return bounded([row('user', 'Current user')]);
      if (prop?.reference && query.length >= 2) {
        const separator = query.indexOf(':'), explicitType = separator > 0 ? query.slice(0, separator) : undefined;
        const targets = prop.targets?.replace(/[[\]]/g, '').split(/[,\s]+/).filter(Boolean) ?? [];
        const targetType = explicitType && Object.hasOwn(classes, explicitType) ? explicitType
          : targets.length === 1 && Object.hasOwn(classes, targets[0]) ? targets[0] : undefined;
        const search = separator > 0 ? query.slice(separator + 1) : query;
        // Ambiguous references need an explicit type; never search the entire environment.
        if (!targetType || search.length < 2) return [];
        const rows = await api({ operation: 'search', query: search.slice(0, 200), type: targetType }, { signal });
        return rows.filter(r => r.id).slice(0, 80).map(r => row(r.type + ':' + r.id, r.name));
      }
      if (fieldKind(prop) === 'Boolean') return bounded([row(true), row(false)]);
    }
    return [];
  }
  return async (request, signal) => {
    const snapshot = getSnapshot();
    if (signal.aborted) return [];
    const result = await choices(request, signal, snapshot);
    return signal.aborted || snapshot !== getSnapshot() ? [] : result;
  };
}
