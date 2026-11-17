// JSON carried in data attributes, such as the path of a condition inside a
// statement. A control without the attribute, or with text that is not JSON,
// gives undefined instead of an exception, so a command that reaches the wrong
// control does nothing instead of showing a parser error.

/** The parsed attribute value, or undefined when it is missing or not JSON. */
export function readJson(raw: string | null | undefined): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** A path into the statement's Resource: an array of keys and indices, or undefined. */
export function readPath(raw: string | null | undefined): (string | number)[] | undefined {
  const value = readJson(raw);
  return Array.isArray(value) && value.every(part => typeof part === 'string' || typeof part === 'number') ? value : undefined;
}

/** Commands that act on one condition and need the control's data-path. */
export const PATH_COMMANDS = new Set(['value-remove', 'value-suggest', 'edit-condition-value', 'insert-condition', 'remove-condition', 'edit-node',
  'logic-group', 'logic-menu', 'logic-transform', 'logic-add-role', 'logic-remove-role', 'schema-source', 'schema-property', 'schema-value', 'schema-operator']);

/** True when the command needs a condition path and the control carries none. */
export const lacksPath = (command: string, el: { dataset: DOMStringMap }): boolean => PATH_COMMANDS.has(command) && !readPath(el.dataset.path);

/** Said in the status bar when a condition command reaches a control without a path. */
export const NO_PATH = 'This control has lost its condition. Open the statement again and retry.';
