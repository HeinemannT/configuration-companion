/**
 * Events as the browser makes them from real input. Script-made events are
 * not trusted (`isTrusted` false), and in-page write paths ignore them
 * (trusted-event.ts); tests mark the events that stand for a real user.
 */
export function asUser<E extends Event>(event: E): E {
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

export function userClick(el: Element): void {
  el.dispatchEvent(asUser(new MouseEvent('click', { bubbles: true, cancelable: true })));
}

export function userMouseDown(el: Element): void {
  el.dispatchEvent(asUser(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
}

export function userKey(el: Element, key: string): void {
  el.dispatchEvent(asUser(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
}
