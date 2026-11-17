/**
 * @vitest-environment happy-dom
 *
 * The shared empty state: mascot (decorative), sentence, optional action,
 * in DOM and in markup form.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_ART_PX, emptyState, emptyStateHtml, mascotArt } from '../empty-state';

describe('emptyState', () => {
  it('puts the mascot above the sentence and hides it from assistive technology', () => {
    const node = emptyState({ title: 'Nothing logged yet', text: 'Saves appear here.' });
    expect(node.className).toBe('ui-empty');
    const [art, title, text] = [...node.children] as HTMLElement[];
    expect(art.className).toBe('ui-empty-art');
    expect(art.getAttribute('aria-hidden')).toBe('true');
    const svg = art.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe(String(EMPTY_ART_PX.md));
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.hasAttribute('role')).toBe(false);
    expect(svg.hasAttribute('aria-label')).toBe(false);
    expect(title.tagName).toBe('B');
    expect(title.textContent).toBe('Nothing logged yet');
    expect(text.tagName).toBe('P');
    expect(text.textContent).toBe('Saves appear here.');
  });

  it('takes a heading tag, a small size, actions, a note, a role and extra classes', () => {
    const button = document.createElement('button');
    button.textContent = 'Choose an object';
    const node = emptyState({ title: 'Choose two objects', titleTag: 'h3', art: 'sm', actions: [button], note: 'Or paste a RID.', className: 'cmp-blank', role: 'status' });
    expect(node.className).toBe('ui-empty sm cmp-blank');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.querySelector('h3.ui-empty-title')?.textContent).toBe('Choose two objects');
    expect(node.querySelector('.ui-empty-art svg')?.getAttribute('height')).toBe(String(EMPTY_ART_PX.sm));
    expect(node.querySelector('.ui-empty-actions > button')).toBe(button);
    expect(node.querySelector('.ui-empty-note')?.textContent).toBe('Or paste a RID.');
  });

  it('can leave the mascot out and skips empty parts', () => {
    const node = emptyState({ title: 'No matches', text: '', art: false });
    expect(node.querySelector('.ui-empty-art')).toBeNull();
    expect(node.querySelector('.ui-empty-text')).toBeNull();
    expect(node.querySelector('.ui-empty-actions')).toBeNull();
    expect(node.textContent).toBe('No matches');
  });

  it('accepts inline nodes in the text', () => {
    const link = document.createElement('button');
    link.textContent = 'Show all events';
    const node = emptyState({ title: 'No problems', text: ['Failures appear here. ', link] });
    expect(node.querySelector('.ui-empty-text')?.textContent).toBe('Failures appear here. Show all events');
  });

  it('gives each copy its own mascot without duplicate ids', () => {
    const host = document.createElement('div');
    host.append(mascotArt(), mascotArt('sm'));
    expect(host.querySelectorAll('svg')).toHaveLength(2);
    expect(host.querySelectorAll('[id]')).toHaveLength(0);
  });
});

describe('emptyStateHtml', () => {
  it('builds the same block as markup', () => {
    const host = document.createElement('div');
    host.innerHTML = emptyStateHtml({ titleHtml: 'No policies on DEV yet', titleTag: 'h1', textHtml: 'With no statements…', actionsHtml: '<button>New policy</button>', noteHtml: 'Paste JSON later.', className: 'empty-workspace', role: 'status' });
    const node = host.firstElementChild as HTMLElement;
    expect(node.className).toBe('ui-empty empty-workspace');
    expect(node.getAttribute('role')).toBe('status');
    expect(node.querySelector('.ui-empty-art')?.getAttribute('aria-hidden')).toBe('true');
    expect(node.querySelector('h1.ui-empty-title')?.textContent).toBe('No policies on DEV yet');
    expect(node.querySelector('.ui-empty-text')?.textContent).toBe('With no statements…');
    expect(node.querySelector('.ui-empty-actions button')?.textContent).toBe('New policy');
    expect(node.querySelector('.ui-empty-note')?.textContent).toBe('Paste JSON later.');
  });

  it('leaves the mascot out on request', () => {
    expect(emptyStateHtml({ textHtml: 'None', art: false })).toBe('<div class="ui-empty"><p class="ui-empty-text">None</p></div>');
  });
});
