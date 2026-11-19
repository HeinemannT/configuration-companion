/**
 * One page for the Point and tell tests: a scorecard with two tabs.
 *
 *   Overview   [ Col 6 container: table "Open risks" (4 cols) | pie "By status" (2 cols) ]
 *              [ Col 6 container "Notes": text "Info" (3 cols)                               ]
 *              [ ActionButton "New risk" ][ ActionButton "Export" ]   (1 col each, own row)
 *   Details    [ DescriptionView "Details" ]                           (not on screen)
 *
 * Rectangles are page coordinates of a 1000 px wide content area starting at x = 100.
 */
import type { LModel, LNode } from '../../layout/types';
import type { PtTarget } from '../hit';
import type { PtScene } from '../resolve';

export const widget = (id: string, className: string, L: number, name = id, extra: Partial<LNode> = {}): LNode =>
  ({ id, kind: 'widget', className, name, cols: { L }, children: [], ...extra });
export const container = (id: string, L: number, children: LNode[], name = id): LNode =>
  ({ id, kind: 'container', className: 'Container', name, cols: { L }, children });
export const tab = (id: string, name: string, children: LNode[]): LNode =>
  ({ id, kind: 'tab', className: 'Tab', name, tabsetId: 'ts', cols: { L: 6 }, children });

export function fixtureModel(): LModel {
  return {
    pageId: 'sc_op_risk', pageRid: '7282092580979928955', pageName: 'Operational Risk', pageClass: 'Scorecard',
    tabsetId: 'ts', target: 'template', hasTemplate: true,
    tabs: [
      tab('tab_overview', 'Overview', [
        container('cont_top', 6, [
          widget('tbl_open_risks', 'ExtendedTable', 4, 'Open risks', { rid: '1000000000000000001' }),
          widget('chart_by_status', 'PieChart', 2, 'By status', { height: 200 }),
        ], 'Col 6'),
        container('cont_notes', 6, [widget('txt_info', 'TextElement', 3, 'Info')], 'Notes'),
        widget('btn_new_risk', 'ActionButton', 1, 'New risk', { style: { headerColorBid: 'blue', shadow: true } }),
        widget('btn_export', 'ActionButton', 1, 'Export'),
      ]),
      tab('tab_details', 'Details', [widget('dv_details', 'DescriptionView', 6, 'Details')]),
    ],
  };
}

const t = (id: string, kind: PtTarget['kind'], left: number, top: number, width: number, height: number): PtTarget =>
  ({ id, kind, rect: { left, top, width, height } });

export function fixtureScene(model = fixtureModel()): PtScene {
  return {
    model,
    liveTabId: 'tab_overview',
    targets: [
      t('cont_top', 'container', 100, 100, 1000, 200),
      t('tbl_open_risks', 'widget', 100, 100, 666, 200),
      t('chart_by_status', 'widget', 766, 100, 334, 200),
      t('cont_notes', 'container', 100, 320, 1000, 100),
      t('txt_info', 'widget', 100, 320, 500, 100),
      t('btn_new_risk', 'widget', 100, 440, 166, 40),
      t('btn_export', 'widget', 266, 440, 166, 40),
    ],
    pills: [t('tab_overview', 'tab', 100, 50, 80, 30), t('tab_details', 'tab', 190, 50, 80, 30)],
  };
}
