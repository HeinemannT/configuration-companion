import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { pbacPaletteCSS } from './pbac-highlighting.js';

test('the shipped editor palette matches the preview palette', () => {
  expect(readFileSync(new URL('./pbac-highlighting.css', import.meta.url), 'utf8')).toBe(pbacPaletteCSS());
});
