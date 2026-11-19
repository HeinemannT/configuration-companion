import { describe, expect, it } from 'vitest';
import { markSvg, richMarkSvg } from '../companion-mark';

describe('the mark with moods', () => {
  it('keeps the plain mark as it was: the C and two dark dots, no mood parts', () => {
    const plain = markSvg();
    expect(plain).toContain('stroke="#8a3ffc"');
    expect((plain.match(/<circle /g) ?? []).length).toBe(2);
    expect(plain).not.toContain('mk-');
  });

  it('the rich mark has the same C and the same two dots at rest, and the parts the moods show', () => {
    const rich = richMarkSvg();
    const c = /<path d="M22\.25 7\.48[^>]*>/.exec(markSvg())![0];
    expect(rich).toContain(c);
    expect(rich.match(/<circle class="mk-open"[^>]*>/g)).toEqual(['<circle class="mk-open" cx="13" cy="14" r="2" fill="#1c1033"/>', '<circle class="mk-open" cx="18" cy="14" r="2" fill="#1c1033"/>']);
    for (const part of ['mk-body', 'mk-face', 'mk-brows', 'mk-sleep', 'mk-glad', 'mk-squint', 'mk-dizzy', 'mk-zz']) expect(rich).toContain(part);
    // The eyes still sit where setMarkLook moves them.
    expect(rich).toContain('class="mark-look"');
    expect(rich.endsWith('</svg>')).toBe(true);
    expect(richMarkSvg()).toBe(rich);
  });
});
