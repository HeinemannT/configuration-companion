/**
 * The copy scheme shared by badges, the hover card and the editor badge:
 * click = business ID (template ID when known), Shift = RID, Alt = instance
 * ID, Ctrl/Cmd = instance reference. A missing kind copies nothing — it never
 * falls back to another kind.
 */
import { describe, it, expect } from 'vitest';
import { resolveCopyText, resolveCopyKind, getModifier, copyLegend, COPY_TOOLTIP } from '../namespace';

const OBJ = { rid: '6655481628892308703', businessId: '716', templateBusinessId: 'requirement_template', type: 'CeIssue' };

describe('copy scheme', () => {
  describe('getModifier()', () => {
    it('resolves mixed modifiers as Alt, then Ctrl/Cmd, then Shift', () => {
      expect(getModifier({ altKey: true, ctrlKey: true, shiftKey: true } as MouseEvent)).toBe('alt');
      expect(getModifier({ ctrlKey: true, shiftKey: true } as MouseEvent)).toBe('ctrl');
      expect(getModifier({ metaKey: true } as MouseEvent)).toBe('ctrl');
      expect(getModifier({ shiftKey: true } as MouseEvent)).toBe('shift');
      expect(getModifier({} as MouseEvent)).toBe('plain');
    });
  });

  it('plain copies the template ID when there is one, else the ID', () => {
    expect(resolveCopyText(OBJ, 'plain')).toMatchObject({ kind: 'id', text: 'requirement_template', label: 'ID' });
    expect(resolveCopyText({ rid: OBJ.rid, businessId: '716' }, 'plain')).toMatchObject({ text: '716', label: 'ID' });
  });

  it('Shift copies the RID as a string', () => {
    expect(resolveCopyText(OBJ, 'shift')).toMatchObject({ kind: 'rid', text: '6655481628892308703', label: 'RID' });
  });

  it('Alt copies the instance ID when it differs from the ID, else the ID named ID', () => {
    expect(resolveCopyText(OBJ, 'alt')).toMatchObject({ kind: 'instance', text: '716', label: 'Instance ID' });
    expect(resolveCopyText({ rid: OBJ.rid, businessId: '716' }, 'alt')).toMatchObject({ kind: 'id', text: '716', label: 'ID' });
  });

  it('Ctrl copies the instance reference in its ID space', () => {
    expect(resolveCopyText(OBJ, 'ctrl')).toMatchObject({ kind: 'reference', text: 'ceiss.716', label: 'Reference' });
  });

  it('copies nothing for a kind the object has no value for', () => {
    const bare = { rid: '9007199254740993' };
    for (const kind of ['id', 'instance', 'reference'] as const) {
      const choice = resolveCopyKind(bare, kind);
      expect(choice.text).toBe('');
      expect(choice.missing).toMatch(/no/i);
    }
    expect(resolveCopyKind(bare, 'rid').text).toBe('9007199254740993');
  });

  it('documents the same scheme in the tooltip and the legend', () => {
    expect(COPY_TOOLTIP).toBe('Copy ID (Shift: RID; Alt: Instance ID; Ctrl/Cmd: Reference)');
    expect(copyLegend(false)).toEqual([['Click', 'ID'], ['Shift', 'RID'], ['Alt', 'Instance ID'], ['Ctrl', 'Reference']]);
    expect(copyLegend(false, false).map(([k]) => k)).toEqual(['Click', 'Shift', 'Ctrl']);
    expect(copyLegend(true).map(([k]) => k)).toEqual(['Click', 'Shift', 'Option', 'Cmd']);
  });
});
