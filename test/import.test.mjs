import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures.mjs';
import { discoverCodex, readConversation } from '../src/codex.mjs';
import { stageJob } from '../src/stage.mjs';
import { applyJob, inspectTarget, acquireOwnership, releaseOwnership } from '../src/target.mjs';

test('imports all 260 messages, uploads, moved-project assignment and actual scratch files', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const index = await discoverCodex(f.source);
  assert.equal(index.chats[0].root, f.workspace); assert.equal(index.chats[0].assignment, 'Codex desktop');
  const conversation = await readConversation(index.chats[0], index);
  assert.equal(conversation.messages.length, 260); assert.equal(conversation.assets.filter(a => !a.error).length, 2);
  const staged = await stageJob(index, f.target, [{ id: f.id, recoverWorkspace: true }], { jobRoot: join(f.root,'jobs') });
  const receipt = await applyJob(staged.path);
  assert.equal(receipt.threads[0].messages, 260);
  assert.equal(await readFile(join(f.workspace, 'result.txt'), 'utf8'), 'A real workspace file.');
  assert.equal((await inspectTarget(f.target)).owners[f.id], `import:codex:${f.id}`);
  await assert.rejects(stageJob(index, f.target, [{ id: f.id }], { jobRoot: join(f.root,'jobs') }), /already in T3/);
  assert.equal((await readConversation(index.chats[0], index)).sourceHash, conversation.sourceHash);
});

test('verification failure rolls back the entire SQL transaction and removes only owned new files', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const index = await discoverCodex(f.source);
  const staged = await stageJob(index, f.target, [{ id: f.id }], { jobRoot: join(f.root,'jobs') });
  await assert.rejects(applyJob(staged.path, { failAfterWrite: true }), /Injected/);
  assert.equal((await inspectTarget(f.target)).owners[f.id], undefined);
  const db = new DatabaseSync(join(f.target,'userdata/statev2.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM orchestration_v2_projection_threads').get().n, 0); db.close();
});

test('does not write while the official server ownership lock is held', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const index = await discoverCodex(f.source);
  const staged = await stageJob(index, f.target, [{ id: f.id }], { jobRoot: join(f.root,'jobs') });
  const held = acquireOwnership(join(f.target,'userdata'));
  try { await assert.rejects(applyJob(staged.path, { waitMs: 0 }), /Timed out/); }
  finally { releaseOwnership(held); }
  assert.equal((await inspectTarget(f.target)).owners[f.id], undefined);
});

test('restarts after a process crash during file copying without clobbering or duplicating', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const index = await discoverCodex(f.source), staged = await stageJob(index, f.target, [{ id:f.id, recoverWorkspace:true }], {jobRoot:join(f.root,'jobs')});
  const { spawnSync } = await import('node:child_process');
  const crash = spawnSync(process.execPath, ['test/crash-worker.mjs',staged.path,'file'], {encoding:'utf8'});
  assert.equal(crash.status,91,crash.stderr);
  assert.equal((await inspectTarget(f.target)).owners[f.id],undefined);
  const receipt = await applyJob(staged.path);
  assert.equal(receipt.files,5);
  assert.equal(receipt.threads[0].messages,260);
  assert.equal((await applyJob(staged.path)).importedAt,receipt.importedAt);
});

test('a crash immediately after SQL commit is verified on retry, never imported twice', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const index=await discoverCodex(f.source), staged=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')});
  const { spawnSync }=await import('node:child_process');
  const crash=spawnSync(process.execPath,['test/crash-worker.mjs',staged.path,'commit'],{encoding:'utf8'});
  assert.equal(crash.status,91,crash.stderr);
  const db=new DatabaseSync(staged.job.target.dbPath,{readOnly:true});
  const before=db.prepare('SELECT count(*) AS n FROM orchestration_events').get().n;db.close();
  const receipt=await applyJob(staged.path);
  assert.equal(receipt.threads[0].messages,260);
  const check=new DatabaseSync(staged.job.target.dbPath,{readOnly:true});
  assert.equal(check.prepare('SELECT count(*) AS n FROM orchestration_events').get().n,before);check.close();
});

test('postcommit verification failure preserves committed chats and later changes', async t => {
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));
  const index=await discoverCodex(f.source),staged=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')});
  await assert.rejects(applyJob(staged.path,{afterCommit:async()=>{await (await import('node:fs/promises')).writeFile(staged.job.files[0].destination,'changed later');}}),/File verification/);
  assert.equal((await inspectTarget(f.target)).owners[f.id],`import:codex:${f.id}`);
  assert.equal(await readFile(staged.job.files[0].destination,'utf8'),'changed later');
  await assert.rejects(applyJob(staged.path),/File verification/);
  assert.equal(await readFile(staged.job.files[0].destination,'utf8'),'changed later');
});

test('a file changed during a failed precommit import is retained, and executable workspace modes survive',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));const fs=await import('node:fs/promises');
  await fs.writeFile(join(f.scratch,'run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const index=await discoverCodex(f.source),staged=await stageJob(index,f.target,[{id:f.id,recoverWorkspace:true}],{jobRoot:join(f.root,'jobs')});
  await assert.rejects(applyJob(staged.path,{afterFile:async i=>{if(i===0){await fs.writeFile(staged.job.files[0].destination,'changed by another process');throw new Error('Stop before commit');}}}),/Stop before commit/);
  assert.equal(await readFile(staged.job.files[0].destination,'utf8'),'changed by another process');
  assert.equal((await inspectTarget(f.target)).owners[f.id],undefined);
  const fresh=await stageJob(index,f.target,[{id:f.id,recoverWorkspace:true}],{jobRoot:join(f.root,'jobs')});await applyJob(fresh.path);
  assert.equal((await fs.stat(join(f.workspace,'run.sh'))).mode&0o777,0o755);
});

test('a project created after staging causes a rescan request, without duplicate project rows',async t=>{
  const f=await fixture();t.after(()=>rm(f.root,{recursive:true,force:true}));const index=await discoverCodex(f.source);
  const staged=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')});
  const {makeProject}=await import('../src/target.mjs'),{applyBatch}=await import('../vendor/t3-v0.1.12.mjs');
  await applyBatch(staged.job.target.dbPath,{projects:[makeProject('created-in-the-meantime',f.workspace,'Existing project')],threads:[]});
  await assert.rejects(applyJob(staged.path),/created after preparation/);
  const target=await inspectTarget(f.target);assert.equal(target.projects.length,1);assert.equal(target.owners[f.id],undefined);
});
