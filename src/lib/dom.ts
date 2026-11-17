/**
 * Minimal DOM builder — replaces innerHTML template literals.
 * No VDOM, no diffing, no reactivity. Just a clean API for creating DOM nodes.
 */

export type Child = Node | string | number | null | false | undefined | Child[];

/** Handler shape accepted by `h()`. Allows specific event sub-types
 *  (MouseEvent, KeyboardEvent, etc.) on `onClick` / `onKeydown` /…
 *  without forcing the caller to widen to the bare `Event`. We accept
 *  the broader `(e: any) => unknown` shape and let `h` cast to
 *  EventListener at the `addEventListener` boundary. */
type AnyHandler = (e: never) => unknown;
type Attrs = Record<string, string | number | boolean | AnyHandler | undefined | null>;

const SVG_CACHE = new Map<string, HTMLTemplateElement>();

/** Create an HTML element with attributes and children */
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);

  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val == null || val === false) continue;
      if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (key === 'class' || key === 'className') {
        el.className = String(val);
      } else if (key === 'style') {
        el.setAttribute('style', String(val));
      } else if (key === 'checked' || key === 'disabled' || key === 'readOnly') {
        if (val === true) (el as any)[key] = true;
      } else if (key === 'value') {
        (el as any).value = String(val);
      } else {
        el.setAttribute(key, val === true ? '' : String(val));
      }
    }
  }

  appendChildren(el, children);
  return el;
}

/** Replace container contents efficiently */
export function render(container: HTMLElement, ...children: Child[]): void {
  container.textContent = '';
  appendChildren(container, children);
}

/** Parse an SVG string into a DOM node (cached by string identity) */
export function svg(html: string): Node {
  let tmpl = SVG_CACHE.get(html);
  if (!tmpl) {
    tmpl = document.createElement('template');
    tmpl.innerHTML = html.trim();
    SVG_CACHE.set(html, tmpl);
  }
  return tmpl.content.cloneNode(true);
}

function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

// ── Small DOM kit (el / attrs / btn / icon) ─────────────────────
// The one copy for the extension pages (object window, code search, Compare,
// side panel, editor panels). The accessibility rules live here so every
// surface gets them: a button's label is both its accessible name
// (aria-label) and its tooltip, and a button whose only child is an icon
// always gets a label; sprite icons are decorative and hidden from assistive
// technology.

export type Kid = Node | string | null | undefined | false;

/** An element with an optional class and children (null/false skipped). */
export function el(tag: string, cls?: string, ...kids: Kid[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}

/** Set the attributes whose value is not null/undefined; returns the element. */
export function attrs<T extends Element>(e: T, a: Record<string, string | undefined | null>): T {
  for (const [k, v] of Object.entries(a)) if (v != null) e.setAttribute(k, v);
  return e;
}

/** A `type=button` button. `label` becomes its accessible name and tooltip;
 *  pass one whenever the children are only an icon. */
export function btn(cls: string, label: string | undefined, onClick: (e: MouseEvent) => void, ...kids: Kid[]): HTMLButtonElement {
  const b = el('button', cls, ...kids) as HTMLButtonElement;
  b.type = 'button';
  if (label) { b.setAttribute('aria-label', label); b.title = label; }
  b.addEventListener('click', onClick);
  return b;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A sprite icon (`<svg class="ic"><use href="#id"/></svg>`), decorative: aria-hidden. */
export function icon(id: string, cls = ''): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('class', `ic${cls ? ` ${cls}` : ''}`);
  s.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  s.append(use);
  return s;
}

/** Fire a short confirmation onto the status bar's feedback slot (the bar
 *  listens for this event; see buildApp in sidepanel.ts). */
export function statusFlash(msg: string): void {
  document.dispatchEvent(new CustomEvent('crev:status-flash', { detail: msg }));
}
