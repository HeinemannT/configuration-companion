/**
 * Window launcher handler — object view.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { openObjectViewWindow } from '../objectview-launcher';

register('OPEN_OBJECT_VIEW', (msg, _respond, meta) => {
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 400 ? v : undefined);
  const from = msg.from && typeof msg.from.rid === 'string' && /^-?\d{1,20}$/.test(msg.from.rid)
    ? { rid: msg.from.rid, ...(typeof msg.from.line === 'number' && Number.isFinite(msg.from.line) ? { line: Math.floor(msg.from.line) } : {}) }
    : undefined;
  const focus = msg.focus && typeof msg.focus.prop === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(msg.focus.prop)
    && Number.isSafeInteger(msg.focus.line) && msg.focus.line > 0 ? { prop: msg.focus.prop, line: msg.focus.line } : undefined;
  const o = msg.origin;
  const origin = o && o.kind === 'search' && str(o.label) ? {
    kind: 'search' as const, label: o.label.slice(0, 200), mode: o.mode === 'refs' ? 'refs' as const : 'text' as const,
    ...(str(o.query) ? { query: o.query } : {}),
  } : undefined;
  const d = msg.draft;
  const draft = d && typeof d.prop === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(d.prop) && typeof d.value === 'string' && d.value.length <= 4000 ? { prop: d.prop, value: d.value } : undefined;
  void openObjectViewWindow(msg.rid, { tabId: meta.senderTabId, windowId: meta.panelWindowId },
    { name: str(msg.name), ...(draft ? { draft } : {}), type: str(msg.objectType), businessId: str(msg.businessId), ...(msg.reveal === true ? { reveal: true } : {}), ...(from ? { from } : {}),
      ...(focus ? { focus } : {}), ...(origin ? { origin } : {}) }, ctxOf(meta));
});
