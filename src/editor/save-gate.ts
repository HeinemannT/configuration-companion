/** The Save key follows the Save button: with nothing to save the button is
 * disabled ("No changes to save"), so Ctrl/Cmd+S must not open the confirm. */
export function canSave(isDirty: boolean, hasSurface: boolean): boolean {
  return hasSurface && isDirty
}
