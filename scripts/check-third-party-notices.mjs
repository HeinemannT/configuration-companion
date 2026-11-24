// Checks THIRD-PARTY-NOTICES.md against what the built extension ships: the browser extension and the
// Claude Desktop extension packed into it (claude-desktop/, shipped as claude-setup/configuration-companion.mcpb).
// Offline; reads only the two package.json and package-lock.json files, the notices file and the
// generated Phosphor data of the image library.
//
// Fails when
//   - a runtime dependency in package.json is neither SHIPPED nor NOT_SHIPPED;
//   - a package reachable from a shipped dependency (following package-lock.json, minus the
//     subtrees in NOT_BUNDLED) is not SHIPPED, so a new transitive package forces a decision;
//   - a shipped package's licence differs from the one recorded here;
//   - a shipped package, icon set or font is not named in THIRD-PARTY-NOTICES.md;
//   - the Phosphor icons of the image library (generated from the devDependency @phosphor-icons/core by
//     scripts/generate-image-library.mjs) come from another version than the one installed, or its licence changed.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const notices = readFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');

// Packages bundled into the extension, with their licence.
const SHIPPED = {
  '@codemirror/autocomplete': 'MIT', '@codemirror/commands': 'MIT', '@codemirror/lang-css': 'MIT',
  '@codemirror/lang-html': 'MIT', '@codemirror/lang-javascript': 'MIT', '@codemirror/lang-json': 'MIT',
  '@codemirror/language': 'MIT', '@codemirror/lint': 'MIT', '@codemirror/merge': 'MIT',
  '@codemirror/search': 'MIT', '@codemirror/state': 'MIT', '@codemirror/streamparser': 'MIT',
  '@codemirror/view': 'MIT', '@lezer/common': 'MIT', '@lezer/css': 'MIT', '@lezer/highlight': 'MIT', '@lezer/html': 'MIT',
  '@lezer/javascript': 'MIT', '@lezer/json': 'MIT', '@lezer/lr': 'MIT',
  '@marijn/find-cluster-break': 'MIT', 'crelt': 'MIT', 'style-mod': 'MIT', 'w3c-keyname': 'MIT',
  'js-beautify': 'MIT', 'tldts': 'MIT', 'tldts-core': 'MIT', 'tough-cookie': 'BSD-3-Clause',
};
// Runtime dependencies that are deliberately not bundled (none today).
const NOT_SHIPPED = new Set([]);
// Dependencies of a shipped package that the browser build does not include
// (js-beautify's command-line and configuration-file support).
const NOT_BUNDLED = {
  'js-beautify': ['config-chain', 'editorconfig', 'glob', 'js-cookie', 'nopt'],
};
// The Claude Desktop extension: its server bundle (esbuild, from claude-desktop/src) holds these.
const DESKTOP_SHIPPED = {
  '@modelcontextprotocol/sdk': 'MIT', 'ajv': 'MIT', 'ajv-formats': 'MIT', 'fast-deep-equal': 'MIT', 'fast-uri': 'BSD-3-Clause',
  'json-schema-traverse': 'MIT', 'ws': 'MIT', 'zod': 'MIT', 'zod-to-json-schema': 'ISC',
};
// Not in the server bundle: the SDK's HTTP transports and OAuth support, which the stdio server does not import.
const DESKTOP_NOT_BUNDLED = {
  '@modelcontextprotocol/sdk': ['@hono/node-server', 'content-type', 'cors', 'cross-spawn', 'eventsource', 'eventsource-parser',
    'express', 'express-rate-limit', 'hono', 'jose', 'json-schema-typed', 'pkce-challenge', 'raw-body'],
  // Used by ajv's standalone code generation only.
  'ajv': ['require-from-string'],
};
// Assets that are not npm packages: icon sets and fonts in src/.
const ASSETS = ['Phosphor Icons', 'Feather', 'Lucide', 'Inter', 'JetBrains Mono'];
const LICENCE_HEADINGS = { MIT: 'MIT License', 'BSD-3-Clause': 'BSD 3-Clause License', ISC: 'ISC License', OFL: 'SIL Open Font License 1.1' };

