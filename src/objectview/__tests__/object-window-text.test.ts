// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { FullObject, PropValue } from '../../lib/object-read';
import { OBJECT_CHANGE_PROPS_SET, PANE_PROPS } from '../../lib/bmp-client';
import { OBJECT_TEXT_PROPS, PROP_GROUPS } from '../../lib/pane-schema';
import { buildChangesPayload } from '../../lib/pane-edit';
import { textAreaEditor } from '../../lib/property-editors';
import { WindowDraft, editability, readOnlyReason } from '../window/draft';
import { planSave } from '../window/save-plan';

const t = (text: string): PropValue => ({ kind: 'text', text });

function obj(rid: string, type: string, props: Record<string, PropValue>): FullObject {
  return { rid, type, name: 'N', businessId: 'id_1', props: { name: t('N'), id: t('id_1'), ...props }, references: {}, overridden: [] };
}

/** Which type lists which of the nine fields (object-window-table). */
const LISTED: Record<string, string[]> = {
  ButtonInput: ['enableHint', 'successMessage', 'failureMessage', 'warningMessage', 'confirmButtonText', 'cancelButtonText'],
  ActionButton: ['buttonText', 'enableHint', 'successMessage', 'failureMessage', 'warningMessage', 'confirmButtonText', 'cancelButtonText'],
  EditPage: ['pageTitle'],
  EditPageInfo: ['label'],
};

describe('built-in text fields', () => {
  it('each one is editable where the table lists it and the read returned it', () => {
    const seen = new Set<string>();
    for (const [type, props] of Object.entries(LISTED)) {
      for (const p of props) {
        seen.add(p);
        const o = obj('11', type, { [p]: t('Hello') });
        expect(editability(o, p), `${type}.${p}`).toMatchObject({ route: 'props', def: { kind: 'string' } });
        expect(editability(o, p)?.multiline).toBeUndefined();
        // An empty text is editable too.
        expect(editability(obj('11', type, { [p]: t('') }), p)?.route).toBe('props');
      }
    }
    expect([...seen].sort()).toEqual([...OBJECT_TEXT_PROPS].sort());
  });

  it('is read-only on a type that does not list it, or when the read did not return it', () => {
    expect(editability(obj('11', 'Label', { pageTitle: t('x') }), 'pageTitle')).toBeNull();
    expect(editability(obj('11', 'EditPage', { buttonText: t('x') }), 'buttonText')).toBeNull();
    expect(editability(obj('11', 'InputView', { enableHint: t('x') }), 'enableHint')).toBeNull();
    expect(editability(obj('11', 'EditPage', {}), 'pageTitle')).toBeNull();
    expect(editability(obj('11', 'ActionButton', {}), 'buttonText')).toBeNull();
  });

  it('is read-only with markup or line breaks, and when the read is not text', () => {
    const e = (v: PropValue) => editability(obj('11', 'EditPage', { pageTitle: v }), 'pageTitle');
    expect(e(t('<b>Title</b>'))).toBeNull();
    expect(e(t('Line one\nLine two'))).toBeNull();
    expect(e(t('Line one\r\nLine two'))).toBeNull();
    expect(e({ kind: 'code', text: 'a' })).toBeNull();
    expect(e(t('a < b and c > d'))).not.toBeNull();
  });

  it('the fields that stay read-only stay read-only', () => {
    const b = obj('11', 'ButtonInput', { image: t('icon.png'), key: t('k'), information: t('i') });
    for (const p of ['image', 'key', 'information']) expect(editability(b, p)).toBeNull();
    expect(editability(obj('11', 'EditPageInfo', { richText: t('<p>x</p>') }), 'richText')).toBeNull();
    // propertyHint and placeholder stay with EditField only.
    expect(editability(obj('11', 'ButtonInput', { propertyHint: t('x') }), 'propertyHint')).toBeNull();
    expect(editability(obj('11', 'EditField', { propertyHint: t('x'), placeholder: t('y') }), 'placeholder')?.route).toBe('props');
  });

  it('every editable text field is on the write allowlist, and none is in the pane query', () => {
    for (const p of OBJECT_TEXT_PROPS) {
      expect(OBJECT_CHANGE_PROPS_SET.has(p)).toBe(true);
      expect((PANE_PROPS as readonly string[]).includes(p)).toBe(false);
    }
    for (const g of PROP_GROUPS) for (const d of g.props) if (d.kind !== 'text') expect(OBJECT_CHANGE_PROPS_SET.has(d.prop)).toBe(true);
    for (const p of ['key', 'image', 'information', 'richText']) expect(OBJECT_CHANGE_PROPS_SET.has(p)).toBe(false);
  });

  it('saves as a string through APPLY_OBJECT_CHANGES, also an empty one', () => {
    expect(buildChangesPayload({ pageTitle: 'New "title"', label: '' })).toEqual({ pageTitle: 'New "title"', label: '' });
    const r = { '11': obj('11', 'EditPage', { pageTitle: t('Old') }) };
    const d = new WindowDraft();
    d.set('11', 'pageTitle', '', 'Old');
    const [plan] = planSave(d.items(), r);
    expect(plan.steps.map(s => s.step)).toEqual([{ route: 'APPLY_OBJECT_CHANGES', rid: '11', changes: { pageTitle: '' }, resetProps: [] }]);
  });

  it('gives the reason for markup, and none for an editable or unrelated property', () => {
    const page = obj('11', 'EditPage', { pageTitle: t('<b>x</b>'), description: t('<p>y</p>') });
    expect(readOnlyReason(page, 'pageTitle')).toBe('Holds formatted text. Edit it in BMP.');
    expect(readOnlyReason(page, 'description')).toBe('Holds formatted text. Edit it in BMP.');
    expect(readOnlyReason(obj('11', 'EditPage', { pageTitle: t('x') }), 'pageTitle')).toBeNull();
    expect(readOnlyReason(page, 'name')).toBeNull();
    expect(readOnlyReason(obj('11', 'Label', { pageTitle: t('<b>x</b>') }), 'pageTitle')).toBeNull();
  });
});

