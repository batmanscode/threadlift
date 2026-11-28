import { readFile, writeFile, utimes } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.mjs';

export async function bulkFixture(t, count = 23) {
  const f = await fixture(t), ids = [f.id], paths = [f.path];
  const original = (await readFile(f.path, 'utf8')).trim().split('\n').map(JSON.parse);
  await writeFile(join(f.scratch, 'generated.html'), '<!doctype html><title>Generated file</title><h1>Recovered</h1>');
  original.at(-1).payload.content[0].text += `\n\n[Generated page](${join(f.scratch, 'generated.html')})`;
  const assignments = JSON.parse(await readFile(join(f.source, '.codex-global-state.json'), 'utf8'));
  const names = [];
  for (let i = 0; i < count; i++) {
    const id = i === 0 ? f.id : randomUUID(), path = i === 0 ? f.path : join(dirname(f.path), `rollout-bulk-${id}.jsonl`);
    const records = structuredClone(original); records[0].payload.id = id;
    await writeFile(path, records.map(JSON.stringify).join('\n') + '\n');
    if (i > 0) { ids.push(id); paths.push(path); }
    assignments['thread-project-assignments'][id] = { projectKind: 'local', projectId: 'local-1' };
    names.push({ id, thread_name: `Recovered chat ${String(i + 1).padStart(2, '0')}` });
  }
  await writeFile(join(f.source, '.codex-global-state.json'), JSON.stringify(assignments));
  await writeFile(join(f.source, 'session_index.jsonl'), names.map(JSON.stringify).join('\n') + '\n');
  const old = new Date('2026-09-01T00:00:00Z'); await utimes(paths.at(-1), old, old);
  return { ...f, ids, paths };
}
