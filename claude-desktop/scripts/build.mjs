/**
 * Bundle the server into one file and lay out the bundle folder (build/bundle). With --pack, also make
 * build/configuration-companion-<version>.mcpb with Anthropic's packer (@anthropic-ai/mcpb, a pinned dev
 * dependency installed by npm ci) and validate it. The browser extension's build runs this with --pack and ships
 * the file. Nothing here is committed: build/ is ignored.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const bundle = join(out, 'bundle');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const quiet = process.argv.includes('--quiet');
const say = (line) => { if (!quiet) console.log(line); };

/** The packed file's name, as the browser extension's build looks for it. */
const packedName = (version) => `configuration-companion-${version}.mcpb`;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(bundle, 'server'), { recursive: true });

await build({
  entryPoints: [join(root, 'src/index.js')],
  outfile: join(bundle, 'server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  minify: true,
  legalComments: 'none',
  // ws loads these only when present, and falls back to plain JavaScript.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'error',
});
writeFileSync(join(bundle, 'server/package.json'), '{"type":"commonjs"}\n'); // the bundle is CommonJS even when a folder above it says module
copyFileSync(join(root, 'manifest.json'), join(bundle, 'manifest.json'));
copyFileSync(join(root, 'icon.png'), join(bundle, 'icon.png'));
// The licences of what the server bundle holds travel with it (the repository's one notices file).
copyFileSync(join(root, '../THIRD-PARTY-NOTICES.md'), join(bundle, 'THIRD-PARTY-NOTICES.md'));
say(`bundle: ${(statSync(join(bundle, 'server/index.js')).size / 1024).toFixed(0)} KB of server code`);

if (process.argv.includes('--pack')) {
  const file = join(out, packedName(manifest.version));
  let cli;
  try {
    const require = createRequire(join(root, 'package.json'));
    cli = join(dirname(require.resolve('@anthropic-ai/mcpb')), 'cli/cli.js'); // the package exports dist/index.js
  } catch {
    throw new Error('The packer is not installed. Run npm ci in claude-desktop (the root npm ci does it).');
  }
  const mcpb = (...args) => execFileSync(process.execPath, [cli, ...args], { stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit' });
  mcpb('validate', join(bundle, 'manifest.json'));
  mcpb('pack', bundle, file);
  say(`packed: ${file} (${(statSync(file).size / 1024).toFixed(0)} KB)`);
}
