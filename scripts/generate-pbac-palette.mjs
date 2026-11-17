import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// pbac-highlighting.js imports Access model files written in TypeScript, which
// plain Node cannot resolve; bundle the module first, then load it.
const entry = fileURLToPath(new URL('../src/access/pbac-highlighting.js', import.meta.url));
const bundle = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
const { pbacPaletteCSS } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const output = new URL('../src/access/pbac-highlighting.css', import.meta.url);
const css = pbacPaletteCSS();
if (process.argv.includes('--check')) {
  if (await readFile(output, 'utf8') !== css) throw Error('PBAC palette is stale. Run npm run pbac:palette.');
} else await writeFile(output, css, 'utf8');
