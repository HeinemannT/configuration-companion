/** Positive sample hints only, never permission evidence. Use live subtype
 * metadata for BMP's assignable type comparisons; ExactTypeOf stays exact. */
export function performanceTypeHints(condition: any, classes: Record<string, unknown>, children: Record<string, string[]> = {}): string[] {
  if (!condition || !['resource.type','new.type'].includes(condition.Left)) return [];
  const {Comparison:op,Right:right} = condition;
  const values: unknown[] = Array.isArray(right) ? right : [right];
  if (!values.length || values.some(v=>typeof v!=='string'||!/^[A-Za-z]\w*$/.test(v))) return [];
  const types = values as string[];
  if (op === 'ExactTypeOf') return !Array.isArray(right) && right in classes ? [right] : [];
  if (!['=','Equal','~','Contains','ContainsAny','ContainsAll'].includes(op)) return [];
  if (['=','Equal'].includes(op) && types.length!==1 || ['~','Contains'].includes(op) && !Array.isArray(right)) return [];
  const expanded = types.map(type=>new Set([type,...(children[type]||[])]));
  return [...new Set(expanded.flatMap(set=>[...set]))].filter(type=>type in classes && (op!=='ContainsAll'||expanded.every(set=>set.has(type))));
}
