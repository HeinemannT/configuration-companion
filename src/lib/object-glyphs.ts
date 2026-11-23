/**
 * Object glyphs: the one icon a BMP object type has, everywhere.
 *
 * The in-page badges, the chips, Browse rows, the object window, Code Search and Blueprint all ask
 * this module, so a type never shows a different icon on two surfaces. Each glyph is drawn once, in
 * the interface's own line style (16 px grid, 1.5 px round strokes, no fill; the same language as the
 * `i-*` interface icons and as Configuration Studio's outlined object icons). A row draws it from the
 * sprite (`o-<name>`, see icon-sprite.ts); a badge tile draws the same shape white on the type colour.
 *
 * Colour is not decided here: it comes from getTypeColor (the domain band).
 */

/** Glyph name → SVG shapes on a 16×16 grid, stroked with currentColor. */
const GLYPHS = {
  // Fallbacks
  object: '<rect x="3" y="3" width="10" height="10" rx="2"/>',
  enterprise: '<path d="M8 2.5l5 2.8v5.4l-5 2.8-5-2.8V5.3zM3 5.3l5 2.8 5-2.8M8 8.1v5.4"/>',

  // Organisation and pages
  org: '<rect x="6" y="2.5" width="4" height="3.5" rx=".8"/><rect x="2.5" y="10" width="4" height="3.5" rx=".8"/><rect x="9.5" y="10" width="4" height="3.5" rx=".8"/><path d="M8 6v2M4.5 10V8h7v2"/>',
  scorecard: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 11V8.5M8 11V5.5M10.5 11V7"/>',
  template: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6h11M6 6v7.5"/>',
  dashboard: '<rect x="2.5" y="2.5" width="4.5" height="6" rx="1"/><rect x="9" y="2.5" width="4.5" height="3.5" rx="1"/><rect x="2.5" y="10.5" width="4.5" height="3" rx="1"/><rect x="9" y="8" width="4.5" height="5.5" rx="1"/>',
  folder: '<path d="M2.5 12V4.5a1 1 0 0 1 1-1h3L8 5.5h4.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',

  // Scorecard tree
  strategy: '<circle cx="8" cy="8" r="5.5"/><path d="M10.3 5.7 9 9l-3.3 1.3L7 7z"/>',
  perspective: '<path d="M1.8 8S4 4 8 4s6.2 4 6.2 4-2.2 4-6.2 4-6.2-4-6.2-4z"/><circle cx="8" cy="8" r="1.8"/>',
  theme: '<path d="M8 3l5.5 3L8 9 2.5 6zM2.5 9.5 8 12.5l5.5-3"/>',
  objective: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.4"/>',
  measure: '<path d="M2.9 11.5a5.5 5.5 0 1 1 10.2 0M8 9.5l2.4-3.4"/>',
  action: '<path d="M9 2 3.5 9H8l-1 5 5.5-7H8z"/>',
  risk: '<path d="M8 2.5l6 10.5H2zM8 6.8v3M8 11.5v.1"/>',
  control: '<path d="M8 2.5l4.5 1.6v4c0 2.6-1.8 4.3-4.5 5.4-2.7-1.1-4.5-2.8-4.5-5.4v-4z"/><path d="M6 8l1.5 1.5L10 6.5"/>',
  issue: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 11v.1"/>',
  indicator: '<path d="M2.5 11.5 6 7.5l2.5 2.5 5-5.5M10.5 4.5h3v3"/>',
  tree: '<path d="M3 2.5h4M5 2.5v9M5 7h3M5 11.5h3M10 5.5h3v3h-3zM10 10h3v3h-3z"/>',
  checklist: '<path d="M2.5 4.5l1 1 2-2M2.5 10.5l1 1 2-2M8 4.5h5.5M8 10.5h5.5"/>',
  check: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8.5l2 2 3-4"/>',
  status: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/>',
  approval: '<circle cx="8" cy="8" r="5.5"/><path d="m5.5 8.2 1.8 1.8 3.2-3.8"/>',

  // Layout structure
  container: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke-dasharray="2.5 2"/>',
  tab: '<path d="M1.5 11.5h3V6A1.5 1.5 0 0 1 6 4.5h4A1.5 1.5 0 0 1 11.5 6v5.5h3"/>',
  tabset: '<path d="M1.5 11.5H3v-5A1.5 1.5 0 0 1 4.5 5h2A1.5 1.5 0 0 1 8 6.5v5M8 8V6.5A1.5 1.5 0 0 1 9.5 5h2A1.5 1.5 0 0 1 13 6.5v5h1.5M3 11.5h10"/>',
  spacer: '<path d="M3 8h3M10 8h3"/>',
  pagebreak: '<path d="M2.5 8h2.5M7 8h2M11 8h2.5M6 4.5l2-2 2 2M6 11.5l2 2 2-2"/>',
  colbreak: '<path d="M8 2.5v2.5M8 7v2M8 11v2.5M4.5 6l-2 2 2 2M11.5 6l2 2-2 2"/>',

  // Input surfaces and fields
  view: '<path d="M2.5 4.5h8M2.5 8h4.5M2.5 11.5h3"/><path d="M11.8 7.2l1.8 1.8-3.8 3.8-2.1.3.3-2.1z"/>',
  set: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  page: '<rect x="3.5" y="2.5" width="9" height="11" rx="1.5"/><path d="M6 6h4M6 9h4"/>',
  create: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M8 5.5v5M5.5 8h5"/>',
  form: '<path d="M7 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M11.5 2.5l2 2L9 9l-2.5.5L7 7z"/>',
  field: '<rect x="2.5" y="4.5" width="11" height="7" rx="1.5"/><path d="M5 8h2.5"/>',
  text: '<path d="M3.5 5V4h9v1M8 4v8M6.5 12h3"/>',
  number: '<path d="M6.5 3 5.5 13M10.5 3l-1 10M3.5 6h9M3 10h9"/>',
  date: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>',
  choice: '<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M6 7.3l2 2 2-2"/>',
  bool: '<rect x="2" y="5" width="12" height="6" rx="3"/><circle cx="11" cy="8" r="1.4"/>',
  ref: '<path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.500l-.7.7M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.500l.7-.7"/>',
  list: '<path d="M5.5 4.500h8M5.5 8h8M5.5 11.500h8M2.5 4.500h.01M2.5 8h.01M2.5 11.500h.01"/>',
  label: '<path d="M4 12.5 8 3.5l4 9M5.6 9.500h4.8"/>',
  group: '<path d="M5.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1.500M10.5 3H12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1.5"/>',
  button: '<rect x="2.5" y="5" width="11" height="6" rx="2"/><path d="M5.5 8h5"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.500v3.200M8 5.300v.1"/>',

  // Tables, charts, views
  table: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.500h11M2.5 9.800h11M6.5 6.500V13"/>',
  chart: '<path d="M2.5 13.500h11M4.5 11V8M8 11V4M11.5 11V6.5"/>',
  trend: '<path d="M2.5 2.500v11h11M5 10l2.5-3 2 2 3.5-4.5"/>',
  matrix: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 8h11M8 2.500v11"/>',
  desc: '<path d="M3 4.500h4M3 8h10M3 11.500h7"/>',
  image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7" r="1"/><path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 3"/>',
  file: '<path d="M9 2.500H5A1.5 1.5 0 0 0 3.5 4v8A1.5 1.5 0 0 0 5 13.500h6a1.5 1.5 0 0 0 1.5-1.500V6zM9 2.500V6h3.5"/>',
  html: '<path d="M9 2.500H5A1.5 1.5 0 0 0 3.5 4v8A1.5 1.5 0 0 0 5 13.500h6a1.5 1.5 0 0 0 1.5-1.500V6zM9 2.500V6h3.5"/><path d="M7 8.5 5.8 9.8 7 11M9 8.500l1.2 1.300L9 11"/>',
  globe: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.500c2 2 2 9 0 11M8 2.500c-2 2-2 9 0 11"/>',
  paperclip: '<path d="M12.5 7.5 8 12a2.8 2.8 0 0 1-4-4l5-5a1.9 1.9 0 0 1 2.7 2.700L6.8 10.600a1 1 0 0 1-1.4-1.400L9.5 5"/>',
  comments: '<path d="M3 4.500A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.500v5a1.5 1.5 0 0 1-1.5 1.500H7l-3 2.500V11a1.5 1.5 0 0 1-1-1.500z"/>',

  // Logic, process
  code: '<path d="M6 5 3 8l3 3M10 5l3 3-3 3"/>',
  braces: '<path d="M6 3.500h-.5A1.5 1.5 0 0 0 4 5v1.500A1.5 1.5 0 0 1 2.5 8 1.5 1.5 0 0 1 4 9.500V11a1.5 1.5 0 0 0 1.5 1.500H6M10 3.500h.5A1.5 1.5 0 0 1 12 5v1.500A1.5 1.5 0 0 0 13.5 8a1.5 1.5 0 0 0-1.5 1.500V11a1.5 1.5 0 0 1-1.5 1.500H10"/>',
  notify: '<path d="M4.5 11V7a3.5 3.5 0 0 1 7 0v4l1 1h-9zM6.8 13.500h2.4"/>',
  workflow: '<path d="M3 5h9m-2.5-2.500L12 5 9.5 7.500M13 11H4m2.5-2.500L4 11l2.5 2.5"/>',
  flow: '<rect x="2" y="3" width="4.5" height="3.5" rx=".8"/><rect x="9.5" y="9.5" width="4.5" height="3.5" rx=".8"/><path d="M6.5 4.800H10a1.8 1.8 0 0 1 1.8 1.800v2.9"/>',
  diagram: '<circle cx="4.5" cy="8" r="1.8"/><circle cx="11.5" cy="4.5" r="1.8"/><circle cx="11.5" cy="11.5" r="1.8"/><path d="M6.1 7.200l3.8-1.900M6.1 8.800l3.8 1.9"/>',
  link: '<path d="M6.8 9.200l2.4-2.400M7.2 4.800l.9-.9a2.4 2.4 0 0 1 3.4 3.400l-.9.900M8.8 11.200l-.9.900a2.4 2.4 0 0 1-3.4-3.400l.9-.9"/>',

  // Data, integration and administration (the configuration tree beyond pages)
  column: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6.2 3v10M9.8 3v10"/>',
  cell: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><rect x="5.5" y="5.5" width="5" height="5" rx=".8"/>',
  dataset: '<ellipse cx="8" cy="4.5" rx="5" ry="2"/><path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>',
  source: '<path d="M2.5 8h7M7 5.5 9.5 8 7 10.5"/><path d="M9.5 3.5H12A1.5 1.5 0 0 1 13.5 5v6a1.5 1.5 0 0 1-1.5 1.5H9.5"/>',
  target: '<path d="M6.5 8h7M11 5.5 13.5 8 11 10.5"/><path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6A1.5 1.5 0 0 0 4 12.5h2.5"/>',
  transport: '<path d="M13.5 2.5 7 9M13.5 2.5l-4 11L7 9 2.5 6.500z"/>',
  resource: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0zM8 11.5v2"/>',
  question: '<circle cx="8" cy="8" r="5.5"/><path d="M6.3 6.4a1.8 1.8 0 1 1 2.6 1.600c-.6.3-.9.7-.9 1.300M8 11.300v.1"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.200l2 1.3"/>',
  rule: '<circle cx="4" cy="4" r="1.5"/><circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="6" r="1.5"/><path d="M4 5.5v5M12 7.5c0 2-2.5 2.5-5 2.500H4"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  user: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13c.500-2.5 2.5-3.5 5-3.500s4.5 1 5 3.5"/>',
  role: '<circle cx="6" cy="6" r="2"/><path d="M2.5 12.500c.4-2 1.8-3 3.5-3s3.1 1 3.5 3"/><circle cx="11.5" cy="6.5" r="1.5"/><path d="M11 9.600c1.6 0 2.5.9 2.8 2.4"/>',
  config: '<path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6"/><circle cx="10" cy="5" r="1.5"/><circle cx="6" cy="11" r="1.5"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  color: '<path d="M8 2.5c2.5 3 4 4.8 4 6.800a4 4 0 0 1-8 0c0-2 1.5-3.8 4-6.800z"/>',
  tag: '<path d="M2.5 3.500v4.300l6 6 4.8-4.8-6-6zM5.3 6.300h.01"/>',
  filter: '<path d="M2.5 3.5h11L9.5 8.500v4l-3 1v-5z"/>',
  report: '<path d="M9 2.5H5A1.5 1.5 0 0 0 3.5 4v8A1.5 1.5 0 0 0 5 13.500h6a1.5 1.5 0 0 0 1.5-1.500V6zM9 2.500V6h3.5"/><path d="M6 11.500V9.500M8 11.500V8M10 11.500V10"/>',

  // Enterprise objects, after Configuration Studio's Type management tree
  barrier: '<path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3"/>',
  task: '<path d="M9 2.5H5A1.5 1.5 0 0 0 3.5 4v8A1.5 1.5 0 0 0 5 13.5h6a1.5 1.5 0 0 0 1.5-1.5V6zM9 2.5V6h3.5"/><path d="M6 10l1.3 1.3L10 8.5"/>',
  assessment: '<path d="M9 2.5H5A1.5 1.5 0 0 0 3.5 4v8A1.5 1.5 0 0 0 5 13.5h6a1.5 1.5 0 0 0 1.5-1.5V6zM9 2.5V6h3.5"/><circle cx="7.5" cy="9.5" r="1.6"/><path d="M8.7 10.7 10 12"/>',
  tools: '<path d="M10.5 2.5a3 3 0 0 0-2.8 4.1L2.5 11.8l1.7 1.7 5.2-5.2a3 3 0 0 0 4.1-2.8l-1.8 1.8-1.7-.5-.5-1.7z"/>',
  rosette: '<circle cx="8" cy="6.5" r="4"/><path d="M6.3 6.6l1.2 1.2 2.2-2.5M5.5 9.8l-1 3.7L8 12l3.5 1.5-1-3.7"/>',
  dice: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 5.5h.01M10.5 5.5h.01M8 8h.01M5.5 10.5h.01M10.5 10.5h.01"/>',
  bandage: '<rect x="1.8" y="5.5" width="12.4" height="5" rx="2.5" transform="rotate(-45 8 8)"/><path d="M8 6.6h.01M8 9.4h.01M6.6 8h.01M9.4 8h.01"/>',

  // Seen in Configuration Studio's trees
  squares: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  ruler: '<rect x="1.5" y="5" width="13" height="6" rx="1"/><path d="M4.5 5v2.5M7 5v2M9.5 5v2.5M12 5v2"/>',
  tick: '<path d="M3 8.5 6.5 12 13 4.5"/>',
  gallery: '<rect x="2.5" y="4.5" width="9.5" height="8" rx="1.5"/><path d="M4.5 2.5H12A1.5 1.5 0 0 1 13.5 4v6.5M3.5 11.5 6 9l2 2 1.5-1.5 2 2"/>',
  node: '<circle cx="8" cy="8" r="2"/><path d="M8 2.5V6M8 10v3.5M3.2 5.2l3 1.800M9.8 9l3 1.800M12.8 5.200l-3 1.800M6.2 9l-3 1.8"/>',
  pie: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5V8h5.5"/>',

  // Property objects (value kinds)
  richtext: '<path d="M2.5 4.5v-1h6v1M5.5 3.5v6M4.5 9.5h2M10 7h3.5M8.5 10h5M2.5 12.5h11"/>',
  backref: '<path d="M6 4.5l-3 3 3 3M3 7.5h6.5a3 3 0 0 1 0 6H8"/>',
  function: '<path d="M7.5 3.5H7A1.5 1.5 0 0 0 5.5 5v7A1.5 1.5 0 0 1 4 13.5h-.5M3.5 8h4M9.5 8.5l4 5M13.5 8.5l-4 5"/>',
  token: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7 13 3M10.5 5.5 12 7M12 4l1.5 1.5"/>',
  progress: '<rect x="2" y="6" width="12" height="4" rx="2"/><path d="M4.5 8h4"/>',
} as const;

