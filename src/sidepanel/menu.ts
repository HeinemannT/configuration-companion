/**
 * Small popup menu for the side panel (server switcher, Log scope and
 * export). Built on the shared `.ui-menu` primitive; fixed-positioned under
 * its trigger so scrolling containers cannot clip it. Keyboard: arrows,
 * Home/End, Enter/Space, Escape (focus returns to the trigger), Tab closes.
 */
import { icon } from './icons';

export interface MenuItem {
  label: string;
  /** Muted second part on the same line (for example a host). */
  sub?: string;
  /** For a choice list: marks the current item (menuitemradio). */
  checked?: boolean;
  iconId?: string;
  onSelect(): void;
}

export interface MenuOptions {
  anchor: HTMLElement;
  items: (MenuItem | 'separator')[];
  label: string;
  align?: 'start' | 'end';
  className?: string;
  /** A muted, non-interactive line at the end (for example the version). */
  footer?: string;
}

let openClose: (() => void) | null = null;

/** Close the open menu, if any. */
export function closeMenu(): void { openClose?.(); }

export function isMenuOpenFor(anchor: HTMLElement): boolean {
  return !!openClose && anchor.getAttribute('aria-expanded') === 'true';
}

/** Open a menu under `anchor`; a second call for the same anchor closes it. */
export function toggleMenu(opts: MenuOptions): void {
  if (isMenuOpenFor(opts.anchor)) { closeMenu(); return; }
  openMenu(opts);
}

export function openMenu({ anchor, items, label, align = 'start', className = '', footer }: MenuOptions): HTMLElement {
  closeMenu();
  const doc = anchor.ownerDocument;
  const radio = items.some(i => i !== 'separator' && i.checked !== undefined);
  const menu = doc.createElement('div');
  menu.className = `ui ui-menu sp-menu${className ? ` ${className}` : ''}`;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);

  const buttons: HTMLButtonElement[] = [];
  for (const item of items) {
    if (item === 'separator') {
      const sep = doc.createElement('div');
      sep.className = 'sp-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.append(sep);
      continue;
    }
    const b = doc.createElement('button');
    b.type = 'button';
    b.tabIndex = -1;
    if (radio && item.checked !== undefined) {
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(!!item.checked));
    } else {
      b.setAttribute('role', 'menuitem');
    }
    if (radio) b.append(icon('s-check', `ic-sm sp-menu-ck${item.checked ? '' : ' off'}`));
    else if (item.iconId) b.append(icon(item.iconId, 'ic-sm'));
    const text = doc.createElement('span');
    text.className = 'sp-menu-t';
    text.textContent = item.label;
    b.append(text);
    if (item.sub) {
      const sub = doc.createElement('span');
      sub.className = 'ui-id sp-menu-sub';
      sub.textContent = item.sub;
      b.append(sub);
    }
    b.addEventListener('click', () => {
      // Focus returns to the trigger first; an action may then move it on.
      close(true);
      item.onSelect();
    });
    buttons.push(b);
    menu.append(b);
  }

  if (footer) {
    const meta = doc.createElement('div');
    meta.className = 'sp-menu-meta';
    meta.textContent = footer;
    menu.append(meta);
  }

  doc.body.append(menu);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const w = Math.min(menu.offsetWidth, vw - 16);
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.maxWidth = `${vw - 16}px`;
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');

  const focusAt = (i: number) => {
    if (!buttons.length) return;
    const n = (i + buttons.length) % buttons.length;
    buttons[n].focus();
  };
  const current = () => buttons.indexOf(doc.activeElement as HTMLButtonElement);
  const onKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(current() + 1); break;
      case 'ArrowUp': e.preventDefault(); focusAt(current() - 1); break;
      case 'Home': e.preventDefault(); focusAt(0); break;
      case 'End': e.preventDefault(); focusAt(buttons.length - 1); break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(true); break;
      // Back on the trigger, the browser's own Tab move continues from there.
      case 'Tab': close(true); break;
    }
  };
  const onPointer = (e: Event) => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || anchor.contains(t))) return;
    close(false);
  };
  const onResize = () => close(false);

  let closed = false;
  function close(returnFocus: boolean) {
    if (closed) return;
    closed = true;
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    menu.removeEventListener('keydown', onKey);
    doc.removeEventListener('pointerdown', onPointer, true);
    doc.defaultView?.removeEventListener('resize', onResize);
    if (openClose === closeThis) openClose = null;
    if (returnFocus) anchor.focus();
  }
  const closeThis = () => close(false);
  openClose = closeThis;
  menu.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', onPointer, true);
  doc.defaultView?.addEventListener('resize', onResize);

  const checkedIndex = buttons.findIndex(b => b.getAttribute('aria-checked') === 'true');
  focusAt(checkedIndex >= 0 ? checkedIndex : 0);
  return menu;
}
