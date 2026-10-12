// BMP ResourceFieldResolver's built-ins, shared by the builder and JSON completion.
// Other fields (including name/ownership) must come from the environment's schema.
const fields = [
  { accessor: 'type', label: 'Object type', icon: 'type', description: 'BMP type. Equality includes subtypes; ExactTypeOf matches one concrete type.' },
  { accessor: 'id', label: 'Business ID', icon: 'json', description: 'Business ID, scoped to its namespace. Combine with a type condition.' },
  { accessor: 'parent', label: 'Parent object', icon: 'link', reference: true, description: 'Immediate parent. Compare with a typed reference, such as Organisation:department_id.' },
  { accessor: 'linkedTo', label: 'Template / master', icon: 'link', reference: true, description: 'The template or master this instance links to; not an arbitrary object relationship.' },
  { accessor: 'createdBy', label: 'Created by', icon: 'assignment', reference: true, principal: true, targets: '[User]', description: 'Creator. For resource, compare with user (the requesting user) or User:business_id.' },
  { accessor: 'model', label: 'Model', icon: 'folder', description: 'BMP model, not the displayed tree location. For example, a Scorecard can belong to TEMPLATECATEGORY.' },
];
const resource = { accessor: '', label: 'Object itself', icon: 'object', reference: true, description: 'The resource itself. Compare with a typed reference, such as Scorecard:page_id.' };

export function genericFields(scope, referencesOnly = false) {
  if (!['resource', 'new'].includes(scope)) return [];
  const available = [...fields, ...(scope === 'resource' && !referencesOnly ? [resource] : [])];
  return available.map(field => ({
    ...field, system: true, builtin: true, configClass: 'SystemMethodConfig',
    expression: scope + (field.accessor ? '.' + field.accessor : ''),
    // new reads the request verbatim; only resource resolves the creator to a user RID.
    reference: field.reference && (field.accessor !== 'createdBy' || scope === 'resource'),
    principal: field.principal && scope === 'resource',
    description: scope === 'new' ? field.description + ' new only has request fields (or Create defaults).' : field.description,
  })).filter(field => !referencesOnly || field.reference);
}

export function genericField(expression) {
  return genericFields(expression?.split('.')[0]).find(field => field.expression === expression);
}

export function propertyChoices(scope, props = [], type = '') {
  const generic = genericFields(scope), known = new Set(generic.map(field => field.accessor));
  const row = (prop, group) => ({ rid: scope + (prop.accessor ? '.' + prop.accessor : ''), id: prop.accessor,
    label: prop.label || prop.accessor, secondary: scope + (prop.accessor ? '.' + prop.accessor : ''),
    description: prop.description, icon: prop.icon || (prop.listSet ? 'list' : prop.reference ? 'link' : 'sliders'), group, depth: 0 });
  return [...generic.map(prop => row(prop, 'General')),
    ...props.filter(prop => !known.has(prop.accessor)).sort((a, b) => Number(!!a.system) - Number(!!b.system) || (a.label || a.accessor).localeCompare(b.label || b.accessor))
      .map(prop => row(prop, prop.system ? 'System properties' : (type ? type + ' properties' : 'Properties')))];
}