export type GlyphName = keyof typeof GLYPHS;

/** BMP type → glyph. A type that is not listed falls to the family rules below. */
const TYPE_GLYPH: Record<string, GlyphName> = {
  // Organisation and pages
  Organisation: 'org',
  Page: 'squares', Scorecard: 'squares', ModelPage: 'squares',
  EnterpriseTemplate: 'template',
  Dashboard: 'dashboard', PowerBi: 'dashboard',
  DashboardFolder: 'folder', ExternalResourcesView: 'folder', LogFolder: 'folder',
  // Scorecard tree
  Strategy: 'strategy', Perspective: 'squares', Theme: 'theme',
  Objective: 'objective', StrategicObjective: 'list',
  Measure: 'ruler', Kpi: 'ruler',
  Action: 'strategy', Risk: 'risk', Control: 'control', Issue: 'page', Incident: 'issue', CeIncident: 'issue',
  Indicator: 'ruler', Trend: 'trend', LineChart: 'trend', AreaChart: 'trend', PieChart: 'pie',
  TaskList: 'checklist', CheckList: 'checklist', Check: 'check',
  RiskList: 'table', IndicatorList: 'table', Function: 'function',
  StatusType: 'status', Status: 'status', SimpleStatus: 'status', FunctionStatus: 'status',
  ObjectApproval: 'approval', ObjectClassification: 'list',
  // Layout structure
  Container: 'container', ButtonContainer: 'container', Section: 'container',
  TabSet: 'tabset', Tab: 'tab',
  Spacer: 'spacer', EditPageBreak: 'pagebreak', EditPageColumnBreak: 'colbreak',
  // Input surfaces
  InputView: 'view', InputSet: 'set', EditPage: 'page', CreateObjectView: 'create',
  // Input fields
  TextInput: 'text', NumberInput: 'number', DateInput: 'date', ChoiceInput: 'choice',
  BooleanInput: 'bool', ReferenceInput: 'ref', ListInput: 'list', Label: 'label',
  ButtonInput: 'button', ActionButton: 'button', EditPageButton: 'button', ButtonGroup: 'group',
  EditField: 'field', EditPageInfo: 'info', Validation: 'check', EditPageValidation: 'check',
  // Tables and lists
  FilteredComments: 'comments', LocalComments: 'comments', AttachmentList: 'paperclip',
  SpreadsheetView: 'table', ReportsList: 'table',
  // Charts and views
  RiskChart: 'matrix', StandardChart: 'chart', RiskRadarChart: 'chart',
  DescriptionView: 'info', TextElement: 'text', ImageView: 'image', PdfView: 'file', URLView: 'globe',
  CustomVisualization: 'gallery', CustomVisualizationExpression: 'braces', DashboardHTML: 'html',
  // Logic and process
  ExtendedCode: 'code', ExtendedExpression: 'braces', ExtendedTransport: 'code',
  NotificationTransportGroup: 'notify', Workflow: 'workflow',
  BPMNView: 'flow', HappyPathViewForProcessReference: 'flow', ProcessLandscapeView: 'flow',
  FlowProject: 'flow', FlowProjectGroup: 'flow', TransformerSchedule: 'flow',
  RelationshipDiagram: 'diagram', LinkMap: 'diagram', BowtieDiagram: 'diagram',
  WebChildReference: 'link',
  // Enterprise objects with an icon of their own in Configuration Studio (the rest keep the cube)
  CeControlMeasure: 'barrier', ControlMeasure: 'barrier',
  CeTask: 'task', CeRiskAssessment: 'assessment', RiskAssessment: 'assessment',
  CeService: 'tools', CeComplianceRequirement: 'page', CePolicy: 'control', Policy: 'control',
  CeProcedure: 'rule', Procedure: 'rule', CeVendor: 'user', CeIssue: 'page',
  CeAttachment: 'paperclip', CeAssuranceActivity: 'rosette', CeComment: 'comments',
  CeAsset: 'dataset', Asset: 'dataset', CeWorkflow: 'workflow', CeQuestionnaire: 'question', CeIndicator: 'indicator',
  TreatmentActivity: 'bandage', Scenario: 'dice', Consequence: 'action', RiskEvent: 'risk',
  Audit: 'enterprise', LockPolicy: 'lock', Group: 'role',
  // Property objects: one glyph per value kind; a historical property shows the same glyph
  SystemMethodConfig: 'config',
  TextMethodConfig: 'text', HistoricalTextMethodConfig: 'text',
  RichTextMethodConfig: 'richtext', HistoricalRichTextMethodConfig: 'richtext',
  BooleanMethodConfig: 'bool', HistoricalBooleanMethodConfig: 'bool',
  NumberMethodConfig: 'number', HistoricalNumberMethodConfig: 'number',
  DateMethodConfig: 'date', HistoricalDateMethodConfig: 'date',
  UrlMethodConfig: 'globe',
  ListMethodConfig: 'list', HistoricalListMethodConfig: 'list',
  TagMethodConfig: 'tag',
  ReferenceMethodConfig: 'ref', HistoricalReferenceMethodConfig: 'ref',
  ReverseReferenceMethodConfig: 'backref',
  ExtendedMethodConfig: 'braces', FileMethodConfig: 'file', TokenMethodConfig: 'token',
  FunctionMethodConfig: 'function', NodeTypeFunctionMethodConfig: 'function',
  HistoricalProgressMethodConfig: 'progress', HistoricalStatusMethodConfig: 'status',
  // The configuration tree beyond pages
  User: 'user', UserMenu: 'user', Role: 'role', RoleAssignment: 'role',
  Task: 'tick', Milestone: 'date', Project: 'checklist', Program: 'checklist', ActionPlan: 'checklist',
  Metric: 'measure', Aggregation: 'config', Tag: 'tag', Chip: 'tag', TableFilter: 'filter',
  Comment: 'comments', Card: 'page', CardPart: 'page', View: 'template', TopBar: 'template', BreadCrumb: 'desc',
  PageTitle: 'text', PageLogo: 'image', Presentation: 'image', Spreadsheet: 'table', Datagrid: 'table',
  DatePicker: 'date', YearDef: 'date', Scope: 'clock', Chatbot: 'comments', TranslationFile: 'file',
  Book: 'folder', BusinessPackage: 'folder', BusinessApplication: 'scorecard', DashboardSet: 'dashboard',
  HomeAndInfo: 'info', InformationElement: 'info', Query: 'dataset', DataSource: 'dataset',
  Distribution: 'transport', EventListener: 'notify', EventTrigger: 'notify', Approval: 'approval', ApprovalSetup: 'approval',
  ExtendedFunction: 'braces', TableFunction: 'braces', FunctionExpression: 'braces', QueryExpression: 'braces',
  NodeType: 'node', Node: 'node', OrganizationTree: 'org', TreeTableChildren: 'tree',
};

