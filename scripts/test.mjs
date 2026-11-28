import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const releases = JSON.parse(await readFile(new URL('../adapters/t3-releases.json', import.meta.url), 'utf8'));
const tests = (await readdir(new URL('../test/', import.meta.url))).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`);
for (const { version } of releases) {
  console.log(`\nT3 Code ${version} fixtures`);
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root, stdio: 'inherit', env: { ...process.env, THREADLIFT_TEST_T3_VERSION: version },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
