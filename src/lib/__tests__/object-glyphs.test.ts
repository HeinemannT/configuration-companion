/**
 * @vitest-environment happy-dom
 *
 * One icon per BMP object type, on every surface: the badge tile, the rows of Browse and the
 * object window (typeInfo), and Blueprint all resolve through lib/object-glyphs.ts.
 */
import { describe, expect, it } from 'vitest';
import { GLYPH_NAMES, GLYPH_SYMBOLS, glyphFor, glyphId, glyphSvg, typeGlyphSvg } from '../object-glyphs';
import { typeIcon } from '../type-badge';
import { typeInfo } from '../object-window-table';
import { ICON_SPRITE } from '../icon-sprite';
import { typeIcon as blueprintIcon } from '../../content-blueprint/result';

/** Every object type that had a badge icon before the shared set: none may fall to the plain object. */
const KNOWN_TYPES = [
  'Action', 'ActionButton', 'ActionPlanTable', 'ActivityLogTable', 'AnsweredReportFormEnrollment',
  'AttachmentList', 'BPMNModelTable', 'BPMNView', 'BooleanInput', 'BowtieDiagram', 'ButtonContainer',
  'ButtonGroup', 'ButtonInput', 'CeAsset', 'CeAssuranceActivity', 'CeComplianceRequirement',
  'CeControlMeasure', 'CeIncident', 'CeIndicator', 'CeIssue', 'CePreScreening', 'CeProcedure',
  'CeQuestionnaire', 'CeRegulation', 'CeRiskAssessment', 'CeService', 'CeTIA', 'CeTask', 'CeWorkflow',
  'CheckList', 'ChoiceInput', 'Container', 'ContinuousForm', 'Control', 'CreateObjectView',
  'CustomVisualization', 'CustomVisualizationExpression', 'Dashboard', 'DashboardFolder', 'DashboardHTML',
  'DataTable', 'DataTableView', 'DatasetTableQueryView', 'DateInput', 'DescriptionView', 'EPMForm',
  'EditField', 'EditPage', 'EditPageBreak', 'EditPageButton', 'EditPageColumnBreak', 'EditPageInfo',
  'EditPageValidation', 'Enrollment', 'Enrollments', 'EnterpriseTemplate', 'ExtendedCode',
  'ExtendedExpression', 'ExtendedTable', 'ExtendedTransport', 'ExternalResourcesView', 'FilterTable',
  'FilteredComments', 'FlowProject', 'FlowProjectGroup', 'FormResponses', 'FormSchedule', 'Function',
  'FunctionStatus', 'HappyPathViewForProcessReference', 'ImageView', 'IncidentList', 'Indicator',
  'IndicatorList', 'InputSet', 'InputView', 'Issue', 'IssueList', 'Kpi', 'Label', 'LinkMap', 'ListInput',
  'LocalComments', 'LogFolder', 'Measure', 'ModelPage', 'NodeInputTable', 'NumberInput', 'ObjectApproval',
  'ObjectClassification', 'Objective', 'Organisation', 'Page', 'PdfView', 'PeriodicFormPage', 'Perspective',
  'PolicyAssetList', 'PowerBi', 'ProcessIncidentTable', 'ProcessInstanceTable', 'ProcessLandscapeView',
  'ProcessStatisticsTable', 'ProcessTable', 'ReferenceInput', 'RelationshipDiagram', 'ReportFormEnrollment',
  'ReportFormEnrollments', 'ReportForms', 'ReportTable', 'ReportsList', 'Risk', 'RiskAssessmentTable',
  'RiskChart', 'RiskEventList', 'RiskList', 'RiskRadarChart', 'ScenarioTable', 'ScheduledForm',
  'ScheduledFormDistributionList', 'ScheduledFormPage', 'Scorecard', 'Section', 'ShortcutList',
  'SimpleStatus', 'Spacer', 'SpreadsheetView', 'StandardChart', 'StandardTable', 'Status', 'StatusType',
  'StrategicObjective', 'Strategy', 'Tab', 'TabSet', 'TablePivot', 'TableView', 'TaskFormEnrollment',
  'TaskList', 'TextElement', 'TextInput', 'Theme', 'TransformerSchedule', 'TreatmentList', 'TreeTable',
  'Trend', 'URLView', 'UserTaskInstanceTable', 'Validation', 'ViewCacheStatusTable', 'WebChildReference',
  'Workflow',
];

describe('object glyphs', () => {
  it('gives every known type a glyph of its own or of its family', () => {
    expect(KNOWN_TYPES.filter(t => glyphFor(t) === 'object')).toEqual([]);
  });

  it.each(['Scorecard', 'InputView', 'InputSet', 'ExtendedTable', 'Tab', 'CeAsset', 'BarChart', 'ActionPlanTable', 'SomethingNew'])(
    '%s shows the same glyph in its badge, its row and Blueprint', (type) => {
      const svg = typeGlyphSvg(type);
      expect(typeInfo(type).icon).toBe(glyphId(type));
      if (type !== 'BarChart') expect(typeIcon(type)).toBe(svg);
      const bp = blueprintIcon(type);
      if (glyphFor(type) !== 'object') expect(bp).toBe(svg);
      else expect(bp).toBeNull();
    });

  it('falls back by family, then to the plain object', () => {
    expect(glyphFor('NewKindOfTable')).toBe('table');
    expect(glyphFor('SomeChart')).toBe('chart');
    expect(glyphFor('CeSomething')).toBe('enterprise');
    expect(glyphFor('SomethingNew')).toBe('object');
    // The configuration tree beyond pages: datasets, sources and targets, transports, rules.
    expect(glyphFor('NodeDataset')).toBe('dataset');
    expect(glyphFor('SqlSourceConfig')).toBe('source');
    expect(glyphFor('SqlTargetConfig')).toBe('target');
    expect(glyphFor('NotifyTransport')).toBe('transport');
    expect(glyphFor('ConditionRule')).toBe('rule');
    expect(glyphFor('PropertyRoot')).toBe('folder');
  });

  it('follows Configuration Studio where its icon says something specific', () => {
    expect(glyphFor('Scorecard')).toBe('squares');
    expect(glyphFor('Kpi')).toBe('ruler');
    expect(glyphFor('DescriptionView')).toBe('info');
    expect(glyphFor('PieChart')).toBe('pie');
    expect(glyphFor('CeControlMeasure')).toBe('barrier');
    expect(glyphFor('CeTask')).toBe('task');
    expect(glyphFor('CeRegulation')).toBe('enterprise');
    // Property objects: one glyph per value kind, shared by the historical variant.
    expect(glyphFor('HistoricalNumberMethodConfig')).toBe(glyphFor('NumberMethodConfig'));
    expect(glyphFor('SomeFutureMethodConfig')).toBe('braces');
    expect(glyphFor(undefined)).toBe('object');
    expect(typeIcon('BarChart')).toBe(glyphSvg('chart'));
    expect(typeIcon('RiskChart')).toBe(glyphSvg('matrix'));
  });

  it('puts every glyph in the sprite once, and each one is well-formed', () => {
    for (const name of GLYPH_NAMES) {
      expect(ICON_SPRITE.split(`id="o-${name}"`).length).toBe(2);
      const host = document.createElement('div');
      host.innerHTML = glyphSvg(name);
      expect(host.querySelector('svg')?.children.length).toBeGreaterThan(0);
    }
    expect(GLYPH_SYMBOLS).not.toMatch(/NaN|undefined/);
  });
});
