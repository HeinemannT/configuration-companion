// Companion authoring conventions, not native PBAC fields. BMP's
// JsonPolicyDeserializer / mapping records read only the known policy fields.
// Recognize explicit annotation names, never every unknown key (or *comment).
const annotationKeys = new Set([
  'description', 'title', 'comment', 'comments', 'note', 'notes', 'annotations',
  '$comment', '_comment', // Compatibility with existing documents only.
]);

export const isPBACAnnotation = key => typeof key === 'string' && annotationKeys.has(key.toLowerCase());

export function ruleDescription(statement) {
  // An explicit empty description also overrides a legacy label. Other notes
  // remain independent; editing a description must not delete their contents.
  const value = Object.hasOwn(statement, 'description') ? statement.description : statement._comment;
  return typeof value === 'string' ? value : '';
}
