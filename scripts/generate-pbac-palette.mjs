import { readFile, writeFile } from 'node:fs/promises';
import { pbacPaletteCSS } from '../src/access/pbac-highlighting.js';

const output = new URL('../src/access/pbac-highlighting.css', import.meta.url);
const css = pbacPaletteCSS();
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== css) throw Error('PBAC palette is stale. Run npm run pbac:palette.');
} else await writeFile(output, css, 'utf8');
