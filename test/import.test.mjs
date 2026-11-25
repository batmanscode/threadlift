import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, rename, rm, copyFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './fixtures.mjs';
import { discoverCodex, readConversation } from '../src/codex.mjs';
import { stageJob } from '../src/stage.mjs';
import { applyBatch } from '../vendor/t3-v0.1.12.mjs';
import { applyJob, inspectTarget, acquireOwnership, releaseOwnership, makeProject } from '../src/target.mjs';

test('imports all 260 messages, uploads, moved-project assignment and actual scratch files', async t => {
  const f = await fixture(t, { turns: 130 });
  await writeFile(join(f.scratch, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const index = await discoverCodex(f.source);
  assert.equal(index.chats[0].root, f.workspace); assert.equal(index.chats[0].assignment, 'Codex desktop');
  const conversation = await readConversation(index.chats[0], index);
  assert.equal(conversation.messages.length, 260); assert.equal(conversation.assets.filter(a => !a.error).length, 2);
  const staged = await stageJob(index, f.target, [{ id: f.id, recoverWorkspace: true }], { jobRoot: join(f.root,'jobs') });
  const receipt = await applyJob(staged.path);
  assert.equal(receipt.threads[0].messages, 260);
  assert.equal(await readFile(join(f.workspace, 'result.txt'), 'utf8'), 'A real workspace file.');
  assert.equal((await stat(join(f.workspace, 'run.sh'))).mode & 0o777, 0o755);
  assert.equal((await inspectTarget(f.target)).owners[f.id], `import:codex:${f.id}`);
  await assert.rejects(stageJob(index, f.target, [{ id: f.id }], { jobRoot: join(f.root,'jobs') }), /already in T3/);
  assert.equal((await readConversation(index.chats[0], index)).sourceHash, conversation.sourceHash);
});

test('verification failure rolls back the entire SQL transaction and removes only owned new files', async t => {
  const f = await fixture(t);
  const index = await discoverCodex(f.source);
  const staged = await stageJob(index, f.target, [{ id: f.id }], { jobRoot: join(f.root,'jobs') });
  await assert.rejects(applyJob(staged.path, { failAfterWrite: true }), /Injected/);
  assert.equal((await inspectTarget(f.target)).owners[f.id], undefined);
  for (const file of staged.job.files) await assert.rejects(stat(file.destination), { code: 'ENOENT' });
  const db = new DatabaseSync(join(f.target,'userdata/statev2.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM orchestration_v2_projection_threads').get().n, 0); db.close();
});

test('does not write while the official server ownership lock is held', async t => {
  const f = await fixture(t);
  const index = await discoverCodex(f.source);
  const staged = await stageJob(index, f.target, [{ id: f.id }], { jobRoot: join(f.root,'jobs') });
  const held = acquireOwnership(join(f.target,'userdata'));
  try { await assert.rejects(applyJob(staged.path, { waitMs: 0 }), /Timed out/); }
  finally { releaseOwnership(held); }
  assert.equal((await inspectTarget(f.target)).owners[f.id], undefined);
});

test('restarts after a process crash during file copying without clobbering or duplicating', async t => {
  const f = await fixture(t);
  const index = await discoverCodex(f.source), staged = await stageJob(index, f.target, [{ id:f.id, recoverWorkspace:true }], {jobRoot:join(f.root,'jobs')});
  const crash = spawnSync(process.execPath, ['test/crash-worker.mjs',staged.path,'file'], {encoding:'utf8'});
  assert.equal(crash.status,91,crash.stderr);
  assert.equal((await inspectTarget(f.target)).owners[f.id],undefined);
  const receipt = await applyJob(staged.path);
  assert.equal(receipt.files,5);
  assert.equal(receipt.threads[0].messages,2);
  const held = acquireOwnership(join(f.target,'userdata'));
  try { assert.equal((await applyJob(staged.path, {waitMs:0})).importedAt,receipt.importedAt); }
  finally { releaseOwnership(held); }
  for (const file of staged.job.files) assert.equal((await stat(file.destination)).isFile(),true);
});

test('a crash immediately after SQL commit is verified on retry, never imported twice', async t => {
  const f = await fixture(t);
  const index=await discoverCodex(f.source), staged=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')});
  const crash=spawnSync(process.execPath,['test/crash-worker.mjs',staged.path,'commit'],{encoding:'utf8'});
  assert.equal(crash.status,91,crash.stderr);
  const held=acquireOwnership(join(f.target,'userdata'));
  try { await assert.rejects(applyJob(staged.path,{waitMs:0}),/Timed out/); }
  finally { releaseOwnership(held); }
  for (const file of staged.job.files) assert.equal((await stat(file.destination)).isFile(),true);
  const db=new DatabaseSync(staged.job.target.dbPath,{readOnly:true});
  const before=db.prepare('SELECT count(*) AS n FROM orchestration_events').get().n;db.close();
  // T3 can recover a failed resume by retaining this app thread with a new native session.
  const edited=new DatabaseSync(staged.job.target.dbPath);
  const provider=edited.prepare('SELECT provider_thread_id,payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?').get(staged.job.batch.threads[0].runtime.threadId);
  const changed=JSON.parse(provider.payload_json);changed.nativeThreadRef.nativeId=randomUUID();
  edited.prepare('UPDATE orchestration_v2_projection_provider_threads SET payload_json=? WHERE provider_thread_id=?').run(JSON.stringify(changed),provider.provider_thread_id);edited.close();
  await assert.rejects(applyJob(staged.path),/Project\/provider readback mismatch/);
  for(const file of staged.job.files)assert.equal((await stat(file.destination)).isFile(),true);
  const restored=new DatabaseSync(staged.job.target.dbPath);
  restored.prepare('UPDATE orchestration_v2_projection_provider_threads SET payload_json=? WHERE provider_thread_id=?').run(provider.payload_json,provider.provider_thread_id);restored.close();
  const receipt=await applyJob(staged.path);
  assert.equal(receipt.threads[0].messages,2);
  const check=new DatabaseSync(staged.job.target.dbPath,{readOnly:true});
  assert.equal(check.prepare('SELECT count(*) AS n FROM orchestration_events').get().n,before);check.close();
});

test('postcommit verification failure preserves committed chats and later changes', async t => {
  const f=await fixture(t);
  const index=await discoverCodex(f.source),staged=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')});
  await assert.rejects(applyJob(staged.path,{afterCommit:async()=>{await writeFile(staged.job.files[0].destination,'changed later');}}),/File verification/);
  assert.equal((await inspectTarget(f.target)).owners[f.id],`import:codex:${f.id}`);
  assert.equal(await readFile(staged.job.files[0].destination,'utf8'),'changed later');
  await assert.rejects(applyJob(staged.path),/File verification/);
  assert.equal(await readFile(staged.job.files[0].destination,'utf8'),'changed later');
});

test('a file changed during a failed precommit import is retained',async t=>{
  const f=await fixture(t);
  const index=await discoverCodex(f.source),staged=await stageJob(index,f.target,[{id:f.id,recoverWorkspace:true}],{jobRoot:join(f.root,'jobs')});
  await assert.rejects(applyJob(staged.path,{afterFile:async i=>{if(i===0){await writeFile(staged.job.files[0].destination,'changed by another process');throw new Error('Stop before commit');}}}),/Stop before commit/);
  assert.equal(await readFile(staged.job.files[0].destination,'utf8'),'changed by another process');
  assert.equal((await inspectTarget(f.target)).owners[f.id],undefined);
});

test('a project created after staging causes a rescan request, without duplicate project rows',async t=>{
  const f=await fixture(t);const index=await discoverCodex(f.source);
  const staged=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')});
  await applyBatch(staged.job.target.dbPath,{projects:[makeProject('created-in-the-meantime',f.workspace,'Existing project')],threads:[]});
  await assert.rejects(applyJob(staged.path),/created after preparation/);
  const target=await inspectTarget(f.target);assert.equal(target.projects.length,1);assert.equal(target.owners[f.id],undefined);
  const rescanned=await stageJob(index,f.target,[{id:f.id,root:'~/'+relative(homedir(),f.workspace)+'/'}],{jobRoot:join(f.root,'jobs')});
  assert.equal(rescanned.job.batch.projects.length,0);
  assert.equal(rescanned.job.batch.threads[0].runtime.runtimePayload.cwd,f.workspace);
});


test('a new import after project deletion creates an active project with a fresh identity',async t=>{
  const f=await fixture(t),index=await discoverCodex(f.source),options={jobRoot:join(f.root,'jobs')};
  const first=await stageJob(index,f.target,[{id:f.id}],options),project=first.job.batch.projects[0];
  await applyBatch(first.job.target.dbPath,{projects:[project],threads:[]});
  await applyBatch(first.job.target.dbPath,{projects:[{...project,type:'project.deleted',eventId:'review-delete',commandId:'review-delete',correlationId:'review-delete',payload:{projectId:project.aggregateId,deletedAt:new Date().toISOString()}}],threads:[]});
  const second=await stageJob(index,f.target,[{id:f.id}],options);
  await applyJob(second.path);
  const target=await inspectTarget(f.target);
  assert.equal(target.projects.length,1);assert.equal(target.projects[0].root,f.workspace);
  assert.notEqual(target.projects[0].id,project.aggregateId);
});

test('a project folder renamed after preparation is rejected before the history commits',async t=>{
  const f=await fixture(t),index=await discoverCodex(f.source);
  const staged=await stageJob(index,f.target,[{id:f.id}],{jobRoot:join(f.root,'jobs')});
  await rename(f.workspace,f.workspace+'-moved');
  await assert.rejects(applyJob(staged.path),/folder moved or is missing/);
  assert.equal((await inspectTarget(f.target)).owners[f.id],undefined);
});

test('an identical workspace file must still exist when the prepared import applies',async t=>{
  const f=await fixture(t);await copyFile(join(f.scratch,'result.txt'),join(f.workspace,'result.txt'));
  const index=await discoverCodex(f.source),staged=await stageJob(index,f.target,[{id:f.id,recoverWorkspace:true}],{jobRoot:join(f.root,'jobs')});
  await rm(join(f.workspace,'result.txt'));
  await assert.rejects(applyJob(staged.path),/previously identical file is missing or changed/);
  assert.equal((await inspectTarget(f.target)).owners[f.id],undefined);
});
