import { DatabaseSync, backup } from 'node:sqlite';
import { readFile, mkdir, lstat, realpath, rename, open } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { hash, inside, expand } from './codex.mjs';
import { jobLock, installFile, cleanOwnedFiles } from './recovery.mjs';
import { applyBatch, upstream, providerThreadId, createAttachmentId, attachmentFileExtension, projectDefaults } from '../vendor/t3-v0.1.12.mjs';

export const CRITICAL_TABLES = ['effect_sql_migrations', 'projection_projects', 'orchestration_events', 'orchestration_v2_projection_threads',
  'orchestration_v2_projection_messages', 'orchestration_v2_projection_turn_items', 'orchestration_v2_projection_provider_threads',
  'provider_session_runtime', 'orchestration_v2_projection_metadata', 'orchestration_v2_turn_item_positions'];
export function schemaSignature(db) {
  const columns = Object.fromEntries(CRITICAL_TABLES.map(t => [t, db.prepare(`PRAGMA table_info(${t})`).all().map(r => ({ name: r.name, type: r.type, notnull: r.notnull, pk: r.pk }))]));
  const migrations = db.prepare('SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id>=55 ORDER BY migration_id').all();
  return { version: upstream.version, columns, migrations };
}
export async function compatible(db) {
  const expected = JSON.parse(await readFile(new URL('../adapters/t3-v0.1.12-schema.json', import.meta.url), 'utf8'));
  if (JSON.stringify(schemaSignature(db)) !== JSON.stringify(expected)) throw new Error('This T3 database does not match the tested 0.1.12 format. Nothing was imported.');
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
}
export async function inspectTarget(t3Home) {
  const home = await realpath(expand(t3Home)), state = join(home, 'userdata'), dbPath = join(state, 'statev2.sqlite');
  if ((await lstat(dbPath)).isSymbolicLink()) throw new Error('T3 database is a symlink; use its actual profile directory.');
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 });
  try {
    await compatible(db);
    const projects = db.prepare('SELECT project_id AS id,title,workspace_root AS root FROM projection_projects WHERE deleted_at IS NULL').all();
    const owners = {};
    for (const r of db.prepare('SELECT thread_id,payload_json FROM orchestration_v2_projection_provider_threads').all()) {
      const p = JSON.parse(r.payload_json); if (p.nativeThreadRef?.driver === 'codex') owners[p.nativeThreadRef.nativeId] = r.thread_id;
    }
    const runtime = await readFile(join(state, 'server-runtime.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (runtime?.serverVersion && runtime.serverVersion !== upstream.version) throw new Error(`T3 ${runtime.serverVersion} is running; this release supports ${upstream.version}.`);
    if (runtime?.managedPolicy) throw new Error('Managed T3 environments are not supported by this personal recovery tool.');
    const settings = await readFile(join(state, 'settings.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return {}; throw e; });
    return { home, state, dbPath, version: upstream.version, projects, owners, settings,
      fingerprint: hash(JSON.stringify(schemaSignature(db))) };
  } finally { db.close(); }
}
export function acquireOwnership(state) {
  // Same lifetime lock as T3's serverOwnership.ts. Never unlink this file.
  const path = join(state, 'server-owner.sqlite');
  const db = new DatabaseSync(path, { timeout: 250 });
  try { db.exec('PRAGMA busy_timeout=250; BEGIN EXCLUSIVE'); return { db, path }; }
  catch (e) { db.close(); if (e.errcode === 5 || e.code === 'SQLITE_BUSY') return null; throw e; }
}
export function releaseOwnership(lock) { try { lock.db.exec('ROLLBACK'); } finally { lock.db.close(); } }

export function makeThread(conversation, projectId, root, attachments, defaults) {
  const instance = 'codex', id = `import:${instance}:${conversation.id}`;
  const providerId = providerThreadId(instance, conversation.id);
  const prefix = `threadlift:v1:${conversation.id}`;
  const createdAt = conversation.messages[0]?.createdAt || conversation.createdAt;
  const updatedAt = conversation.messages.at(-1)?.createdAt || conversation.updatedAt;
  const app = { createdBy: 'system', creationSource: 'server', id, projectId, title: conversation.title,
    providerInstanceId: instance, modelSelection: { instanceId: instance, model: conversation.model || defaults.model },
    runtimeMode: defaults.runtimeMode, interactionMode: 'default', branch: null, worktreePath: null,
    linkedPullRequest: null, branchPullRequest: null, activeProviderThreadId: providerId, historyOrigin: 'v1_import',
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, forkedFrom: null,
    createdAt, updatedAt, archivedAt: null, settledOverride: 'settled', settledAt: updatedAt, unsettledAt: null,
    snoozedUntil: null, snoozedAt: null, pinnedAt: null, pinOrderKey: null, activeOrderKey: null, lastVisitedAt: null, deletedAt: null };
  const provider = { id: providerId, driver: 'codex', providerInstanceId: instance, providerSessionId: null,
    appThreadId: id, ownerNodeId: null, nativeThreadRef: { driver: 'codex', nativeId: conversation.id, strength: 'strong' },
    nativeConversationHeadRef: null, status: 'idle', firstRunOrdinal: null, lastRunOrdinal: null, handoffIds: [],
    forkedFrom: null, pendingBackgroundTasks: [], createdAt, updatedAt };
  const events = [{ id: `${prefix}:created`, type: 'thread.created', threadId: id, providerInstanceId: instance, occurredAt: createdAt, payload: app }];
  for (const [index, m] of conversation.messages.entries()) {
    const messageId = `${id}:${String(index).padStart(6, '0')}`, turnId = `${prefix}:item:${index}`;
    const refs = attachments.filter(a => a.messageIndex === index).map(a => a.attachment);
    const message = { createdBy: m.role === 'user' ? 'user' : 'agent', creationSource: 'server', id: messageId,
      threadId: id, runId: null, nodeId: null, role: m.role, text: m.text, attachments: refs, streaming: false,
      createdAt: m.createdAt, updatedAt: m.createdAt };
    const item = { id: turnId, threadId: id, runId: null, nodeId: null, providerThreadId: null, providerTurnId: null,
      nativeItemRef: null, parentItemId: null, ordinal: index + 1, status: 'completed', title: null,
      startedAt: m.createdAt, completedAt: m.createdAt, updatedAt: m.createdAt,
      ...(m.role === 'user' ? { createdBy: 'user', creationSource: 'server', type: 'user_message', messageId, inputIntent: 'turn_start', text: m.text, attachments: refs }
        : { type: 'assistant_message', messageId, text: m.text, streaming: false }) };
    events.push({ id: `${prefix}:message:${index}`, type: 'message.updated', threadId: id, occurredAt: m.createdAt, payload: message },
      { id: turnId, type: 'turn-item.updated', threadId: id, occurredAt: m.createdAt, payload: item });
  }
  events.push({ id: `${prefix}:provider`, type: 'provider-thread.updated', threadId: id, driver: 'codex', providerInstanceId: instance, occurredAt: updatedAt, payload: provider });
  return { sourceId: conversation.id, title: conversation.title, provider, events,
    runtime: { threadId: id, providerName: 'codex', providerInstanceId: instance, adapterKey: 'codex',
      runtimeMode: defaults.runtimeMode, status: 'stopped', lastSeenAt: updatedAt,
      resumeCursor: { threadId: conversation.id }, runtimePayload: { cwd: root } } };
}
export function makeProject(id, root, title) {
  const at = new Date().toISOString(), commandId = `threadlift:project:${id}`;
  return { sequence: 0, eventId: `${commandId}:created`, aggregateKind: 'project', aggregateId: id, occurredAt: at,
    commandId, causationEventId: null, correlationId: commandId, metadata: {}, type: 'project.created',
    payload: { projectId: id, title, workspaceRoot: root, defaultModelSelection: null, faviconPath: null,
      projectIcon: null, scripts: [], createdAt: at, updatedAt: at } };
}
export function attachmentRecord(threadId, asset) {
  const extension = attachmentFileExtension(asset.name), id = createAttachmentId(threadId, asset.type === 'file' ? extension : undefined);
  if (!id) throw new Error('Cannot derive T3 attachment ID.');
  return { id, fileName: id + (asset.type === 'image' ? ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[asset.mimeType] : extension),
    attachment: { type: asset.type, id, name: asset.name, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes } };
}
export { projectDefaults };

export async function verifyJob(job) {
  const db = new DatabaseSync(job.target.dbPath, { readOnly: true, timeout: 2000 });
  const results = [];
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('T3 database integrity verification failed.');
    for (const thread of job.batch.threads) {
      const expected = thread.events.filter(e => e.type === 'message.updated').map(e => e.payload);
      const messages = db.prepare('SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? ORDER BY created_at,message_id').all(thread.runtime.threadId).map(r => JSON.parse(r.payload_json));
      const byId = new Map(messages.map(m => [m.id, m]));
      if (messages.length !== expected.length || expected.some(m => !byId.has(m.id) || byId.get(m.id).text !== m.text || JSON.stringify(byId.get(m.id).attachments) !== JSON.stringify(m.attachments))) throw new Error(`History readback mismatch: ${thread.title}`);
      const runtime = db.prepare('SELECT resume_cursor_json,runtime_payload_json FROM provider_session_runtime WHERE thread_id=?').get(thread.runtime.threadId);
      if (JSON.parse(runtime?.resume_cursor_json || '{}').threadId !== thread.sourceId || JSON.parse(runtime?.runtime_payload_json || '{}').cwd !== thread.runtime.runtimePayload.cwd) throw new Error(`Continuation binding mismatch: ${thread.title}`);
      const app = db.prepare('SELECT project_id,active_provider_thread_id FROM orchestration_v2_projection_threads WHERE thread_id=?').get(thread.runtime.threadId);
      const providers = db.prepare('SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id=?').all(thread.runtime.threadId).map(r => JSON.parse(r.payload_json));
      const items = db.prepare('SELECT count(*) AS n FROM orchestration_v2_projection_turn_items WHERE thread_id=?').get(thread.runtime.threadId).n;
      if (app?.project_id !== thread.events[0].payload.projectId || app?.active_provider_thread_id !== thread.provider.id ||
          providers.filter(p => p.nativeThreadRef?.nativeId === thread.sourceId && p.providerInstanceId === 'codex').length !== 1 || items !== expected.length)
        throw new Error(`Project/provider readback mismatch: ${thread.title}`);
      results.push({ sourceId: thread.sourceId, threadId: thread.runtime.threadId, title: thread.title, messages: messages.length,
        history: 'verified', continuation: 'bound; follow-up not yet tested' });
    }
  } finally { db.close(); }
  for (const file of job.files) {
    const bytes = await readFile(file.destination);
    if (hash(bytes) !== file.sha256) throw new Error(`File verification failed: ${file.displayName}`);
  }
  return results;
}

export async function applyJob(jobPath, { waitMs = 20 * 60_000, onStatus = async () => {}, failAfterWrite = false, afterCommit, afterFile } = {}) {
  const jobDir = dirname(await realpath(jobPath)), statusPath = join(jobDir, 'status.json');
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  if (job.format !== 'threadlift-job-v1') throw new Error('Unsupported recovery job.');
  const unlockJob = jobLock(jobDir);
  const status = async (phase, detail, extra = {}) => { const value = { phase, detail, updatedAt: new Date().toISOString(), ...extra }; await atomicJson(statusPath, value); await onStatus(value); };
  const journalPath = join(jobDir, 'journal.json');
  let journal = { phase: 'new', files: [] };
  const save = () => atomicJson(journalPath, journal);
  let ownership, databaseCommitted = false, journalLoaded = false;
  try {
    journal = await readFile(journalPath, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return journal; throw e; });
    journalLoaded = true;
    const started = Date.now();
    await status('waiting', 'Finish other T3 work, then quit T3 Code with Cmd+Q.');
    while (!(ownership = acquireOwnership(job.target.state))) {
      if (Date.now() - started >= waitMs) throw new Error('Timed out waiting for T3 to quit. No data was imported.');
      await new Promise(r => setTimeout(r, 1000));
    }
    const target = await inspectTarget(job.target.home);
    if (journal.phase === 'verified') {
      const result = JSON.parse(await readFile(join(jobDir, 'receipt.json'), 'utf8'));
      await status('complete', 'This job was already verified. Nothing was imported again.', { result });
      return result;
    }
    if (target.fingerprint !== job.target.fingerprint) throw new Error('The T3 format changed after review. Rescan before importing.');
    const owned = job.batch.threads.map(t => target.owners[t.sourceId]);
    if (owned.some(Boolean)) {
      if (journal.phase === 'new' || !owned.every((id,i) => id === job.batch.threads[i].runtime.threadId)) throw new Error('A selected chat is already in T3. Rescan; existing imports stay unchanged.');
      // A crashed transaction either committed the whole batch or none of it.
      // Never replay or overwrite a chat that may have continued since then.
      databaseCommitted = true;
    } else {
      if (job.batch.projects.some(p => target.projects.some(existing => resolve(existing.root) === resolve(p.payload.workspaceRoot)))) throw new Error('A project for this folder was created after preparation. Rescan to use it.');
      for (const thread of job.batch.threads) if (!target.projects.some(p => p.id === thread.events[0].payload.projectId) && !job.batch.projects.some(p => p.aggregateId === thread.events[0].payload.projectId)) throw new Error('A selected T3 project was removed. Rescan before importing.');
      for (const thread of job.batch.threads) {
        const defaults = projectDefaults(target.settings, thread.events[0].payload.projectId);
        const home = await realpath(expand(defaults.codexHome || join(homedir(), '.codex'))).catch(() => null);
        if (home !== job.codexHome) throw new Error('T3’s Codex home changed after preparation. Rescan with matching homes.');
      }
      for (const file of job.files) {
        if (!inside(jobDir, file.staged) || !inside(jobDir, await realpath(file.staged))) throw new Error('Staged file escapes its job directory.');
        if (hash(await readFile(file.staged)) !== file.sha256) throw new Error(`Staged file changed: ${file.displayName}`);
      }
      await status('backing-up', 'Making a consistent backup of T3.');
      journal.backupPath = join(jobDir, journal.backupPath ? `before-${randomUUID()}.sqlite` : 'before.sqlite');
      const source = new DatabaseSync(target.dbPath, { readOnly: true, timeout: 2000 });
      try { await backup(source, journal.backupPath); } finally { source.close(); }
      journal.phase = 'copying'; await save();
      await status('importing', 'Importing the selected chats and files.');
      for (const [i,file] of job.files.entries()) { await installFile(file, i, job, journal, save); await afterFile?.(i); }
      for (const file of job.files) if (hash(await readFile(file.destination)) !== file.sha256) throw new Error(`File verification failed: ${file.displayName}`);
      await applyBatch(target.dbPath, job.batch, { failBeforeCommit: failAfterWrite });
      databaseCommitted = true;
      await afterCommit?.();
      journal.phase = 'committed'; await save();
    }
    await status('verifying', 'Checking imported messages, file hashes, and session bindings.');
    const threads = await verifyJob(job);
    const result = { format: 'threadlift-receipt-v1', importedAt: new Date().toISOString(), threads, files: job.files.length,
      fileCounts: Object.fromEntries(['attachment','workspace'].map(kind => [kind, job.files.filter(f => f.kind === kind).length])),
      missing: job.missing, skipped: job.skipped, backupPath: journal.backupPath, sourceUnchanged: true,
      continuation: 'Original session IDs and working folders verified; this import does not send a live follow-up.' };
    await atomicJson(join(jobDir, 'receipt.json'), result);
    journal.phase = 'verified'; await save();
    await cleanOwnedFiles(journal, { destinations: false });
    await status(job.reopen ? 'reopening' : 'complete', job.reopen ? 'Import verified. Reopening T3.' : 'Import verified. Open T3 when ready.', { result });
    return result;
  } catch (error) {
    const retainedFiles = databaseCommitted || !journalLoaded ? [] : await cleanOwnedFiles(journal);
    if (!databaseCommitted && journalLoaded) { journal.files = journal.files.filter(e => retainedFiles.includes(e.temporary) || retainedFiles.includes(e.destination)); journal.phase = 'stopped'; await save(); }
    await status('failed', error.message, { databaseCommitted, retainedFiles, backupPath: journal.backupPath,
      recovery: databaseCommitted ? 'Imported data was preserved. Re-run this job to verify it; never restore a backup over newer work.' : 'The database transaction did not commit. Files changed by another process were left untouched.' });
    throw error;
  } finally {
    if (ownership) releaseOwnership(ownership);
    unlockJob();
  }
}

export function readAppVersion(appPath) {
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }));
  const version = info.CFBundleShortVersionString;
  if (!String(info.CFBundleName || '').includes('T3') || version !== upstream.version) throw new Error(`Expected T3 Code ${upstream.version} at ${appPath}.`);
  return version;
}