describe('multi-line description', () => {
  const withText = (text: string) => obj('11', 'ButtonInput', { description: t(text) });

  it('opens in a text area for plain text, also one line and empty; markup stays read-only', () => {
    expect(editability(withText('One\nTwo'), 'description')).toMatchObject({ route: 'props', multiline: true });
    expect(editability(withText('One\r\nTwo'), 'description')).toMatchObject({ route: 'props', multiline: true });
    expect(editability(withText('One line'), 'description')?.multiline).toBe(true);
    expect(editability(withText(''), 'description')?.multiline).toBe(true);
    expect(editability(withText('One\n<b>Two</b>'), 'description')).toBeNull();
  });

  it('the text area grows from 1 to 6 rows, keeps Enter as a line break and commits LF on change', () => {
    const seen: string[] = [];
    const node = textAreaEditor({ value: 'a\r\nb\r\nc', original: 'a\r\nb\r\nc', dirty: false, onChange: v => seen.push(v) });
    document.body.append(node);
    const area = node.querySelector('textarea')!;
    expect(Number(area.rows)).toBe(3);
    area.value = 'a\nb\nc\nd\ne\nf\ng\nh';
    area.dispatchEvent(new Event('input'));
    expect(Number(area.rows)).toBe(6);
    area.value = 'x';
    area.dispatchEvent(new Event('input'));
    expect(Number(area.rows)).toBe(1);
    area.value = 'x\ny';
    area.dispatchEvent(new Event('change'));
    expect(seen).toEqual(['x\ny']);
  });

  it('a stored CRLF text read back as LF is not a change', () => {
    const d = new WindowDraft();
    d.set('11', 'description', 'a\nb', 'a\r\nb');
    expect(d.count()).toBe(0);
    d.set('11', 'description', 'a\nc', 'a\r\nb');
    expect(d.count()).toBe(1);
  });
});
