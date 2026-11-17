// @vitest-environment happy-dom
/**
 * The badge card's one hint row: "Alt Instance ID" only when the card has an
 * Instance ID row and the row still fits on one line; else Click · Shift · Ctrl.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildObjectCard, fitCardLegend } from '../object-card';

const withInstance = () => buildObjectCard({ name: 'Issue', type: 'CeIssue', rid: '124', businessId: '716', templateBusinessId: 'issue_tpl', color: '#b28600', showCopyLegend: true });

function laidOut(card: HTMLElement, client: number, scroll: number): HTMLElement {
  document.body.replaceChildren(card);
  const row = card.querySelector<HTMLElement>('.crev-tt-legend')!;
  Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => client });
  Object.defineProperty(row, 'scrollWidth', { configurable: true, get: () => (row.querySelector('.crev-tt-lg--instance') ? scroll : client) });
  return row;
}

describe('badge card hint row', () => {
  it('keeps Alt Instance ID while the row fits', () => {
    const card = withInstance();
    const row = laidOut(card, 292, 280);
    fitCardLegend(card);
    expect(row.textContent).toBe('ClickIDShiftRIDAltInstance IDCtrlReference');
  });

  it('drops it when the row would overflow, leaving Click · Shift · Ctrl', () => {
    const card = withInstance();
    const row = laidOut(card, 292, 310);
    fitCardLegend(card);
    expect(row.textContent).toBe('ClickIDShiftRIDCtrlReference');
    expect(card.querySelectorAll('.crev-tt-legend')).toHaveLength(1);
  });

  it('a card without an Instance ID row never shows it', () => {
    const card = buildObjectCard({ name: 'Risks', type: 'ExtendedTable', rid: '123', businessId: 'risks', color: '#fa4d56', showCopyLegend: true });
    expect(card.querySelector('.crev-tt-legend')?.textContent).toBe('ClickIDShiftRIDCtrlReference');
  });

  it('the row cannot wrap or paint outside the card', () => {
    const css = readFileSync('src/content-overlay.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.crev-tt-legend\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('flex-wrap: nowrap');
    expect(rule).toContain('overflow: hidden');
    expect(rule).toContain('white-space: nowrap');
  });
});
