import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const upstream = resolve(process.argv[2] || join(root, 'work/t3code'));
const commit = 'ca81b7b97a1c4b91e5ac25768d0f6629f37732fd';
if (execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim() !== commit)
  throw new Error('Build requires the exact T3 Code v0.1.12 commit.');
const aliases = {
  name: 't3-workspace',
  setup(builder) {
    builder.onResolve({ filter: /^@upstream\// }, args => ({ path: join(upstream, args.path.slice(10)) }));
    builder.onResolve({ filter: /^@t3tools\// }, async args => {
      const [, name, ...parts] = args.path.split('/');
      const directory = join(upstream, 'packages', name);
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const key = parts.length ? './' + parts.join('/') : '.';
      const value = pkg.exports[key];
      const target = typeof value === 'string' ? value : value?.import || value?.default;
      if (!target) throw new Error(`Missing upstream export ${args.path}`);
      return { path: resolve(directory, target) };
    });
  },
};
await mkdir(join(root, 'vendor'), { recursive: true });
for (const [entry, outfile] of [
  ['adapters/t3-v0.1.12.ts', 'vendor/t3-v0.1.12.mjs'],
  ['scripts/t3-fixture.ts', 'work/t3-fixture.mjs'],
]) {
  const result = await build({
    entryPoints: [join(root, entry)], outfile: join(root, outfile), bundle: true,
    platform: 'node', format: 'esm', target: 'node24', minify: true,
    packages: 'bundle', plugins: [aliases], metafile: true, legalComments: 'inline',
    banner: { js: `// T3 Code v0.1.12 (${commit}); upstream MIT licenses: vendor/THIRD_PARTY_LICENSES.txt\nimport { createRequire as threadliftCreateRequire } from 'node:module'; const require = threadliftCreateRequire(import.meta.url);` },
  });
  await writeFile(join(root, 'work', entry.includes('fixture') ? 'fixture-inputs.json' : 'adapter-inputs.json'), JSON.stringify(result.metafile, null, 2));
}
const meta = JSON.parse(await readFile(join(root, 'work/adapter-inputs.json'), 'utf8'));
const packageRoots = new Set();
for (const path of Object.keys(meta.inputs).filter(p => p.includes('node_modules/'))) {
  let directory = dirname(resolve(root, path));
  while (directory !== root) {
    try { const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (pkg.name) { packageRoots.add(directory); break; } } catch (e) { if (e.code !== 'ENOENT') throw e; }
    directory = dirname(directory);
  }
}
const licenses = [`T3 Code v0.1.12 (${commit})\n${await readFile(join(upstream, 'LICENSE'), 'utf8')}`];
for (const directory of [...packageRoots].sort()) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const notices = (await readdir(directory)).filter(n => /^(?:licen[cs]e|copying|notice)(?:$|[.-])/i.test(n));
  if (!notices.length) throw new Error(`Missing bundled license for ${pkg.name}`);
  licenses.push(`${pkg.name}@${pkg.version} (${pkg.license || 'see below'})\n` + (await Promise.all(notices.map(n => readFile(join(directory,n),'utf8')))).join('\n'));
}
await writeFile(join(root, 'vendor/THIRD_PARTY_LICENSES.txt'), licenses.join('\n\n---\n\n'));
console.log(`Built release-pinned adapter from ${commit}; ${licenses.length} license notices`);
