import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { bulkFixture } from './bulk-fixture.mjs';
import { discoverCodex, hash } from '../src/codex.mjs';
import { stageJobs, applyJobs } from '../src/jobs.mjs';
import { inspectTarget, applyJob } from '../src/target.mjs';
import { servePicker } from '../src/server.mjs';

test('bulk scan includes older missing chats; default files and shared folders survive automatic batches', async t => {
  const f = await bulkFixture(t);
  if (process.getuid?.() !== 0) {
    await chmod(f.paths[1], 0);
    try {
      const readable = await discoverCodex(f.source, { days: 0 });
      assert.equal(readable.chats.length, f.ids.length - 1);
      assert.equal(readable.unavailableChats[0].id, f.ids[1]);
    } finally { await chmod(f.paths[1], 0o600); }
  }
  const sources = await Promise.all(f.paths.map(p => readFile(p).then(hash)));
  const picker = await servePicker({ codexHome: f.source, t3Home: f.target, openBrowser: false, reopen: false });
  t.after(() => picker.server.close());
  const [base, token] = picker.url.split('#');
  const api = async (path, data) => {
    const response = await fetch(base + 'api/' + path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await api('state')).chats.length, f.ids.length - 1);
  const state = await api('scan', {});
  assert.equal(state.scanDays, 0); assert.equal(state.chats.length, f.ids.length);
  const selections = [];
  for (const c of state.chats) {
    const preview = await api('preview', { id: c.id, scanId: state.scanId });
    assert.ok(preview.assets.some(a => a.kind === 'reference' && a.name === 'generated.html'));
    selections.push({ id: c.id, sourceHash: preview.sourceHash, recoverWorkspace: true });
  }
  const staged = await stageJobs(await discoverCodex(f.source), f.target, selections, { jobRoot: join(f.root, 'jobs') });
  assert.equal(staged.job.jobs.length, 2);
  const [first, second] = await Promise.all(staged.job.jobs.map(p => readFile(join(staged.directory, p), 'utf8').then(JSON.parse)));
  assert.equal(first.batch.projects.length, 1); assert.equal(second.batch.projects.length, 0);
  assert.ok(second.expectedExisting.some(f => f.displayName === 'generated.html'));
  // Crash boundary: the first child's commit is durable, but the parent has no receipt yet.
  await applyJob(join(staged.directory, staged.job.jobs[0]));
  const result = await applyJobs(staged.path);
  assert.equal(result.threads.length, f.ids.length); assert.equal(result.backupPaths.length, 2);
  assert.equal((await inspectTarget(f.target)).projects.length, 1);
  const db = new DatabaseSync(join(f.target, 'userdata/statev2.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM orchestration_v2_projection_threads').get().n, f.ids.length);
    for (const { payload_json } of db.prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE role='assistant'").all()) assert.match(JSON.parse(payload_json).text, /\.\/generated\.html/);
  } finally { db.close(); }
  assert.equal((await applyJobs(staged.path)).importedAt, result.importedAt);
  assert.deepEqual(await Promise.all(f.paths.map(p => readFile(p).then(hash))), sources);
  const rescanned = await api('scan', {});
  assert.ok(rescanned.chats.every(c => c.existing));
});

test('bulk partial failure keeps verified batches and retry finishes without duplicates', async t => {
  const f = await bulkFixture(t, 21), index = await discoverCodex(f.source, { days: 0 });
  const staged = await stageJobs(index, f.target, index.chats.map(c => ({ id: c.id })), { jobRoot: join(f.root, 'jobs') });
  staged.job.reopen = true;
  await writeFile(staged.path, JSON.stringify(staged.job));
  const last = JSON.parse(await readFile(join(staged.directory, staged.job.jobs.at(-1)), 'utf8'));
  const file = last.files[0], original = await readFile(file.staged);
  await writeFile(file.staged, 'changed');
  await assert.rejects(applyJobs(staged.path), /Staged file changed/);
  const failed = JSON.parse(await readFile(join(staged.directory, 'status.json'), 'utf8'));
  assert.equal(failed.phase, 'failed'); assert.equal(failed.completedBatches, 1); assert.equal(failed.result.threads.length, 20);
  assert.equal(Object.keys((await inspectTarget(f.target)).owners).length, 20);
  await writeFile(file.staged, original);
  const retry = spawnSync(process.execPath, ['bin/threadlift.mjs', 'apply', '--job', staged.path], { encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).threads.length, 21);
  assert.equal(JSON.parse(await readFile(join(staged.directory, 'status.json'), 'utf8')).phase, 'complete');
  assert.equal(Object.keys((await inspectTarget(f.target)).owners).length, 21);
});