/** Families: types BMP names by what they are. First match wins. */
const FAMILY: ReadonlyArray<[RegExp, GlyphName]> = [
  [/^Ce[A-Z]/, 'enterprise'],
  [/MethodConfig$/, 'braces'],
  [/(Source|Resource)Config$|SourceTypeResolving/, 'source'],
  [/TargetConfig$/, 'target'],
  [/Transport$/, 'transport'],
  [/Dataset$/, 'dataset'],
  [/Question$/, 'question'],
  [/Col(umn)?(Set|Widths?)?$/, 'column'],
  [/Entry$|^ListPropertySet/, 'cell'],
  [/Schedule[r]?$/, 'clock'],
  [/Period|Year$/, 'date'],
  [/^Organi[sz]ation/, 'org'],
  [/^Role|DelegationRule$/, 'role'],
  [/^(User|Group)(Root)?$/, 'user'],
  [/^Access|Authentication$|Decryption$/, 'lock'],
  [/Rule$/, 'rule'],
  [/^BPMN|^Process|^HappyPath|UserTask|ViewOverlay|^Flow/, 'flow'],
  [/^Risk/, 'risk'],
  [/Notif|Reminder|^BusinessEvent/, 'notify'],
  [/Search/, 'search'],
  [/Color|Gradient/, 'color'],
  [/Drill$/, 'tree'],
  [/Report/, 'report'],
  [/Shortcut$|^Url|^Link/, 'link'],
  [/Attachment/, 'paperclip'],
  [/Relationship/, 'diagram'],
  [/Plotline$/, 'chart'],
  [/Log$/, 'list'],
  [/Root$|Category$/, 'folder'],
  [/Resource$|Endpoint|^API/, 'resource'],
  [/Config(uration)?(Object)?$|Settings$/, 'config'],
  [/Variable$/, 'field'],
  [/Filter$/, 'filter'],
  [/RiskFactor$/, 'risk'],
  [/AccessProfile$/, 'lock'],
  [/Matrix$/, 'matrix'],
  [/Tab$/, 'tab'],
  [/Query$/, 'dataset'],
  [/Connection$/, 'resource'],
  [/TableReference$/, 'table'],
  [/(Form|Enrollment|Enrollments|FormResponses|FormPage|FormSchedule|FormDistributionList)s?$|Form[A-Z]/, 'form'],
  [/Table(View|Pivot)?$|TableQueryView$/, 'table'],
  [/Chart$/, 'chart'],
  [/Diagram$/, 'diagram'],
  [/List$/, 'table'],
  [/Input$/, 'field'],
  [/Group$/, 'group'],
  [/Button$/, 'button'],
  [/Status$/, 'status'],
  [/Folder$/, 'folder'],
];

