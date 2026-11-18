// One word per idea in the Access screens. Screens import these instead of
// repeating literals, so a renamed idea changes everywhere at once.
//
// statement   one entry of a policy (never "rule")
// undecided   what the matrix could not read or load ("?" in cells). A grant under a
//             condition is not undecided: it shows its letter with a mark for the kind.
// unsaved     local changes that are not on the server yet
// Who/Can/On  the three parts of a statement

/** The three parts of a statement, in the editor, the role page and the review. */
export const PART = { who: 'Who', can: 'Can', on: 'On' } as const;

export const STATEMENT = 'statement';
export const STATEMENTS = 'statements';
/** The policy editor's tab that lists the statements. */
export const STATEMENTS_TAB = 'Statements';
export const statementLabel = (index: number) => 'Statement ' + (index + 1);
export const statementCount = (n: number) => n + ' ' + (n === 1 ? STATEMENT : STATEMENTS);

/** What the matrix cannot decide. The glyph stays in matrix cells. */
export const UNDECIDED = 'Unknown';
export const UNDECIDED_GLYPH = '?';
export const UNDECIDED_MEANING = 'Unknown: Companion could not read or load what it needs to tell. It is not a grant and not a zero.';

/** Local changes that are not saved to the server. */
export const UNSAVED_CHANGES = 'Unsaved changes';
export const unsavedCount = (n: number) => n + ' unsaved ' + (n === 1 ? 'change' : 'changes');
export const DISCARD_UNSAVED = 'Discard unsaved changes';
export const DISCARD_UNSAVED_QUESTION = 'Discard all unsaved changes? You can undo this.';
export const UNSAVED_DISCARDED = 'Unsaved changes discarded';

/** An unsaved change in the JSON text: one unit per policy whose text is edited. */
export const UNSAVED_JSON_CHANGES = 'Unsaved JSON changes';
export const KEEP_AS_UNSAVED = 'Keep as unsaved change';
export const OPEN_UNSAVED = 'Open unsaved change';
export const JSON_EDIT_IN_PROGRESS = 'JSON edit in progress, not yet a change';
/** The short mark for something that is changed here and not saved. */
export const UNSAVED = 'Unsaved';

/** The role page group of statements whose Who names the role. */
export const NAMING_THIS_ROLE = 'Naming this role';

/** A statement that cannot grant anything as it stands, in plain words. */
export const GRANTS_NOTHING_YET = 'Grants nothing yet';
export const NO_ACTION_TICKED = GRANTS_NOTHING_YET + ': no action is ticked.';
export const NO_ONE_NAMED = GRANTS_NOTHING_YET + ': Who names no one.';
export const NO_ONE_NO_ACTION = GRANTS_NOTHING_YET + ': Who names no one and no action is ticked.';
export const NO_EFFECT = 'Grants nothing: the statement has no effect. Only Allow grants access.';
export const notAllow = (effect: string) => 'Grants nothing: the effect “' + effect + '” is not Allow. Only Allow grants access.';

/** Words for history entries written before the current vocabulary. */
// Only the generated parts are rewritten; record names inside a message stay as they are.
export const currentWords = (text: string) => text.replace(/^Rule (\d+)/, 'Statement $1').replace(/^JSON draft updated$/, 'JSON kept as an unsaved change');
