/**
 * The add palette: which widget types a layout can add, grouped for a picker. Pure data, shared by the
 * Blueprint picker and by Point and tell's vocabulary (what an answer may add).
 */
import { CHART_TYPES } from '../type-registry';

/** Curated add palette — the common, verified-addable widget types grouped for the picker. Display
 *  names are friendly; the key is the BMP className. (A full per-host live-derived palette is a
 *  later refinement — these all add cleanly to a Scorecard/template container.) */
/** Quick-access widgets shown in a "Most used" section at the top of the add picker. A fixed shortlist
 *  (not customizable) — the full PALETTE below still lists every type, so this is a convenience, not the
 *  only path. All verified addable via a bare `_sc.add(<className>)` (incl. CreateObjectView). */
export const MOST_USED: { key: string; name: string }[] = [
  { key: 'InputView', name: 'Input View' },
  { key: 'ExtendedTable', name: 'Extended Table' },
  { key: 'DescriptionView', name: 'Description View' },
  { key: 'TextElement', name: 'Text Element' },
  { key: 'ActionButton', name: 'Action Button' },
  { key: 'CreateObjectView', name: 'Create Object View' },
];

const CHART_NAMES: Record<(typeof CHART_TYPES)[number], string> = {
  BarChart: 'Bar Chart',
  PieChart: 'Pie Chart',
  LineChart: 'Line Chart',
  AreaChart: 'Area Chart',
  WaterfallChart: 'Waterfall Chart',
  BubbleChart: 'Bubble Chart',
  RadarChart: 'Radar Chart',
  TreeChart: 'Tree Chart',
  GanttChart: 'Gantt Chart',
  NetworkChart: 'Network Chart',
  PolarChart: 'Polar Chart',
  BarLineChart: 'Bar & Line Chart',
  RiskChart: 'Risk Chart',
  RiskRadarChart: 'Risk Radar Chart',
};

/** Keep Blueprint creation coverage aligned with the chart types the rest of
 *  Companion can identify, inspect, and edit. A hand-picked chart subset made
 *  live RiskChart cells visible but impossible to add. */
export const CHART_PALETTE = CHART_TYPES.map(key => ({ key, name: CHART_NAMES[key] }));

export const PALETTE: { group: string; items: { key: string; name: string }[] }[] = [
  { group: 'Status', items: [
    { key: 'SimpleStatus', name: 'Simple Status' }, { key: 'Status', name: 'Status' },
    { key: 'FunctionStatus', name: 'Function Status' }, { key: 'Trend', name: 'Trend' } ] },
  { group: 'Charts', items: CHART_PALETTE },
  { group: 'Tables & Lists', items: [
    { key: 'ExtendedTable', name: 'Extended Table' }, { key: 'RiskList', name: 'Risk List' },
    { key: 'CheckList', name: 'Check List' }, { key: 'IssueList', name: 'Issue List' } ] },
  { group: 'Text & Media', items: [
    { key: 'TextElement', name: 'Text Element' }, { key: 'DescriptionView', name: 'Description View' },
    { key: 'ImageView', name: 'Image View' }, { key: 'Spacer', name: 'Spacer' } ] },
  { group: 'Input & Action', items: [
    { key: 'InputView', name: 'Input View' }, { key: 'ActionButton', name: 'Action Button' },
    { key: 'CustomVisualization', name: 'Custom Visualization' }, { key: 'URLView', name: 'URL View' } ] },
];