/** The glyph of a type: its own, else its family's, else the plain object. */
export function glyphFor(type?: string): GlyphName {
  if (!type) return 'object';
  if (Object.hasOwn(TYPE_GLYPH, type)) return TYPE_GLYPH[type];
  for (const [pattern, glyph] of FAMILY) if (pattern.test(type)) return glyph;
  return 'object';
}

/** True when the type has a glyph of its own or of its family (not the plain object). */
export function hasGlyph(type?: string): boolean {
  return glyphFor(type) !== 'object';
}

/** Sprite id of a type's glyph, for the DOM kit's icon() (rows, headers). */
export function glyphId(type?: string): string {
  return `o-${glyphFor(type)}`;
}

/** A glyph as a standalone SVG string (badge tiles, Blueprint cells). Thin lines vanish at
 *  12 px on a coloured tile, so the stroke is a little heavier there than in a 16 px row. */
export function glyphSvg(name: GlyphName, size = 12, stroke = 1.7): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${GLYPHS[name]}</svg>`;
}

/** The glyph of a type as an SVG string. */
export function typeGlyphSvg(type?: string, size = 12): string {
  return glyphSvg(glyphFor(type), size);
}

/** Every glyph as a sprite symbol (`o-<name>`), for icon-sprite.ts. */
export const GLYPH_SYMBOLS: string = (Object.keys(GLYPHS) as GlyphName[])
  .map(name => `<symbol id="o-${name}" viewBox="0 0 16 16">${GLYPHS[name]}</symbol>`)
  .join('\n');

export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];
