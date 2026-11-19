/**
 * @vitest-environment happy-dom
 *
 * The side panel header's server switcher: the mark inside the status ring,
 * two lines and the chevron, all in one button. The ring carries the state;
 * the mark's markup never changes; the spinner arc turns while connecting
 * and the mark's eyes blink, read and glance.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerControlView } from '../connection-view';
import { applyServerControl, buildServerControl, glanceAtPage, ringMarkup, setMarkWorking, showPanelInactive } from '../server-control';

const repoRoot = join(__dirname, '../../..');
const shellCss = readFileSync(join(repoRoot, 'src/sidepanel/shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const markCss = readFileSync(join(repoRoot, 'src/styles/mark.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim();

const view = (change: Partial<ServerControlView> = {}): ServerControlView => ({
  name: 'Test server', word: 'alex', tone: 'muted', ring: 'ok', empty: false, title: 'Switch server. Connected to Test server.', ...change,
});

/** The body of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[}{;]\\s*)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, selector).not.toBeNull();
  return m![1];
}

describe('header server switcher', () => {
  it('is one button: ring with the mark, the name over the second line, then the chevron', () => {
    const control = buildServerControl();
    expect(control.tagName).toBe('BUTTON');
    expect(control.id).toBe('header-status');
    expect(control.getAttribute('aria-haspopup')).toBe('menu');
    expect([...control.children].map(c => c.getAttribute('class'))).toEqual(['srv-ring crev-mark', 'srv-text', 'ic ic-sm srv-chev']);
    expect([...control.querySelector('.srv-text')!.children].map(c => c.className)).toEqual(['srv-name', 'srv-word']);
    expect(control.querySelector('.srv-ring')!.getAttribute('aria-hidden')).toBe('true');
    // No separate dot and no separate logo any more.
    expect(control.querySelector('.dot')).toBeNull();
  });

  it('draws a 36 px ring (r 17, stroke from CSS) with the 28 px mark at 4,4 and no ids', () => {
    const host = document.createElement('div');
    host.innerHTML = ringMarkup();
    const root = host.querySelector('svg')!;
    expect(root.getAttribute('viewBox')).toBe('0 0 36 36');
    for (const c of host.querySelectorAll(':scope > svg > circle')) {
      expect([c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')]).toEqual(['18', '18', '17']);
    }
    const mark = root.querySelector(':scope > svg')!;
    expect([mark.getAttribute('x'), mark.getAttribute('y'), mark.getAttribute('width'), mark.getAttribute('height')]).toEqual(['4', '4', '28', '28']);
    expect(mark.getAttribute('viewBox')).toBe('0 0 28 28');
    expect(mark.querySelector('path')?.getAttribute('stroke')).toBe('#8a3ffc');
    expect(host.innerHTML).not.toMatch(/\sid="|aria-label|role="img"/);
    // The spinner arc is about a quarter of the ring.
    const [dash, gap] = root.querySelector('.ring-arc')!.getAttribute('stroke-dasharray')!.split(' ').map(Number);
    expect(dash / (dash + gap)).toBeGreaterThan(0.2);
    expect(dash / (dash + gap)).toBeLessThan(0.3);
    expect(dash + gap).toBeCloseTo(2 * Math.PI * 17, 1);
  });

  it('shows each state on the ring and the second line; the mark stays the same', () => {
    const control = buildServerControl();
    const mark = control.querySelector('.srv-ring svg svg')!.outerHTML;
    const cases: Array<[Partial<ServerControlView>, string, string]> = [
      [{}, 'ok', 'muted'],
      [{ ring: 'connecting', word: 'Checking…' }, 'connecting', 'muted'],
      [{ ring: 'warn', tone: 'warn', word: 'Sign in to BMP' }, 'warn', 'warn'],
      [{ ring: 'fail', tone: 'error', word: 'Unreachable' }, 'fail', 'error'],
      [{ ring: 'none', name: 'No server', word: 'Add a server', empty: true }, 'none', 'muted'],
    ];
    for (const [change, ring, tone] of cases) {
      const v = view(change);
      applyServerControl(control, v);
      expect(control.querySelector('.srv-ring')!.getAttribute('data-ring')).toBe(ring);
      expect(control.querySelector('.srv-name')!.textContent).toBe(v.name);
      const word = control.querySelector<HTMLElement>('.srv-word')!;
      expect(word.textContent).toBe(v.word);
      expect(word.dataset.tone).toBe(tone);
      expect(control.classList.contains('empty')).toBe(v.empty);
      expect(control.getAttribute('aria-label')).toBe(`${v.name}, ${v.word}, switch server`);
      expect(control.title).toBe(v.title);
      expect(control.querySelector('.srv-ring svg svg')!.outerHTML).toBe(mark);
    }
  });

  it('a superseded panel shows a neutral ring and says so', () => {
    const control = buildServerControl();
    applyServerControl(control, view());
    showPanelInactive(control);
    expect(control.querySelector('.srv-ring')!.getAttribute('data-ring')).toBe('none');
    expect(control.querySelector('.srv-word')!.textContent).toBe('Panel inactive');
    expect(control.title).toMatch(/Another Companion panel/);
  });
});

describe('header styles', () => {
  it('colours the ring per state with the graphic amber, dashed when no server', () => {
    expect(rule(shellCss, '.srv-ring[data-ring="ok"] .ring-track')).toContain('var(--support-ok)');
    expect(rule(shellCss, '.srv-ring[data-ring="warn"] .ring-track')).toContain('var(--support-warn-graphic)');
    expect(rule(shellCss, '.srv-ring[data-ring="fail"] .ring-track')).toContain('var(--support-error)');
    expect(rule(shellCss, '.srv-ring[data-ring="none"] .ring-track')).toMatch(/stroke-dasharray/);
    expect(readFileSync(join(repoRoot, 'src/styles/tokens.css'), 'utf8')).toMatch(/--support-warn-graphic:\s*#b28600/);
  });

  it('spins only the arc: linear, about 0.9 s a turn, rounded ends, still under reduced motion', () => {
    const arc = rule(shellCss, '.srv-ring[data-ring="connecting"] .ring-arc');
    expect(arc).toMatch(/animation:\s*srv-ring-spin 0\.9s linear infinite/);
    expect(arc).toContain('transform-origin: 18px 18px');
    expect(rule(shellCss, '.srv-ring .ring-arc')).toContain('stroke-linecap: round');
    expect(shellCss).toMatch(/@keyframes srv-ring-spin\s*\{\s*from\s*\{\s*transform: rotate\(-90deg\);\s*\}\s*to\s*\{\s*transform: rotate\(270deg\);\s*\}/);
    // The ring box itself never animates; the mark's eyes have their own test.
    expect(shellCss.match(/animation:\s*srv-ring-spin/g)).toHaveLength(1);
    const reduced = shellCss.slice(shellCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/^@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.srv-ring\[data-ring="connecting"\] \.ring-arc\s*\{\s*animation: none;/);
  });

  it('moves only the eyes: a blink, reading while work runs, a glance at the page; still under reduced motion', () => {
    vi.useFakeTimers();
    try {
      const control = buildServerControl();
      const ring = control.querySelector('.srv-ring')!;
      const markup = ring.innerHTML;
      // Both eyes sit in the glance group and, inside it, the reading group.
      expect(ring.querySelectorAll('.mark-look > .mark-eyes > circle')).toHaveLength(2);

      setMarkWorking(control, true);
      expect(ring.getAttribute('data-mood')).toBe('read');
      setMarkWorking(control, false);
      expect(ring.hasAttribute('data-mood')).toBe(false);

      glanceAtPage(control);
      expect(ring.getAttribute('data-look')).toBe('page');
      vi.advanceTimersByTime(600);
      glanceAtPage(control); // a second object: the glance starts over, it does not end early
      vi.advanceTimersByTime(600);
      expect(ring.getAttribute('data-look')).toBe('page');
      vi.advanceTimersByTime(300);
      expect(ring.hasAttribute('data-look')).toBe(false);
      // State is carried by attributes on the ring; the markup never changes.
      expect(ring.innerHTML).toBe(markup);
    } finally {
      vi.useRealTimers();
    }

    expect(rule(markCss, '.crev-mark .mark-eyes circle')).toMatch(/animation:\s*crev-mark-blink 13s infinite/);
    expect(rule(markCss, '.crev-mark[data-mood="read"] .mark-eyes')).toMatch(/animation:\s*crev-mark-read/);
    expect(rule(markCss, '.crev-mark[data-look="page"] .mark-look')).toContain('translateX(-1.5px)');
    // Transforms only: no layout property in either keyframe set.
    const frames = /@keyframes crev-mark-blink\s*\{([\s\S]*?\})\s*\}\s*@keyframes crev-mark-read\s*\{([\s\S]*?\})\s*\}/.exec(markCss)!;
    for (const body of [frames[1], frames[2]]) {
      expect(body.match(/[a-z-]+(?=\s*:)/g)!.every(p => p === 'transform')).toBe(true);
    }
    const reduced = markCss.slice(markCss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.crev-mark \.mark-eyes, \.crev-mark \.mark-eyes circle\s*\{\s*animation: none;/);
    expect(reduced).toMatch(/\.crev-mark \.mark-look\s*\{\s*transition: none; transform: none;/);
  });

  it('is 48 px high with 28 px modes and a 32 px action, smaller in a narrow panel, named in a wide one', () => {
    const header = rule(shellCss, '.header');
    expect(header).toContain('height: 48px');
    expect(header).toMatch(/container:\s*sp-header \/ inline-size/);
    expect(rule(shellCss, '.srv-ring')).toContain('width: 36px');
    expect(rule(shellCss, '.header .hdr-mode')).toMatch(/width: 28px; height: 28px/);
    expect(rule(shellCss, '.header .hdr-act')).toMatch(/width: 32px; height: 32px/);
    const narrow = shellCss.slice(shellCss.indexOf('@container sp-header (max-width: 340px)'));
    expect(narrow).toMatch(/^@container sp-header \(max-width: 340px\)\s*\{\s*\.header \.hdr-mode\s*\{\s*width: 24px; height: 24px;\s*\}\s*\.header \.hdr-act\s*\{\s*width: 28px; height: 28px;/);
    // Names show only when the header is wide enough for all four.
    expect(rule(shellCss, '.hdr-lbl')).toContain('display: none');
    const wide = shellCss.slice(shellCss.indexOf('@container sp-header (min-width: 560px)'));
    expect(wide).toMatch(/^@container sp-header \(min-width: 560px\)\s*\{[\s\S]*?\.hdr-lbl\s*\{\s*display: inline;/);
    // The name truncates (the text column may shrink below its content).
    expect(rule(shellCss, '.srv-text')).toContain('min-width: 0');
    expect(rule(shellCss, '.srv-name,\n.srv-word')).toContain('text-overflow: ellipsis');
  });

  it('server menu: the name keeps its width up to 60% of the row; the host shrinks and truncates', () => {
    const name = rule(shellCss, '.sp-menu-t');
    expect(name).toMatch(/flex: 0 0 auto/);
    expect(name).toContain('max-width: 60%');
    expect(name).toContain('text-overflow: ellipsis');
    const host = rule(shellCss, '.sp-menu-sub');
    expect(host).toMatch(/flex: 0 1 auto/);
    expect(host).toContain('min-width: 0');
    expect(host).toContain('text-overflow: ellipsis');
  });
});