const problems = [];

/** Every package reachable from the shipped runtime dependencies of the package in `dir` is classified, with its licence. */
function checkTree(dir, shipped, notShipped, notBundled) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, dir, 'package-lock.json'), 'utf8'));
  const where = dir ? `${dir}: ` : '';

  /** Resolve `name` as Node would from the lock path `from`. */
  function resolveInLock(name, from) {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
      if (lock.packages[candidate]) return candidate;
      if (!base) return null;
      const cut = base.lastIndexOf('/node_modules/');
      base = cut === -1 ? '' : base.slice(0, cut);
    }
  }

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!(name in shipped) && !notShipped.has(name)) problems.push(`${where}dependency ${name} is not classified as shipped or not shipped`);
  }

  const seen = new Set();
  const queue = Object.keys(pkg.dependencies ?? {}).filter(name => name in shipped).map(name => [name, '']);
  while (queue.length) {
    const [name, from] = queue.shift();
    const path = resolveInLock(name, from);
    if (!path) { problems.push(`${where}${name} is missing from package-lock.json`); continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    if (!(name in shipped)) { problems.push(`${where}${name} is bundled with a shipped package but not classified`); continue; }
    const meta = lock.packages[path];
    if (meta.license !== shipped[name]) problems.push(`${where}${name} has licence ${meta.license}, expected ${shipped[name]}`);
    const skip = new Set(notBundled[name] ?? []);
    for (const dep of Object.keys(meta.dependencies ?? {})) if (!skip.has(dep)) queue.push([dep, path]);
  }
}

checkTree('', SHIPPED, NOT_SHIPPED, NOT_BUNDLED);
checkTree('claude-desktop', DESKTOP_SHIPPED, new Set(), DESKTOP_NOT_BUNDLED);

for (const name of [...Object.keys(SHIPPED), ...Object.keys(DESKTOP_SHIPPED)]) {
  const slash = name.indexOf('/');
  const named = notices.includes(name)
    || (name.startsWith('@') && notices.includes(name.slice(0, slash + 1)) && notices.includes(`\`${name.slice(slash + 1)}\``));
  if (!named) problems.push(`THIRD-PARTY-NOTICES.md does not name ${name}`);
}
for (const asset of ASSETS) if (!notices.includes(asset)) problems.push(`THIRD-PARTY-NOTICES.md does not name ${asset}`);
for (const licence of new Set([...Object.values(SHIPPED), ...Object.values(DESKTOP_SHIPPED), 'ISC', 'OFL'])) {
  if (!notices.includes(`## ${LICENCE_HEADINGS[licence]}`)) problems.push(`THIRD-PARTY-NOTICES.md lacks the ${licence} licence text`);
}

// Icons that ship from a devDependency: the package is not bundled, its generated data is.
const PHOSPHOR_DATA = 'src/lib/colors-images/library-data/button-icons.ts';
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const meta = lock.packages['node_modules/@phosphor-icons/core'];
  const data = readFileSync(join(root, PHOSPHOR_DATA), 'utf8');
  const version = /PHOSPHOR_VERSION = "([^"]+)"/.exec(data)?.[1];
  if (!pkg.devDependencies?.['@phosphor-icons/core'] || !meta) problems.push(`${PHOSPHOR_DATA} is generated from @phosphor-icons/core, which is not a devDependency`);
  else {
    if (meta.license !== 'MIT') problems.push(`@phosphor-icons/core has licence ${meta.license}, expected MIT (Phosphor Icons)`);
    if (version !== meta.version) problems.push(`${PHOSPHOR_DATA} holds Phosphor ${version ?? '?'}, @phosphor-icons/core is ${meta.version}: run node scripts/generate-image-library.mjs`);
  }
}

if (problems.length) {
  console.error(`Third-party notices check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('Third-party notices check OK.');
