/**
 * Make an element's children the given nodes, moving as little as possible:
 * nodes that are already in place stay, so a list that only grows at the end
 * (a new batch of results) inserts just the new nodes and keeps everything
 * else (focus, selection, scroll anchoring) untouched.
 */
export function reconcileChildren(parent: Element, want: readonly Node[]): void {
  const keep = new Set(want);
  for (let n = parent.firstChild; n;) {
    const next = n.nextSibling;
    if (!keep.has(n)) parent.removeChild(n);
    n = next;
  }
  let cur = parent.firstChild;
  for (const n of want) {
    if (cur === n) { cur = cur.nextSibling; continue; }
    parent.insertBefore(n, cur);
  }
}
