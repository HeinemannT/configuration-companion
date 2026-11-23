/**
 * Object window — per-type knowledge in ONE table.
 *
 * Each entry says how a type is drawn in the object window: its structure
 * rule (service worker uses it to list the tree), the marker columns it puts
 * on the tree when it is the root, the expression blocks of its Behaviour
 * section, curated property groups (labels and group names follow
 * Configuration Studio), and an optional collapsed layout group that links
 * to Blueprint.
 *
 * The table never decides what exists: a field, block or gate is drawn only
 * when the object read returned that property. Unknown types fall back to a
 * generic entry (root-only tree, generic property list), so older BMP
 * versions and new classes never fail.
 *
 * To add a type (EditPage, Scorecard, data objects …) add an entry to TYPES.
 * Pure data + small functions; no DOM, no chrome.*.
 */

import { glyphId } from './object-glyphs';
import type { FullObject, PropValue } from './object-read';
import type { StructureRule } from './object-structure';

export type FieldWidget = 'text' | 'mono' | 'bool' | 'enum' | 'num' | 'ref' | 'ro' | 'color' | 'image';

export interface FieldDef {
  /** Property name in the read (`props`). */
  prop?: string;
  /** Reference role in the read (`references`). */
  ref?: string;
  label: string;
  widget: FieldWidget;
}

export interface GroupDef {
  title: string;
  fields: FieldDef[];
}

export interface SlotDef {
  letter: string;
  name: string;
  /** true / false, or null when not applicable (property not returned). */
  test: (obj: FullObject) => boolean | null;
}

export type FamilyToken =
  | '--fam-structure' | '--fam-layout' | '--fam-input' | '--fam-button'
  | '--fam-code' | '--fam-content' | '--fam-status' | '--text-placeholder';

export interface TypeInfo {
  /** Display name of the type. */
  label: string;
  icon: string;
  fam: FamilyToken;
  /** Structure listed under this type when it is the window root. Absent:
   *  the tree holds the root only. */
  structure?: StructureRule;
  /** Marker columns on the tree when this type is the root. */
  slots: SlotDef[];
  /** Expression properties for the Behaviour section, in order. */
  blocks: string[];
  groups: GroupDef[];
  layout?: GroupDef;
  /** Short qualifier next to the type label (e.g. button type). */
  qualifier?: (obj: FullObject) => string;
  /** Drawn as a quiet divider row in the tree, labelled with what it
   *  starts (see `dividerLeads`). */
  divider?: 'page' | 'column' | 'heading';
  /** Detail pane opens with the property the node is mapped to. */
  lead?: 'mapping';
  /** Curated properties before the Behaviour section. */
  settingsFirst?: boolean;
  /** A single reference the tree follows below a node of this type when
   *  `when` holds (a ButtonInput of type action → its action object). The
   *  target is drawn as a referenced row, its children below it. Followed
   *  only once the node's row is visible; never part of the open. */
  follow?: FollowRule;
}

export interface FollowRule {
  via: string;
  /** Child levels listed below the target. */
  depth: number;
  when(obj: FullObject): boolean;
}

export interface ExpressionDef {
  label: string;
  /** Boolean property that switches the expression on. */
  gate?: string;
  /** Not Extended Code (no EC colouring). */
  plain?: boolean;
  /** One line on what the code is for, shown as the label's tooltip. Only
   *  where the code or the product vocabulary makes it certain. */
  help?: string;
}

export const EXPRESSIONS: Readonly<Record<string, ExpressionDef>> = {
  showExpression: { label: 'Show expression', gate: 'useShowExpression', help: 'Decides whether the element is shown; applies while "Use show expression" is on.' },
  enableExpression: { label: 'Enable expression', gate: 'useEnableExpression', help: 'Decides whether the element can be used; applies while "Use enable expression" is on.' },
  expression: { label: 'Expression' },
  initExpression: { label: 'Init expression', help: 'Runs before the new object is saved; tba is the object being added (prefill of hidden or computed values).' },
  afterExpression: { label: 'After expression', help: 'Runs after the save; after is the saved object, before the object before the edit (MISSING when adding).' },
  refreshExpression: { label: 'Refresh expression' },
  defaultExpression: { label: 'Default expression' },
  requiredExpression: { label: 'Required expression' },
  editExpression: { label: 'Edit expression' },
  destinationExpression: { label: 'Destination expression' },
  javascript: { label: 'JavaScript', plain: true, help: 'JavaScript of the custom visualization (not Extended Code).' },
};

const DESC: FieldDef = { prop: 'description', label: 'Description', widget: 'text' };
/** The image of a button or an image view: picked from the workspace's image files. */
const IMAGE_FILE: FieldDef = { prop: 'imageFile', label: 'Image file', widget: 'image' };
const NAME: FieldDef = { prop: 'name', label: 'Name', widget: 'text' };
const KEY: FieldDef = { prop: 'key', label: 'Key', widget: 'mono' };

/** Configuration Studio shows these four rows on every object. */
const AUDIT: GroupDef = {
  title: 'Audit',
  fields: [
    { prop: 'createdTime', label: 'Created', widget: 'ro' },
    { ref: 'createdBy', label: 'Created by', widget: 'ref' },
    { prop: 'lastModifiedDate', label: 'Last modified', widget: 'ro' },
    { ref: 'lastModifiedBy', label: 'Last modified by', widget: 'ref' },
  ],
};

