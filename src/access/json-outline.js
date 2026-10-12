import { MapMode } from '@codemirror/state';
import { icon } from './icons';
import { policyOutline } from './pbac-outline.js';

/** A view over the editor document. Opening, collapsing and navigating never edit JSON. */
export function createJSONOutline(parent, reveal, saved = {}) {
  let collapsed = new Set(saved?.collapsed ?? []), scroll = saved?.scrollTop ?? 0;
  const tree = document.createElement('div'), note = document.createElement('div');
  tree.className = 'json-outline-tree'; tree.setAttribute('aria-label', 'Policy structure');
  note.className = 'json-outline-note'; note.setAttribute('role', 'status'); note.hidden = true;
  parent.replaceChildren(tree, note);
  let revision = null, parsed = null, selection = 0, entries = [], current;
  const rememberScroll = () => { if (!parent.hidden && entries.length) scroll = tree.scrollTop; };
  tree.addEventListener('scroll', rememberScroll);

  function highlight() {
    let closest;
    for (const entry of entries) if (entry.node.from <= selection && selection <= entry.node.to &&
      (!closest || entry.node.to - entry.node.from < closest.node.to - closest.node.from)) closest = entry;
    if (closest === current) return;
    current?.row.classList.remove('current'); current?.go.removeAttribute('aria-current');
    closest?.row.classList.add('current'); closest?.go.setAttribute('aria-current', 'location');
    current = closest;
  }

  function createEntry(node, depth) {
    const row = document.createElement('div'), go = document.createElement('button');
    const entry = { node, row, go, depth, toggle: null };
    row.className = 'json-outline-row' + (depth ? '' : ' rule');
    row.style.setProperty('--depth', depth);
    if (node.children.length) {
      const toggle = entry.toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'json-outline-disclosure'; toggle.innerHTML = icon('down');
      toggle.onclick = () => {
        const y = row.offsetTop - tree.scrollTop, from = entry.node.from;
        collapsed.has(from) ? collapsed.delete(from) : collapsed.add(from);
        render();
        tree.scrollTop = row.offsetTop - y;
        scroll = tree.scrollTop;
        toggle.focus({ preventScroll: true });
      };
      row.append(toggle);
    } else {
      const spacer = document.createElement('span'); spacer.className = 'json-outline-indent'; row.append(spacer);
    }
    if (!depth) { const glyph = document.createElement('span'); glyph.innerHTML = icon('policy'); row.append(glyph); }
    go.type = 'button'; go.className = 'json-outline-location';
    go.onclick = () => reveal(entry.node.from);
    row.append(go);
    return entry;
  }

  function render() {
    const previous = new Map(entries.map(entry => [entry.node.id, entry])), next = [];
    function add(node, depth) {
      let entry = previous.get(node.id);
      if (!entry || entry.depth !== depth || !!entry.toggle !== !!node.children.length) entry = createEntry(node, depth);
      entry.node = node;
      if (entry.go.textContent !== node.label) entry.go.textContent = node.label;
      const title = node.description ? node.label + '\n' + node.description : node.label;
      if (entry.go.title !== title) entry.go.title = title;
      if (entry.toggle) {
        const expanded = String(!collapsed.has(node.from)), label = (expanded === 'true' ? 'Collapse ' : 'Expand ') + node.label;
        if (entry.toggle.getAttribute('aria-expanded') !== expanded) entry.toggle.setAttribute('aria-expanded', expanded);
        if (entry.toggle.getAttribute('aria-label') !== label) entry.toggle.setAttribute('aria-label', label);
      }
      next.push(entry);
      if (!collapsed.has(node.from)) node.children.forEach(child => add(child, depth + 1));
    }
    parsed.nodes.forEach(node => add(node, 0));
    // Ordinary typing updates only changed labels/ranges; preserve DOM, focus and scroll.
    if (next.length !== entries.length || next.some((entry, i) => entry !== entries[i])) {
      const active = document.activeElement;
      tree.replaceChildren(...next.map(entry => entry.row)); tree.scrollTop = scroll;
      if (tree.contains(active)) active.focus({ preventScroll: true });
    }
    entries = next;
    note.hidden = parsed.valid && parsed.nodes.length > 0;
    const message = parsed.valid ? 'No rules yet.' : 'Finish the JSON to use the outline.';
    if (note.textContent !== message) note.textContent = message;
    highlight();
  }

  function update(analysis, pos, changes) {
    selection = pos;
    // Follow the opening token, not an array index that may now name a different rule.
    if (changes && !changes.empty) collapsed = new Set([...collapsed]
      .map(from => changes.mapPos(from, 1, MapMode.TrackAfter)).filter(from => from !== null));
    if (parent.hidden) return; // No model or DOM work while the outline is closed.
    if (revision !== analysis) {
      if (revision) rememberScroll();
      revision = analysis; parsed = policyOutline(analysis); render();
    } else highlight();
  }

  return {
    update,
    show(visible, analysis, pos) {
      rememberScroll();
      parent.hidden = !visible;
      const remembered = scroll;
      update(analysis, pos);
      if (visible) tree.scrollTop = scroll = remembered;
    },
    bookmark: () => { rememberScroll(); return { collapsed: [...collapsed], scrollTop: scroll }; },
    destroy: () => parent.replaceChildren()
  };
}
