/**
 * Browse's Here tree when the row facts could not be read: one line that
 * says why, with Retry that reads the tree again; the rows stay.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../../lib/types';
import type { BrowseTree } from '../../../lib/browse-tree';
import { S } from '../../state';
import { BrowseTab } from '../browse-tab';

const PAGE = '7282092580979928955';
const KID = '2184360149894601037';

const tree: BrowseTree = {
  rootRid: PAGE, crumbs: [], presented: null, fallback: false, posts: 3, ms: 90,
  nodes: [
    { rid: PAGE, parent: null, depth: 0, group: 0, type: 'Scorecard', name: 'Administration', businessId: 'adm', kids: 1 },
    { rid: KID, parent: PAGE, depth: 1, group: 0, type: '', name: '', businessId: '', kids: 0 },
  ],
  rowFactsError: { message: 'Failed to fetch', kind: 'network', rows: 1 },
};

describe('Browse: row facts not read', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    S.page = { rid: PAGE };
    S.context = { rid: PAGE, name: 'Administration', type: 'Scorecard' };
    S.connState = { ...S.connState, display: 'connected' };
    S.favoriteEntries = [];
  });
  afterEach(() => vi.useRealTimers());

  it('says why with the connection sentence and Retry asks for the tree again', () => {
    const sent: InspectorMessage[] = [];
    const tab = new BrowseTab(m => { sent.push(m); }, () => {});
    const panel = document.createElement('div');
    panel.className = 'tab-panel active';
    document.body.replaceChildren(panel);
    tab.activate();
    tab.handleMessage({ type: 'BROWSE_TREE_DATA', rid: PAGE, environment: 'p@x', ok: true, tree });
    tab.render(panel);
    expect(panel.querySelectorAll('.bw-row[role="treeitem"]')).toHaveLength(2);
    const note = [...panel.querySelectorAll('.bw-note')].find(n => n.textContent?.includes('Names and markers'))!;
    expect(note.textContent).toContain('The server does not answer.');
    const asked = sent.filter(m => m.type === 'BROWSE_TREE').length;
    note.querySelector<HTMLButtonElement>('[data-act="retry"]')!.click();
    expect(sent.filter(m => m.type === 'BROWSE_TREE').length).toBe(asked + 1);
  });
});