const WIDGET_LAYOUT: GroupDef = {
  title: 'Layout and appearance',
  fields: [
    { prop: 'headerStyle', label: 'Header style', widget: 'enum' },
    { prop: 'borderStyle', label: 'Border style', widget: 'enum' },
    { prop: 'shadow', label: 'Shadow', widget: 'bool' },
    { prop: 'transparency', label: 'Transparency', widget: 'num' },
    { prop: 'columnsSmallScreen', label: 'Columns, small screen', widget: 'num' },
    { prop: 'columnsMediumScreen', label: 'Columns, medium screen', widget: 'num' },
    { prop: 'columnsLargeScreen', label: 'Columns, large screen', widget: 'num' },
    { prop: 'shownOnSmallDisplay', label: 'Shown on small display', widget: 'bool' },
    { prop: 'shownOnMediumDisplay', label: 'Shown on medium display', widget: 'bool' },
    { prop: 'shownOnLargeDisplay', label: 'Shown on large display', widget: 'bool' },
    { prop: 'showToolMenu', label: 'Show tool menu', widget: 'bool' },
    { prop: 'disableSearch', label: 'Disable search', widget: 'bool' },
    { prop: 'visible', label: 'Visible', widget: 'bool' },
    { prop: 'headerColor', label: 'Header colour', widget: 'color' },
    { prop: 'fontColor', label: 'Font colour', widget: 'color' },
    { prop: 'width', label: 'Width', widget: 'num' },
    { prop: 'height', label: 'Height', widget: 'num' },
  ],
};

export function isEmptyValue(v: PropValue | undefined): boolean {
  if (!v) return true;
  if (v.kind === 'list') return !v.items?.length;
  // A structured value with no text of its own (ConditionGroupList …) is
  // still a value: it is shown by its class name.
  if (v.kind === 'unknown' && v.text === '' && v.cls) return false;
  return v.text === '' || v.text === '[]';
}

function isOn(v: PropValue | undefined): boolean {
  return !!v && (v.bool ?? v.text === 'true');
}

/** Marker: "this expression is set and switched on". The expression must be
 *  non-empty and its gate (`useShowExpression` …), when the read returned
 *  one, must be on. null when the read did not return the expression. */
function exprSlot(prop: string, letter: string, name: string): SlotDef {
  const gate = EXPRESSIONS[prop]?.gate;
  return {
    letter, name,
    test: obj => {
      if (!(prop in obj.props)) return null;
      if (isEmptyValue(obj.props[prop])) return false;
      return gate && gate in obj.props ? isOn(obj.props[gate]) : true;
    },
  };
}

const INPUT_BLOCKS = ['showExpression', 'enableExpression', 'defaultExpression', 'refreshExpression'];

/** Shape shared by every *Input class the table does not name. */
function inputInfo(label: string, icon: string, fam: FamilyToken = '--fam-input'): TypeInfo {
  return {
    label, icon, fam, slots: [],
    blocks: INPUT_BLOCKS,
    groups: [
      { title: 'General', fields: [NAME, DESC, KEY] },
      { title: 'Configuration', fields: [
        { prop: 'advancedDefault', label: 'Advanced default', widget: 'bool' },
        { prop: 'readOnly', label: 'Read only', widget: 'bool' },
        { prop: 'propertyHint', label: 'Property hint', widget: 'text' },
        { prop: 'refreshStrategy', label: 'Refresh strategy', widget: 'enum' },
      ] },
      AUDIT,
    ],
  };
}

const enumTail = (v: PropValue | undefined) => (v?.text ?? '').split('.').pop() ?? '';

/** Widget or page part with the common General + Audit groups. */
function simple(label: string, icon: string, fam: FamilyToken, extra: Partial<TypeInfo> = {}): TypeInfo {
  return { label, icon, fam, slots: [], blocks: [], groups: [{ title: 'General', fields: [DESC] }, AUDIT], ...extra };
}

/** Gate of the required expression, when a BMP version has one. The demo
 *  reads return none: every EditField carries `requiredExpression` "true"
 *  (the default) whatever `required` says, so the expression alone is no
 *  evidence that the field is required. */
const REQUIRED_GATE = 'useRequiredExpression';

/** EditPage marker: the required flag, or a switched-on required expression. */
const requiredSlot: SlotDef = {
  letter: 'R', name: 'Required',
  test: obj => {
    const req = obj.props.required, expr = obj.props.requiredExpression;
    if (!req && !expr) return null;
    if (isOn(req)) return true;
    return REQUIRED_GATE in obj.props && isOn(obj.props[REQUIRED_GATE]) && !isEmptyValue(expr);
  },
};

/** Marker: the node carries code in one of its Behaviour blocks. */
const CODE_SLOT: SlotDef = {
  letter: 'C', name: 'Code',
  test: obj => {
    const blocks = blocksFor(typeInfo(obj.type), obj);
    return blocks.some(p => !isEmptyValue(obj.props[p]));
  },
};

/** EditPage (and CreateObjectView → editPage) markers. */
const EDIT_PAGE_SLOTS: SlotDef[] = [
  exprSlot('showExpression', 'S', 'Show'),
  exprSlot('enableExpression', 'E', 'Enable'),
  requiredSlot,
];

/** Scorecard / template markers: carries code, is visible. */
const PAGE_SLOTS: SlotDef[] = [
  CODE_SLOT,
  {
    letter: 'V', name: 'Visible',
    test: obj => {
      const v = obj.props.visibility;
      if (v) return /visible$/i.test(v.text);
      const b = obj.props.visible;
      return b ? (b.bool ?? b.text === 'true') : null;
    },
  },
];

