/**
 * Point and tell: drawing. Reads `pt`, never changes it. The layer holds the pointer surface, the
 * highlight, the pins, the note field and the bar; every element sets its critical position and
 * stacking inline (the stylesheet is cosmetic only, see css-integrity.test.ts).
 */
import { pt } from './state';

/** Stacking of everything Point and tell draws: below the toast container (…647), above Blueprint's layer (…600). */
export const Z = { layer: '2147483600', hover: '2147483602', paper: '2147483601', surface: '2147483604', ink: '2147483606', label: '2147483608', pins: '2147483610', tag: '2147483612', field: '2147483620', bar: '2147483630' } as const;

/** A positioned element: critical geometry inline, so a missing stylesheet cannot drop it into page flow. */
export function placed<T extends HTMLElement>(el: T, position: 'fixed' | 'absolute', z: string): T {
  el.style.position = position;
  el.style.zIndex = z;
  return el;
}

export interface DocRect { left: number; top: number; width: number; height: number }

/** The highlight under the pointer: one outline and a small tag (type and name). Dashed for an object the
 *  layout does not hold, with the reason as the tag. */
export function renderHover(): void {
  const layer = pt.layer;
  if (!layer) return;
  pt.hoverEl?.remove();
  pt.hoverEl = null;
  const h = pt.hover;
  if (!h) return;
  const rect = [...(pt.scene?.targets ?? []), ...(pt.scene?.pills ?? []), ...pt.foreign].find(t => t.id === h.id)?.rect;
  if (!rect) return;
  const box = placed(document.createElement('div'), 'absolute', Z.hover);
  box.className = 'pt-hover' + (h.foreign ? ' pt-foreign' : '');
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  box.style.pointerEvents = 'none';
  const tag = document.createElement('div');
  tag.className = 'pt-tag';
  tag.textContent = h.tag;
  // Above the object, or inside its top edge when it starts at the top of the page.
  tag.style.position = 'absolute';
  tag.style.left = '-1px';
  tag.style[rect.top < 28 ? 'top' : 'bottom'] = rect.top < 28 ? '2px' : '100%';
  box.appendChild(tag);
  layer.appendChild(box);
  pt.hoverEl = box;
}
