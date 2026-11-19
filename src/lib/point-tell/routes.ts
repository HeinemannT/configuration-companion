/**
 * Changes an answer may ask for that Blueprint cannot stage: a text property (a button's text) and code (a
 * table's expression). They are not layout edits; the page hands them to the object window (a draft the
 * user reviews and saves there) and to the editor (a diff the user reviews and saves there).
 */
import { codeFieldsFor } from '../widget-metadata';

/** Text properties a change may name, by type: BMP property names. */
export const TEXT_PROPS: Record<string, readonly string[]> = {
  // The object window edits a button's text as one plain line (pane-schema: buttonText).
  ActionButton: ['buttonText'],
};

export type Route = 'code' | 'text';

/** Which route a property takes, or null when it is neither text nor code. */
export function routeOf(className: string, property: string): Route | null {
  if (codeFieldsFor(className).some(f => f.prop === property)) return 'code';
  if (TEXT_PROPS[className]?.includes(property)) return 'text';
  return null;
}

/** Every property of a type that takes a route (for the vocabulary and the page's reads). */
export function routedProps(className: string): { code: string[]; text: string[] } {
  return { code: codeFieldsFor(className).map(f => f.prop), text: [...(TEXT_PROPS[className] ?? [])] };
}
