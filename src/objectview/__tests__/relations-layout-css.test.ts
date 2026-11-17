/**
 * The relation rows of the object window (Relations, Used by, Applied to)
 * share their columns: no track is sized by the row's own content, so the
 * type and the ID start at the same x in every row.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/objectview/window/window.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Declarations of every rule whose selector list contains `selector` exactly. */
const rules = (selector: string): string[] => css.split('}')
  .filter(r => r.split('{')[0].split(',').map(s => s.trim()).includes(selector))
  .map(r => r.split('{').at(-1) ?? '');
const columns = (decl: string): string => /grid-template-columns:\s*([^;]+)/.exec(decl)?.[1].trim() ?? '';

describe('object window relation rows', () => {
  it('use content-independent column tracks at every width', () => {
    const tracks = rules('.ow-rel').map(columns).filter(Boolean);
    expect(tracks.length).toBeGreaterThanOrEqual(2); // normal and narrow window
    for (const t of tracks) {
      expect(t).not.toMatch(/fit-content|auto|min-content|max-content/);
      expect(t.startsWith('minmax(0, 1fr)')).toBe(true);
    }
    // Normal width: name · fixed type column · ID share.
    expect(tracks[0]).toMatch(/^minmax\(0, 1fr\) \d+px minmax\(0, \d+%\)$/);
  });

  it('left-align the ID across its column, ellipsis on overflow, copy button at the end', () => {
    const ri = rules('.ow-ri').join(';');
    expect(ri).toContain('justify-self: stretch');
    expect(ri).not.toContain('justify-self: end');
    const id = rules('.ow-ri > .ow-sel').join(';');
    expect(id).toContain('text-overflow: ellipsis');
    expect(id).toContain('text-align: left');
    expect(id).toContain('min-width: 0');
    expect(rules('.ow-ri > .ui-ibtn').join(';')).toContain('flex: none');
    const type = rules('.ow-rel .rt').join(';');
    expect(type).toContain('text-overflow: ellipsis');
  });
});
