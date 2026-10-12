const identifier = value => typeof value === 'string' && value.trim() === value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const hierarchical = row => typeof row?.kind === 'string' && row.kind.startsWith('Hierarchical');
const qualifiedReference = value => {
  const match = typeof value === 'string' && /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  // JavaScript's $ also matches before a final newline; text edits must be exact.
  return match && match[0] === value ? match : null;
};

/** Resolve display/picker identity only; never normalize the stored row on read.
 * "resolved" describes an unambiguous class/accessor pair, not live schema validity.
 * A retained MethodConfig RID cannot identify its defining class without more data.
 */
export function referenceIdentity(row) {
  const raw = {
    rawSource: row?.source,
    rawField: row?.field,
    referenceConfig: row?.referenceConfig
  };
  const result = (source, accessor, status) => ({ source, accessor, status, ...raw });
  if (hierarchical(row)) return result('', '', 'hierarchical');
  const source = identifier(row?.source) ? row.source : '',
    field = typeof row?.field === 'string' ? row.field : '';
  // Do not infer a replacement class when the stored source is present but unknown.
  if (row?.source != null && row.source !== '' && !source) return result('', '', 'unresolved');
  const qualified = qualifiedReference(field);
  if (qualified) {
    if (source && source !== qualified[1]) return result('', '', 'conflict');
    return result(source || qualified[1], qualified[2], 'resolved');
  }
  if (identifier(field)) return result(source, field, source ? 'resolved' : 'unresolved');
  if (!field && (row?.field == null || row.field === '')) {
    return result(source, '', source ? 'incomplete' : raw.referenceConfig ? 'unresolved' : 'empty');
  }
  return result(source, '', 'unresolved');
}

/** The same accessor on another class is a different reference. */
export function selectedReferenceAccessor(row, source) {
  const identity = referenceIdentity(row);
  return identity.status === 'resolved' && identity.source === source ? identity.accessor : '';
}

/** A single editable identity; unknown and conflicting values remain visible verbatim. */
export function editableReferenceValue(row) {
  const identity = referenceIdentity(row);
  return identity.status === 'resolved' ? identity.source + '.' + identity.accessor :
    typeof row?.field === 'string' ? row.field : '';
}

/** Called after actual typing, never on focus, blur, render or picker cancellation.
 * Incomplete input stays verbatim until the user supplies an exact Class.accessor.
 */
export function editReferenceText(row, text) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Choose a reference record first.');
  if (hierarchical(row)) throw Error('Hierarchy delegations do not use a reference property.');
  if (typeof text !== 'string') throw Error('Enter reference text.');
  const qualified = qualifiedReference(text);
  if (qualified) return chooseReference(row, qualified[1], qualified[2]);
  const identity = referenceIdentity(row),
    source = row.source == null || row.source === '' ? identity.source || row.source : row.source;
  return { ...row, ...(source !== undefined ? { source } : {}), field: text, referenceConfig: '' };
}

/** Call only after explicit property selection, inside the UI's undoable commit.
 * Class browsing and picker cancellation must not call this function.
 */
export function chooseReference(row, source, accessor) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Choose a reference record first.');
  if (hierarchical(row)) throw Error('Hierarchy delegations do not use a reference property.');
  if (!identifier(source)) throw Error('Choose the class that defines this reference.');
  if (!identifier(accessor)) throw Error('Choose a reference property from this class.');
  return { ...row, source, field: accessor, referenceConfig: '' };
}