const PAGE_LAYOUT: GroupDef = {
  title: 'Layout and appearance',
  fields: [
    { prop: 'showTopBar', label: 'Show top bar', widget: 'bool' },
    { prop: 'showTitleBar', label: 'Show title bar', widget: 'bool' },
    { prop: 'showTabs', label: 'Show tabs', widget: 'bool' },
    { prop: 'showToolMenu', label: 'Show tool menu', widget: 'bool' },
    { prop: 'showActivityLog', label: 'Show activity log', widget: 'bool' },
    { prop: 'showProcessMenuInHeader', label: 'Process menu in header', widget: 'bool' },
    { prop: 'iconName', label: 'Icon', widget: 'enum' },
    { prop: 'tableIcon', label: 'Table icon', widget: 'enum' },
    { prop: 'visibility', label: 'Visibility', widget: 'enum' },
    { prop: 'shownOnSmallDisplay', label: 'Shown on small display', widget: 'bool' },
    { prop: 'shownOnMediumDisplay', label: 'Shown on medium display', widget: 'bool' },
    { prop: 'shownOnLargeDisplay', label: 'Shown on large display', widget: 'bool' },
    { prop: 'disableSearch', label: 'Disable search', widget: 'bool' },
  ],
};

export const TYPES: Readonly<Record<string, TypeInfo>> = {
  InputView: {
    label: 'Input view', icon: 'k-view', fam: '--fam-layout',
    structure: { via: 'inputSet', depth: 3 },
    slots: [
      exprSlot('showExpression', 'S', 'Show expression'),
      exprSlot('enableExpression', 'E', 'Enable expression'),
      exprSlot('afterExpression', 'A', 'After expression'),
    ],
    blocks: [],
    groups: [
      { title: 'General', fields: [NAME, DESC] },
      { title: 'Input', fields: [
        { ref: 'inputSet', label: 'Input set', widget: 'ref' },
        { prop: 'persistence', label: 'Persistence', widget: 'enum' },
        { prop: 'visibility', label: 'Visibility', widget: 'enum' },
      ] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  },
  InputSet: {
    label: 'Input set', icon: 'k-set', fam: '--fam-structure',
    structure: { depth: 3 },
    slots: [
      exprSlot('showExpression', 'S', 'Show expression'),
      exprSlot('enableExpression', 'E', 'Enable expression'),
      exprSlot('afterExpression', 'A', 'After expression'),
    ],
    blocks: [],
    groups: [{ title: 'General', fields: [NAME, DESC] }, AUDIT],
  },
  ButtonInput: {
    label: 'Button', icon: 'k-button', fam: '--fam-button', slots: [],
    blocks: ['showExpression', 'enableExpression', 'expression', 'initExpression', 'afterExpression', 'refreshExpression'],
    groups: [
      { title: 'General', fields: [NAME, DESC, { prop: 'image', label: 'Image', widget: 'text' }] },
      { title: 'Configuration', fields: [
        { prop: 'buttonType', label: 'Button type', widget: 'enum' },
        { prop: 'refreshStrategy', label: 'Refresh strategy', widget: 'enum' },
        { prop: 'destinationExpression', label: 'Destination expression', widget: 'mono' },
        { prop: 'goDirectly2Child', label: 'Go directly to child', widget: 'bool' },
        { prop: 'enableHint', label: 'Enable hint', widget: 'text' },
      ] },
      { title: 'Action execution feedback', fields: [
        { prop: 'successMessage', label: 'Success message', widget: 'text' },
        { prop: 'failureMessage', label: 'Failure message', widget: 'text' },
        { prop: 'requireDismissal', label: 'Require dismissal', widget: 'bool' },
        { prop: 'longerDuration', label: 'Longer duration', widget: 'bool' },
      ] },
      { title: 'Confirmation dialog', fields: [
        { prop: 'showConfigurationDialog', label: 'Show configuration dialog', widget: 'bool' },
        { prop: 'warningMessage', label: 'Warning message', widget: 'text' },
        { prop: 'confirmButtonText', label: 'Confirm button text', widget: 'text' },
        { prop: 'cancelButtonText', label: 'Cancel button text', widget: 'text' },
      ] },
      AUDIT,
    ],
    qualifier: obj => enumTail(obj.props.buttonType).toUpperCase(),
    // The enum compares by its string value (`ButtonInputType.action`).
    follow: { via: 'actionObject', depth: 1, when: obj => enumTail(obj.props.buttonType).toLowerCase() === 'action' },
  },
  DateInput: {
    ...inputInfo('Date input', 'k-date'),
    groups: [
      { title: 'General', fields: [NAME, DESC, KEY] },
      { title: 'Configuration', fields: [
        { ref: 'dateType', label: 'Date type', widget: 'ref' },
        { prop: 'advancedDefault', label: 'Advanced default', widget: 'bool' },
        { prop: 'overrideDateFormat', label: 'Override date format', widget: 'bool' },
        { prop: 'readOnly', label: 'Read only', widget: 'bool' },
        { prop: 'propertyHint', label: 'Property hint', widget: 'text' },
        { prop: 'refreshStrategy', label: 'Refresh strategy', widget: 'enum' },
      ] },
      AUDIT,
    ],
  },
  EditField: {
    label: 'Edit field', icon: 'k-field', fam: '--fam-input', slots: [],
    blocks: ['showExpression', 'enableExpression', 'requiredExpression', 'defaultExpression'],
    lead: 'mapping',
    settingsFirst: true,
    groups: [
      { title: 'General', fields: [NAME, DESC] },
      { title: 'Field', fields: [
        { prop: 'propertyMapping', label: 'Property', widget: 'mono' },
        { prop: 'required', label: 'Required', widget: 'bool' },
        { prop: 'placeholder', label: 'Placeholder', widget: 'text' },
        { prop: 'propertyHint', label: 'Help text', widget: 'text' },
      ] },
      AUDIT,
    ],
  },
  // ── EditPage: flat list of fields, breaks and info blocks ──────────
  EditPage: {
    label: 'Edit page', icon: 'k-page', fam: '--fam-layout',
    structure: { depth: 1 },
    slots: EDIT_PAGE_SLOTS,
    blocks: ['afterExpression'],
    groups: [
      { title: 'General', fields: [
        { prop: 'pageTitle', label: 'Page title', widget: 'text' }, DESC,
        { prop: 'types', label: 'Creates type', widget: 'ro' },
      ] },
      { title: 'Form', fields: [
        { prop: 'adding', label: 'Adding', widget: 'bool' },
        { prop: 'editing', label: 'Editing', widget: 'bool' },
        { prop: 'allowDraftSave', label: 'Allow draft save', widget: 'bool' },
        { prop: 'refreshOnSubmit', label: 'Refresh on submit', widget: 'bool' },
      ] },
      AUDIT,
    ],
  },
  EditPageBreak: simple('Page break', 'k-pagebreak', '--fam-layout', { divider: 'page' }),
  EditPageColumnBreak: simple('Column break', 'k-colbreak', '--fam-layout', { divider: 'column' }),
  EditPageInfo: simple('Information', 'i-info', '--fam-content', {
    blocks: ['showExpression', 'expression'],
    groups: [
      { title: 'General', fields: [
        { prop: 'label', label: 'Label', widget: 'text' },
        { prop: 'richText', label: 'Rich text', widget: 'mono' }, DESC,
      ] },
      { title: 'Display', fields: [
        { prop: 'infoVisualization', label: 'Visualization', widget: 'enum' },
        { prop: 'extendedReturnType', label: 'Return type', widget: 'enum' },
        { prop: 'propertyHint', label: 'Property hint', widget: 'text' },
      ] },
      AUDIT,
    ],
  }),
  // ── Scorecard: widget → optional sub-item; no tab level ────────────
  Scorecard: {
    label: 'Scorecard', icon: 'k-scorecard', fam: '--fam-layout',
    structure: { depth: 2 },
    slots: PAGE_SLOTS,
    blocks: [],
    groups: [
      { title: 'General', fields: [
        DESC,
        { prop: 'visibleInWebMenu', label: 'Visible in web menu', widget: 'bool' },
        { prop: 'addingSubPagesAllowed', label: 'Sub pages allowed', widget: 'bool' },
        { prop: 'goDirectly2Child', label: 'Go directly to child', widget: 'bool' },
      ] },
      { title: 'Status and period', fields: [
        { prop: 'statusAlgorithm', label: 'Status algorithm', widget: 'enum' },
        { ref: 'statusType', label: 'Status type', widget: 'ref' },
        { prop: 'periodSelectionEnabled', label: 'Period selection', widget: 'enum' },
        { ref: 'periodStorage', label: 'Period storage', widget: 'ref' },
        { prop: 'YTDEnabled', label: 'Year to date', widget: 'enum' },
        { ref: 'yearDef', label: 'Year definition', widget: 'ref' },
      ] },
      AUDIT,
    ],
    layout: PAGE_LAYOUT,
  },
  EnterpriseTemplate: {
    label: 'Enterprise template', icon: 'k-template', fam: '--fam-layout',
    structure: { depth: 2 },
    slots: PAGE_SLOTS,
    blocks: [],
    groups: [
      { title: 'General', fields: [DESC] },
      { title: 'Page', fields: [
        { prop: 'showTopBar', label: 'Show top bar', widget: 'bool' },
        { prop: 'showTitleBar', label: 'Show title bar', widget: 'bool' },
        { prop: 'showTabs', label: 'Show tabs', widget: 'bool' },
      ] },
      AUDIT,
    ],
  },
  CustomVisualization: simple('Custom visualization', 'k-code', '--fam-code', {
    blocks: ['javascript'],
    groups: [
      { title: 'General', fields: [DESC] },
      { title: 'Content', fields: [
        { prop: 'html', label: 'HTML', widget: 'mono' },
        { prop: 'paddingEnabled', label: 'Padding', widget: 'bool' },
      ] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  CustomVisualizationExpression: simple('Visualization expression', 'k-braces', '--fam-code', {
    blocks: ['expression'],
    groups: [{ title: 'General', fields: [DESC, KEY] }, AUDIT],
  }),
  TextElement: simple('Text element', 'k-text', '--fam-content', { layout: WIDGET_LAYOUT }),
  CheckList: simple('Checklist', 'k-checklist', '--fam-structure', {
    groups: [
      { title: 'General', fields: [DESC] },
      { title: 'Status', fields: [
        { prop: 'statusAlgorithm', label: 'Status algorithm', widget: 'enum' },
        { ref: 'statusType', label: 'Status type', widget: 'ref' },
      ] },
      { title: 'Table', fields: [
        { prop: 'tableIcon', label: 'Table icon', widget: 'enum' },
        { prop: 'sortOrder', label: 'Sort order', widget: 'enum' },
        { prop: 'rowCountEnabled', label: 'Row count', widget: 'bool' },
        { prop: 'advancedFiltersEnabled', label: 'Advanced filters', widget: 'bool' },
        { prop: 'openFiltersEnabled', label: 'Open filters', widget: 'bool' },
        { prop: 'tableViewsOptionEnabled', label: 'Table views', widget: 'bool' },
      ] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  Check: simple('Check', 'k-check', '--fam-status'),
  ExtendedTable: simple('Extended table', 'k-table', '--fam-structure', {
    blocks: ['expression'],
    groups: [
      { title: 'General', fields: [DESC] },
      { title: 'Table', fields: [
        { prop: 'enableTableMode', label: 'Table mode', widget: 'bool' },
        { prop: 'enableCardGridMode', label: 'Card grid mode', widget: 'bool' },
        { prop: 'enableTreeGraphMode', label: 'Tree graph mode', widget: 'bool' },
        { prop: 'defaultDisplayMode', label: 'Default display mode', widget: 'enum' },
        { prop: 'rowPerPage', label: 'Rows per page', widget: 'num' },
        { prop: 'paginable', label: 'Paginable', widget: 'bool' },
        { prop: 'inlineReadOnly', label: 'Inline read only', widget: 'bool' },
      ] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  // The image of an image view is picked from the workspace's image files.
  ImageView: simple('Image view', 'k-object', '--fam-layout', { groups: [{ title: 'General', fields: [NAME, DESC, IMAGE_FILE] }, AUDIT] }),
  // Flow: the button → its action object (transport group, edit page …) →
  // that object's children, with the Code marker.
  ActionButton: simple('Action button', 'k-button', '--fam-button', {
    structure: { via: 'actionObject', depth: 1 },
    slots: [CODE_SLOT],
    blocks: ['expression', 'initExpression', 'afterExpression', 'refreshExpression', 'editExpression'],
    groups: [
      { title: 'General', fields: [DESC, { prop: 'buttonText', label: 'Button text', widget: 'text' }, IMAGE_FILE] },
      { title: 'Configuration', fields: [
        { prop: 'actionType', label: 'Action type', widget: 'enum' },
        { prop: 'refreshStrategy', label: 'Refresh strategy', widget: 'enum' },
        { prop: 'displayOnActionMenu', label: 'Show in action menu', widget: 'bool' },
        { prop: 'validateEnabled', label: 'Validate', widget: 'bool' },
        { prop: 'enableHint', label: 'Enable hint', widget: 'text' },
      ] },
      { title: 'Action execution feedback', fields: [
        { prop: 'successMessage', label: 'Success message', widget: 'text' },
        { prop: 'failureMessage', label: 'Failure message', widget: 'text' },
      ] },
      { title: 'Confirmation dialog', fields: [
        { prop: 'showConfigurationDialog', label: 'Show configuration dialog', widget: 'bool' },
        { prop: 'warningMessage', label: 'Warning message', widget: 'text' },
        { prop: 'confirmButtonText', label: 'Confirm button text', widget: 'text' },
        { prop: 'cancelButtonText', label: 'Cancel button text', widget: 'text' },
      ] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  Container: simple('Container', 'k-container', '--fam-structure', {
    groups: [
      { title: 'General', fields: [DESC] },
      { title: 'Container', fields: [{ prop: 'containerMode', label: 'Container mode', widget: 'enum' }] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  Spacer: simple('Spacer', 'k-spacer', '--fam-layout', { divider: 'heading', layout: WIDGET_LAYOUT }),
  DescriptionView: simple('Description view', 'k-desc', '--fam-content', {
    groups: [
      { title: 'General', fields: [DESC] },
      { title: 'Content', fields: [
        { prop: 'viewTypes', label: 'View types', widget: 'ro' },
        { prop: 'inlineReadOnly', label: 'Inline read only', widget: 'bool' },
      ] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  RiskChart: simple('Risk chart', 'k-chart', '--fam-status', {
    groups: [
      { title: 'General', fields: [DESC] },
      { title: 'Chart', fields: [
        { prop: 'chartHeight', label: 'Chart height', widget: 'num' },
        { prop: 'factorType', label: 'Factor type', widget: 'enum' },
        { prop: 'probabilityFrom', label: 'Probability from', widget: 'mono' },
        { prop: 'consequenceFrom', label: 'Consequence from', widget: 'mono' },
        { prop: 'markerText', label: 'Marker text', widget: 'mono' },
        { prop: 'showTooltip', label: 'Show tooltip', widget: 'bool' },
      ] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  RelationshipDiagram: simple('Relationship diagram', 'i-share', '--fam-status', { layout: WIDGET_LAYOUT }),
  // Flow: the view → its EditPage → the page's fields, with the EditPage markers.
  CreateObjectView: simple('Create object view', 'k-create', '--fam-button', {
    structure: { via: 'editPage', depth: 1 },
    slots: EDIT_PAGE_SLOTS,
    groups: [
      { title: 'General', fields: [DESC, { ref: 'editPage', label: 'Edit page', widget: 'ref' }] },
      AUDIT,
    ],
    layout: WIDGET_LAYOUT,
  }),
  // Flow: the group's transports, with the Code marker.
  NotificationTransportGroup: simple('Transport group', 'k-notify', '--fam-button', {
    structure: { depth: 1 },
    slots: [CODE_SLOT],
  }),
  ExtendedTransport: simple('Extended transport', 'k-code', '--fam-code', { blocks: ['expression'] }),
  Label: {
    ...inputInfo('Label', 'k-label', '--fam-content'),
    blocks: [...INPUT_BLOCKS, 'expression'],
    groups: [
      { title: 'General', fields: [NAME, DESC, KEY, { prop: 'textInputType', label: 'Text input type', widget: 'enum' }] },
      { title: 'Information', fields: [{ prop: 'information', label: 'Information', widget: 'text' }] },
      { title: 'Configuration', fields: [
        { prop: 'advancedDefault', label: 'Advanced default', widget: 'bool' },
        { prop: 'recalculateDefaultOnRefresh', label: 'Recalculate default on refresh', widget: 'bool' },
        { prop: 'readOnly', label: 'Read only', widget: 'bool' },
        { prop: 'refreshStrategy', label: 'Refresh strategy', widget: 'enum' },
      ] },
      AUDIT,
    ],
  },
};

const GENERIC: TypeInfo = {
  label: '', icon: 'k-object', fam: '--fam-layout', slots: [], blocks: [],
  groups: [{ title: 'General', fields: [NAME, DESC] }, AUDIT],
};

/** Table entry for a type; unknown types get a generic entry carrying their
 *  own class name as label. `*Input` classes share the input shape. */
export function typeInfo(type: string): TypeInfo {
  // The icon is always the type's shared glyph (lib/object-glyphs.ts), so a row here shows the
  // same icon as the type's badge on the page.
  return { ...tableEntry(type), icon: glyphId(type) };
}

function tableEntry(type: string): TypeInfo {
  const known = Object.hasOwn(TYPES, type) ? TYPES[type] : undefined;
  if (known) return known;
  if (/Input$/.test(type)) return inputInfo(splitWords(type), 'k-field');
  if (/Group$/.test(type)) {
    return { ...GENERIC, label: splitWords(type), icon: 'k-group', fam: '--fam-button', blocks: ['showExpression', 'enableExpression'] };
  }
  // A type without an entry reads as words too (never a raw class name).
  return { ...GENERIC, label: type ? splitWords(type.replace(/^Ce(?=[A-Z])/, '')) : 'Object' };
}

/** Display name of a type, the same everywhere (object window, code
 *  search, Browse, Compare, code links): the table's label, else the class
 *  name in words without the product prefix `Ce`
 *  (`ExtendedMethodConfig` → `Extended method config`,
 *  `CeAssuranceActivity` → `Assurance activity`). */
export function typeLabel(type: string): string {
  if (!type) return 'Object';
  return typeInfo(type).label || splitWords(type.replace(/^Ce(?=[A-Z])/, ''));
}

/** Display name of a property, the same everywhere: the table's label
 *  (expressions, then curated fields), else the name in words
 *  (`firstColorExpression` → `First color expression`). Takes one argument,
 *  so it can be mapped over a list; `propLabelIn` adds loaded captions. */
export function propLabel(prop: string): string {
  return propLabelIn(prop);
}

/** `propLabel` for a property of a loaded object: `labels` are the type's own
 *  captions (accessor → caption), used only where the table has none. A
 *  custom key is a definition's rid, never shown: its name from `summaries`
 *  (rid → {name}), else the loaded caption, else "Custom property". */
export function propLabelIn(
  prop: string,
  labels?: Readonly<Record<string, string>>,
  summaries?: Readonly<Record<string, { name?: string }>>,
): string {
  if (prop === 'name') return 'Name';
  if (prop === 'id') return 'ID';
  const loaded = labels?.[prop];
  if (isCustomKey(prop)) return summaries?.[prop]?.name || loaded || 'Custom property';
  return tableLabel(prop) ?? loaded ?? splitWords(prop);
}

/** Tooltip of a property label: what the code is for (when certain), then
 *  the stored name. */
export function propHelp(prop: string): string {
  const help = Object.hasOwn(EXPRESSIONS, prop) ? EXPRESSIONS[prop].help : undefined;
  const gate = Object.values(EXPRESSIONS).find(e => e.gate === prop);
  const text = help ?? (gate ? `Switches the ${gate.label.toLowerCase()} on or off.` : undefined);
  return text ? `${text} (${prop})` : prop;
}

/** `NumberInput` → `Number input`. */
export function splitWords(s: string): string {
  const spaced = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Properties the curated parts of the pane already show for this type
 *  (excluded from "All properties"). Only names that the object returned. */
export function curatedProps(info: TypeInfo, obj: FullObject): Set<string> {
  const out = new Set<string>(['name']);
  for (const p of blocksFor(info, obj)) {
    out.add(p);
    const gate = EXPRESSIONS[p]?.gate;
    if (gate) out.add(gate);
  }
  for (const g of [...info.groups, ...(info.layout ? [info.layout] : [])]) {
    for (const f of g.fields) if (f.prop && f.prop in obj.props) out.add(f.prop);
  }
  return out;
}

/** Code properties per type that the code index of the current server
 *  found (its `codeProps`), set by a window that has the index at hand.
 *  null: unknown, the table alone decides. */
let indexedCodeProps: Readonly<Record<string, readonly string[]>> | null = null;

export function setIndexedCodeProps(map: Readonly<Record<string, readonly string[]>> | null | undefined): void {
  indexedCodeProps = map ?? null;
}

/** Bodies the index keeps that are not Extended Code. */
const NOT_EC = new Set(['html', 'javascript', 'text', 'longText']);

/** Extended Code properties the index lists for the object's type that hold
 *  code in this read. */
function indexedCode(obj: FullObject): string[] {
  const list = indexedCodeProps && Object.hasOwn(indexedCodeProps, obj.type) ? indexedCodeProps[obj.type] : undefined;
  if (!list) return [];
  return list.filter(p => !NOT_EC.has(p) && obj.props[p]?.kind === 'code' && !isEmptyValue(obj.props[p]));
}

/** Whether the table lists `prop` for `type` as a plain text field. */
export function listsTextField(type: string, prop: string): boolean {
  const info = typeInfo(type);
  return [...info.groups, ...(info.layout ? [info.layout] : [])]
    .some(g => g.fields.some(f => f.prop === prop && f.widget === 'text'));
}

function fieldProps(info: TypeInfo): Set<string> {
  const out = new Set<string>();
  for (const g of [...info.groups, ...(info.layout ? [info.layout] : [])]) for (const f of g.fields) if (f.prop) out.add(f.prop);
  return out;
}

const byExpressionOrder = (a: string, b: string) => expressionOrder(a) - expressionOrder(b) || a.localeCompare(b);

/** The table's own blocks the read returned (types without blocks: every
 *  returned property that holds code). Edit routes follow this list. */
export function tableBlocks(info: TypeInfo, obj: FullObject): string[] {
  if (info.blocks.length) return info.blocks.filter(p => p in obj.props);
  return Object.keys(obj.props)
    .filter(p => obj.props[p].kind === 'code' && !isEmptyValue(obj.props[p]))
    .sort(byExpressionOrder);
}

/** Behaviour blocks drawn for an object: the table's blocks, plus code the
 *  index found on other properties of the type (`ButtonInput.defaultExpression`)
 *  that the table draws nowhere else. */
export function blocksFor(info: TypeInfo, obj: FullObject): string[] {
  const blocks = tableBlocks(info, obj);
  if (!info.blocks.length || !indexedCodeProps) return blocks;
  const fields = fieldProps(info);
  const extra = indexedCode(obj).filter(p => !blocks.includes(p) && !fields.has(p)).sort(byExpressionOrder);
  return extra.length ? [...blocks, ...extra] : blocks;
}

/** Every property whose Extended Code the window reads for "Calls": the
 *  blocks, plus curated fields the index knows to hold code
 *  (`ButtonInput.destinationExpression`). */
export function codePropsFor(info: TypeInfo, obj: FullObject): string[] {
  const blocks = blocksFor(info, obj);
  const more = indexedCode(obj).filter(p => !blocks.includes(p));
  return more.length ? [...blocks, ...more] : blocks;
}

function expressionOrder(prop: string): number {
  const i = Object.keys(EXPRESSIONS).indexOf(prop);
  return i < 0 ? 99 : i;
}

/** Label for a property name from the table (expressions + fields). */
export function tableLabel(prop: string): string | undefined {
  if (Object.hasOwn(EXPRESSIONS, prop)) return EXPRESSIONS[prop].label;
  if (Object.hasOwn(TABLE_LABELS, prop)) return TABLE_LABELS[prop];
  return undefined;
}

const TABLE_LABELS: Record<string, string> = (() => {
  const out: Record<string, string> = Object.create(null);
  const add = (g: GroupDef) => { for (const f of g.fields) if (f.prop && !out[f.prop]) out[f.prop] = f.label; };
  for (const info of Object.values(TYPES)) {
    info.groups.forEach(add);
    if (info.layout) add(info.layout);
  }
  add(WIDGET_LAYOUT);
  Object.assign(out, {
    useShowExpression: 'Use show expression',
    useEnableExpression: 'Use enable expression',
    sortIndex: 'Sort index',
    id: 'ID',
  });
  return out;
})();

/** Relation roles that are audit/ACL plumbing on every object.
 *  `profileMappings` (Scorecard) points at ObjectProfileMapping objects,
 *  which a batched object read cannot read (BMP fails the whole batch). */
export const HIDDEN_ROLES = /^(ownership|createdBy|lastModifiedBy|refresh|profileMappings)$|Accessors$/;

const ROLE_LABELS: Record<string, string> = {
  parent: 'Parent', container: 'Container', inputSet: 'Input set', linkedTo: 'Linked to',
  template: 'Template', dateType: 'Date type', view: 'View', card: 'Card',
};

export function roleLabel(role: string, labels?: Readonly<Record<string, string>>): string {
  return ROLE_LABELS[role] ?? labels?.[role] ?? (/^\d+$/.test(role) ? `Property ${role}` : splitWords(role));
}

export const ROLE_ORDER = ['parent', 'container', 'linkedTo', 'template', 'inputSet'];

/** Custom properties come back keyed by the numeric rid of their property
 *  definition (in `props` and as reference roles). Built-ins never are. */
export function isCustomKey(key: string): boolean {
  return /^\d{6,}$/.test(key);
}

/** Page-like types that are not in TYPES but are not data objects either. */
const PAGE_LIKE = new Set(['Organisation', 'Category', 'Tab', 'View', 'Card', 'InputSet', 'Folder', 'Report', 'ModelPage']);

/** A page element: a type the table draws, an input or group, or a known
 *  page-like container. Never a data object. */
export function isPageElement(type: string): boolean {
  return Object.hasOwn(TYPES, type) || PAGE_LIKE.has(type) || /(Input|Group)$/.test(type);
}

/** Enterprise object classes (CeRiskAssessment, CeIssue …): data objects by
 *  their type, with or without a presenting template. */
export function isEnterpriseType(type: string): boolean {
  return /^Ce[A-Z]/.test(type);
}

/** Data object: decided by its type, never by its values. A page element or
 *  a configuration type stays what it is when someone adds a custom property
 *  to it. A data object is an enterprise class, or any other non-page type
 *  that a template presents (`template` role). Some enterprise instances have
 *  no template at all; they are still data objects. */
export function isDataObject(obj: FullObject | null | undefined): boolean {
  if (!obj?.type || isPageElement(obj.type)) return false;
  return isEnterpriseType(obj.type) || 'template' in obj.references;
}

/** Labels of the divider rows among one parent's children, in order:
 *  page breaks count pages ("Page 2"), column breaks count columns within
 *  the page ("Column 2"), headings show their own name. Content before the
 *  first page break is page 1, so that break starts page 2. */
export function dividerLeads(children: ReadonlyArray<{ rid: string; type: string; name: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  let page = 0;
  let col = 1;
  let content = false;
  for (const c of children) {
    const kind = typeInfo(c.type).divider;
    if (kind === 'page') {
      page = (page || (content ? 1 : 0)) + 1;
      col = 1;
      out[c.rid] = `Page ${page}`;
    } else if (kind === 'column') {
      col++;
      out[c.rid] = `Column ${col}`;
    } else if (kind === 'heading') {
      out[c.rid] = c.name || 'Section';
    } else {
      content = true;
    }
  }
  return out;
}

/** The follow rule that applies to `obj` now, if any. */
export function followRule(obj: FullObject | null | undefined): FollowRule | null {
  if (!obj) return null;
  const rule = typeInfo(obj.type).follow;
  return rule && rule.when(obj) ? rule : null;
}

// ── code search filters: two-level groups ─────────────────────────

/** "Kind of code": groups by purpose; the second level is the properties
 *  with their labels (`propLabel`). One table, next to the labels above. A
 *  property not listed goes to the group whose name pattern fits, else
 *  "Other" (`kindOfProp`). */
export const CODE_KINDS: ReadonlyArray<{ key: string; label: string; props: readonly string[]; pattern?: RegExp }> = [
  { key: 'expressions', label: 'Expressions', props: ['expression', 'firstExpression', 'secondExpression', 'filterExpression', 'markerPlacementExpression', 'variablesExpression'] },
  { key: 'actions', label: 'Actions', props: ['initExpression', 'afterExpression', 'refreshExpression'], pattern: /^(init|after|before|refresh|on)[A-Z]/ },
  { key: 'conditions', label: 'Conditions', props: ['showExpression', 'enableExpression', 'editExpression', 'requiredExpression', 'useExpression'], pattern: /^(show|enable|edit|required|use|visible|readOnly|validate)[A-Z]/ },
  { key: 'defaults', label: 'Defaults', props: ['defaultExpression'], pattern: /^default/ },
  { key: 'navigation', label: 'Navigation', props: ['destinationExpression', 'parentDestinationExpression', 'linkExpression', 'firstLinkExpression', 'secondLinkExpression', 'customNavigationTargetExpressionOnComplete'], pattern: /Link|Destination|Navigation|Target/ },
  { key: 'appearance', label: 'Appearance', props: ['colorExpression', 'backgroundColorExpression', 'firstColorExpression', 'secondColorExpression', 'markerBorderColorExpression'], pattern: /Colou?r|Style|Icon/ },
  { key: 'custom', label: 'Custom visualisation', props: ['html', 'javascript', 'text', 'longText'] },
];
export const OTHER_KIND = { key: 'other', label: 'Other' } as const;

/** The "Kind of code" group of a property. Name patterns are tried in the
 *  table's order (colour and navigation before the generic `Expression`). */
export function kindOfProp(prop: string): string {
  for (const k of CODE_KINDS) if (k.props.includes(prop)) return k.key;
  for (const key of ['appearance', 'navigation', 'actions', 'conditions', 'defaults']) {
    if (CODE_KINDS.find(k => k.key === key)?.pattern?.test(prop)) return key;
  }
  return /Expression$/.test(prop) ? 'expressions' : OTHER_KIND.key;
}

/** "Object type": families; the second level is the real types
 *  (`typeLabel`). Every type is in exactly one family: listed types first,
 *  then name patterns, then "Other" (`familyOfType`). */
export const TYPE_FAMILIES: ReadonlyArray<{ key: string; label: string; types: readonly string[]; pattern?: RegExp }> = [
  { key: 'tables', label: 'Tables', types: ['ExtendedTable', 'FilteredComments', 'CheckList'], pattern: /Table$/ },
  { key: 'charts', label: 'Charts', types: ['CategoryAxisPlotline', 'NumberAxisPlotline'], pattern: /Chart$|Plotline$/ },
  { key: 'inputs', label: 'Inputs and fields', types: ['EditField', 'Label', 'Validation', 'EditPageValidation', 'EditPageInfo', 'InputSet'], pattern: /Input$|Field$/ },
  { key: 'buttons', label: 'Buttons', types: ['ActionButton', 'ButtonInput', 'ButtonGroup'], pattern: /Button/ },
  { key: 'pages', label: 'Pages and views', types: ['EditPage', 'CreateObjectView', 'UserTaskPage', 'InputView', 'ImageView', 'DescriptionView', 'Scorecard', 'EnterpriseTemplate', 'ModelPage'], pattern: /Page$|View$/ },
  { key: 'cards', label: 'Cards', types: ['Card', 'CardPart', 'RelationshipCard'], pattern: /Card/ },
  { key: 'calc', label: 'Calculated and reference properties', types: [], pattern: /MethodConfig$/ },
  { key: 'expressions', label: 'Extended expressions', types: ['ExtendedExpression'] },
  { key: 'notify', label: 'Notifications and transformers', types: ['ExtendedTransport', 'NotificationTransportGroup', 'ExtendedTargetConfig'], pattern: /Transport|TargetConfig/ },
  { key: 'custom', label: 'Custom visualisations', types: ['CustomVisualization', 'CustomVisualizationExpression'], pattern: /^CustomVisualization/ },
  { key: 'text', label: 'Text', types: ['TextElement'] },
];
export const OTHER_FAMILY = { key: 'other', label: 'Other' } as const;

export function familyOfType(type: string): string {
  for (const f of TYPE_FAMILIES) if (f.types.includes(type)) return f.key;
  for (const f of TYPE_FAMILIES) if (f.pattern?.test(type)) return f.key;
  return OTHER_FAMILY.key;
}

export function kindLabel(key: string): string {
  return CODE_KINDS.find(k => k.key === key)?.label ?? OTHER_KIND.label;
}

export function familyLabel(key: string): string {
  return TYPE_FAMILIES.find(f => f.key === key)?.label ?? OTHER_FAMILY.label;
}
