// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { clearDockRoom, dockBar, roomTarget } from '../bar-place';

const page = () => { document.body.innerHTML = '<div id="top"><div id="band" style="position:fixed"></div><div id="crumbs" style="margin-top:4px"></div></div><div id="bar"></div>'; return { band: document.getElementById('band')!, crumbs: document.getElementById('crumbs')!, bar: document.getElementById('bar')! }; };

afterEach(() => { clearDockRoom(); document.body.replaceChildren(); });

describe('docked bar', () => {
  it('takes the first element in the page flow after the band as the one that gets the room', () => {
    document.body.innerHTML = '<div id="top"><div id="band" style="position:fixed"></div><div id="crumbs"></div></div><div id="content"></div>';
    expect(roomTarget(document.getElementById('band')!)?.id).toBe('crumbs');
    document.getElementById('crumbs')!.remove();
    expect(roomTarget(document.getElementById('band')!)?.id).toBe('content');
  });

  it('skips a sibling that is out of the page flow', () => {
    document.body.innerHTML = '<div id="top"><div id="band" style="position:fixed"></div><div id="menu" style="position:absolute"></div></div><div id="content"></div>';
    expect(roomTarget(document.getElementById('band')!)?.id).toBe('content');
  });

  it('floats, and takes no room, where the portal has no band', () => {
    document.body.innerHTML = '<div id="content"></div><div id="bar" class="bp-docked"></div>';
    const bar = document.getElementById('bar')!;
    expect(dockBar(bar)).toBe(false);
    expect(bar.classList.contains('bp-docked')).toBe(false);
    expect(document.getElementById('content')!.style.marginTop).toBe('');
  });

  it('gives the page room under the band and takes it back', () => {
    const { band, crumbs, bar } = page();
    expect(dockBar(bar, band)).toBe(true);
    expect(bar.classList.contains('bp-docked')).toBe(true);
    expect(crumbs.hasAttribute('data-crev-dock-room')).toBe(true);
    expect(clearDockRoom()).toBe(true);
    expect(crumbs.style.marginTop).toBe('4px');
    expect(crumbs.hasAttribute('data-crev-dock-room')).toBe(false);
  });

  it('starts from the margin kept on the element when another script docked before', () => {
    const { band, crumbs, bar } = page();
    // What a replaced content script left behind: the room it added, and the note of the original.
    crumbs.style.marginTop = '90px';
    crumbs.setAttribute('data-crev-dock-room', '4|4px');
    dockBar(bar, band);
    expect(clearDockRoom()).toBe(true);
    expect(crumbs.style.marginTop).toBe('4px');
  });

  it('stays docked while the band is out of sight, and lets go when the page element is gone', () => {
    const { band, crumbs, bar } = page();
    dockBar(bar, band);
    const margin = crumbs.style.marginTop;
    expect(dockBar(bar, null)).toBe(false);
    expect(bar.classList.contains('bp-docked')).toBe(true);
    expect(crumbs.style.marginTop).toBe(margin);
    crumbs.remove();
    dockBar(bar, null);
    expect(bar.classList.contains('bp-docked')).toBe(false);
  });
});
