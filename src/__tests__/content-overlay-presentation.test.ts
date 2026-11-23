// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ContentState } from '../content-state';
import { createIdentityLabel, updateLabels } from '../content-overlays';
import { typeGlyphSvg } from '../lib/object-glyphs';
import { PAGE_NAV_PRESENTATION } from '../lib/overlay-presentation';
import { getTypeColor } from '../lib/types';

describe('inspect overlay role presentation', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('keeps page navigation compact and semantic after backing-type enrichment', () => {
    const state = new ContentState();
    state.enrichments.set('119', {
      type: 'ExtendedTable',
      businessId: 'risk_register',
      name: 'Risk Register',
    });
    const host = document.createElement('a');
    const label = createIdentityLabel(state, '119', PAGE_NAV_PRESENTATION);
    host.prepend(label);
    document.body.appendChild(host);

    updateLabels(state);

    expect(label.classList.contains('crev-label--inline-start')).toBe(true);
    expect(label.classList.contains('crev-label--compact')).toBe(true);
    expect(label.querySelector('.crev-label-text')?.textContent).toBe('risk_register');
    // The page glyph (the same one a scorecard shows everywhere), not the backing type's.
    const expected = document.createElement('div');
    expected.innerHTML = typeGlyphSvg('Page');
    expect(label.querySelector('svg')?.innerHTML).toBe(expected.querySelector('svg')?.innerHTML);
    expect(typeGlyphSvg('Page')).toBe(typeGlyphSvg('Scorecard'));
    expect(host.style.getPropertyValue('--crev-color')).toBe(getTypeColor('Page'));
    expect(host.style.getPropertyValue('--crev-color')).not.toBe(getTypeColor('ExtendedTable'));
  });
});
