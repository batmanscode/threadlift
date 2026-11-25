import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { readConversation, workspaceInventory, hash, inside, expand, LIMITS } from './codex.mjs';
import { inspectTarget, makeThread, makeProject, attachmentRecord, projectDefaults, atomicJson } from './target.mjs';

export const defaultJobRoot = () => join(homedir(), 'Library/Application Support/Threadlift/jobs');

export async function stageJob(index, t3Home, selections, { jobRoot = defaultJobRoot(), acceptMissing = false } = {}) {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 20) throw new Error('Select between 1 and 20 chats.');
  if (new Set(selections.map(s => s.id)).size !== selections.length) throw new Error('A chat was selected twice.');
  const target = await inspectTarget(t3Home);
  const id = randomUUID(), directory = join(expand(jobRoot), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const job = { format: 'threadlift-job-v1', codexHome: index.codexHome, id, createdAt: new Date().toISOString(),
    target: { home: target.home, state: target.state, dbPath: target.dbPath, fingerprint: target.fingerprint, version: target.version },
    batch: { projects: [], threads: [] }, files: [], missing: [], skipped: [], sources: [] };
  let stagedBytes = 0;
  const projects = new Map(target.projects.map(p => [resolve(p.root), p.id]));
  async function stageBytes(bytes, destination, displayName, kind, root, mode) {
    const planned = job.files.find(f => f.destination === destination);
    if (planned) {
      if (planned.sha256 !== hash(bytes)) throw new Error(`Selected chats contain conflicting files: ${destination}`);
      return;
    }
    stagedBytes += bytes.length;
    if (stagedBytes > LIMITS.stagedBytes) throw new Error('Selected recovery exceeds the 1 GiB staging limit.');
    const sha256 = hash(bytes), staged = join(directory, 'files', `${job.files.length}-${sha256}`);
    await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
    await writeFile(staged, bytes, { mode: 0o600, flag: 'wx' });
    job.files.push({ staged, destination, sha256, sizeBytes: bytes.length, displayName, kind, ...(root ? { root, mode } : {}) });
  }
  for (const selected of selections) {
    if (!selected || typeof selected.id !== 'string' || (selected.root !== undefined && (typeof selected.root !== 'string' || !selected.root.trim())) ||
      (selected.recoverWorkspace !== undefined && typeof selected.recoverWorkspace !== 'boolean') ||
      (selected.assets !== undefined && (!Array.isArray(selected.assets) || selected.assets.some(a => typeof a !== 'string')))) throw new Error('Invalid chat selection.');
    const meta = index.chats.find(c => c.id === selected.id);
    if (!meta) throw new Error('Selected chat is not in this scan. Rescan first.');
    if (target.owners[meta.id]) throw new Error(`“${meta.title}” is already in T3. Existing or partial imports will not be overwritten.`);
    const conversation = await readConversation(meta, index);
    if (selected.sourceHash && selected.sourceHash !== conversation.sourceHash) throw new Error(`“${meta.title}” changed after preview. Review it again.`);
    const rootValue = selected.root ?? (conversation.root || conversation.cwd);
    if (!rootValue) throw new Error('Choose the current project folder for this chat.');
    const root = expand(rootValue);
    if (!root || root === '/') throw new Error('Choose the project folder for this chat.');
    if (!(await lstat(root).catch(() => null))?.isDirectory()) throw new Error(`Project folder not found: ${root}. Locate its current path before importing.`);
    if ((await realpath(root)) !== resolve(root)) throw new Error('Choose the real project folder rather than a symlink.');
    let projectId = projects.get(root);
    if (!projectId) {
      projectId = `threadlift-project-${hash(root).slice(0,24)}`; projects.set(root, projectId);
      job.batch.projects.push(makeProject(projectId, root, basename(root)));
    }
    const defaults = projectDefaults(target.settings, projectId);
    const providerHome = await realpath(expand(defaults.codexHome || join(homedir(), '.codex'))).catch(() => null);
    if (providerHome !== index.codexHome) throw new Error('The selected Codex home differs from the home used by T3’s default Codex instance. Choose matching homes first; Threadlift does not move credentials or provider histories.');
    const threadId = `import:codex:${conversation.id}`, attachments = [];
    if (selected.assets?.some(k => !conversation.assets.some(a => a.key === k))) throw new Error('A selected file is no longer in this conversation. Review it again.');
    const chosen = selected.assets === undefined ? new Set(conversation.assets.filter(a => a.kind === 'upload').map(a => a.key)) : new Set(selected.assets);
    for (const asset of conversation.assets) {
      if (!chosen.has(asset.key)) { job.skipped.push({ chat: conversation.title, file: asset.name, reason: 'not selected' }); continue; }
      if (asset.error) { job.missing.push({ chat: conversation.title, file: asset.name, reason: asset.error }); continue; }
      const identity = attachmentRecord(threadId, asset);
      await stageBytes(asset.bytes, join(target.state, 'attachments', identity.fileName), asset.name, 'attachment');
      attachments.push({ messageIndex: asset.messageIndex, attachment: identity.attachment });
    }
    for (const [messageIndex] of conversation.messages.entries()) {
      const a = attachments.filter(a => a.messageIndex === messageIndex).map(a => a.attachment);
      if (a.length > 100 || a.filter(a => a.type === 'image').reduce((sum,a) => sum+a.sizeBytes,0) > 80*1024*1024) throw new Error('A message exceeds T3 attachment limits; reduce its selected attachments.');
    }
    if (selected.recoverWorkspace) {
      if (resolve(conversation.cwd) === root) throw new Error('The files are already in the selected folder.');
      if (inside(conversation.cwd, root) || inside(root, conversation.cwd)) throw new Error('Choose a destination that does not contain or sit inside the original workspace.');
      const inventory = await workspaceInventory(conversation.cwd);
      job.skipped.push(...inventory.skipped.map(s => ({ chat: conversation.title, file: s.path, reason: s.reason })));
      for (const file of inventory.files) {
        const destination = join(root, file.path);
        if (!inside(root, destination)) throw new Error('Workspace path escapes its destination.');
        const bytes = await readFile(file.source);
        const existing = await lstat(destination).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (existing) {
          if (existing.isFile() && !existing.isSymbolicLink() && hash(await readFile(destination)) === hash(bytes)) { job.skipped.push({ chat: conversation.title, file: file.path, reason: 'identical file already present' }); continue; }
          throw new Error(`Recovery would overwrite ${destination}. Choose an empty folder or keep files in place.`);
        }
        await stageBytes(bytes, destination, file.path, 'workspace', root, file.mode);
      }
    }
    job.batch.threads.push(makeThread(conversation, projectId, root, attachments, defaults));
    job.sources.push({ id: conversation.id, title: conversation.title, sourceHash: conversation.sourceHash,
      sourcePath: conversation.path, originalFolder: conversation.cwd, destinationFolder: root, messageCount: conversation.messages.length });
    await writeFile(join(directory, `conversation-${conversation.id}.json`), JSON.stringify({
      id: conversation.id, title: conversation.title, originalFolder: conversation.cwd, sourceHash: conversation.sourceHash,
      messages: conversation.messages.map(({ refs, response, ...m }) => m),
    }, null, 2), { mode: 0o600, flag: 'wx' });
  }
  if (job.missing.length && !acceptMissing) throw new Error('Some selected files are unavailable. Review and acknowledge them before preparing the import.');
  await atomicJson(join(directory, 'job.json'), job);
  await atomicJson(join(directory, 'status.json'), { phase: 'prepared', detail: 'Prepared. No changes have been made to T3.', updatedAt: new Date().toISOString() });
  return { path: join(directory, 'job.json'), directory, job };
}
