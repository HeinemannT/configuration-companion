/** The name a badge and its card are announced by: the object's name, else
 *  its ID, else its type and RID. */
export function objectName(rid: string, e?: { name?: string; businessId?: string; templateBusinessId?: string; type?: string }): string {
  return e?.name || e?.templateBusinessId || e?.businessId || (e?.type ? `${e.type} ${rid}` : `object ${rid}`);
}
