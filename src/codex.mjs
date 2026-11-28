import { readFile, readdir, lstat, realpath, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { join, resolve, basename, extname, isAbsolute, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { markdownLinkDestinations, parseMarkdownFileLink } from '../vendor/t3.mjs';

export const LIMITS = Object.freeze({ transcriptBytes: 128 * 1024 * 1024, metadataBytes: 32 * 1024 * 1024,
  sourceFiles: 20_000, workspaceFiles: 10_000, stagedBytes: 1024 * 1024 * 1024, batchHistoryBytes: 256 * 1024 * 1024, forkDepth: 32 });
export const hash = value => createHash('sha256').update(value).digest('hex');
export const inside = (root, path) => { const r = relative(resolve(root), resolve(path)); return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
export const expand = value => resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
function sourceFilePath(value, cwd) {
  if (isAbsolute(value) || value === '~' || value.startsWith('~/')) return expand(value);
  return cwd && isAbsolute(cwd) ? resolve(cwd, value) : null;
}
const recordedCwd = value => typeof value === 'string' && isAbsolute(value) ? value : '';
export const iso = (value, fallback = new Date().toISOString()) => { const n = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : value; const date = new Date(n); return Number.isFinite(date.getTime()) ? date.toISOString() : fallback; };

async function bounded(path, limit) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular source file: ${path}`);
  if (stat.size > limit) throw new Error(`Source exceeds the ${Math.round(limit / 1024 / 1024)} MiB limit: ${path}`);
  return readFile(path);
}
async function jsonFile(path) { try { return JSON.parse(await bounded(path, LIMITS.metadataBytes)); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
async function walk(path, output = []) {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return output; throw e; }
  for (const entry of entries) {
    if (output.length >= LIMITS.sourceFiles) throw new Error('Too many Codex source files; choose a narrower Codex home.');
    if (entry.isSymbolicLink()) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full, output);
    else if (entry.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) output.push(full);
  }
  return output;
}
function uuidInPath(path) {
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i.exec(path)?.[1];
}

export async function discoverCodex(codexHome, { days = 30 } = {}) {
  if (!Number.isSafeInteger(days) || days < 0) throw new Error('Days must be a nonnegative whole number (0 includes all local chats).');
  codexHome = await realpath(expand(codexHome));
  const rows = new Map(), sqliteRoots = new Map();
  let db;
  try {
    const databasePath = join(codexHome, 'state_5.sqlite');
    if (await lstat(databasePath).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) db = new DatabaseSync(databasePath, { readOnly: true, timeout: 2000 });
    if (db) {
    for (const row of db.prepare('SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?').all(LIMITS.sourceFiles)) rows.set(row.id, row);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r => r.name);
    if (tables.includes('project_roots')) for (const row of db.prepare('SELECT threads.id, project_roots.path FROM threads JOIN project_roots ON threads.project_id=project_roots.project_id ORDER BY project_roots.position').all())
      if (typeof row.path === 'string' && !sqliteRoots.has(row.id)) sqliteRoots.set(row.id, row.path);
    }
  } catch (e) { throw new Error(`Cannot read the Codex index safely: ${e.message}`); }
  finally { db?.close(); }
  const cwds = new Map([...rows].map(([id, row]) => [id, recordedCwd(row.cwd)]));
  const global = await jsonFile(join(codexHome, '.codex-global-state.json'));
  const names = new Map();
  try { for (const line of String(await bounded(join(codexHome, 'session_index.jsonl'), LIMITS.metadataBytes)).split('\n')) {
    try { const n = JSON.parse(line); if (typeof n.id === 'string' && typeof n.thread_name === 'string' && n.thread_name.trim()) names.set(n.id, n.thread_name.trim()); } catch {}
  } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const allPaths = [...await walk(join(codexHome, 'sessions')), ...await walk(join(codexHome, 'archived_sessions'))];
  const paths = new Map(), versions = new Map(), unsupported = new Set();
  for (const path of allPaths) {
    const id = uuidInPath(path); if (!id) continue;
    const name = basename(path).replace(/\.zst$/, '');
    if (!versions.has(id)) versions.set(id, new Set());
    versions.get(id).add(name);
    if (versions.get(id).size > 1 || /_[0-9a-f-]{36}\.jsonl$/i.test(name)) unsupported.add(id);
    if (!paths.has(id) || !path.endsWith('.zst')) paths.set(id, path);
  }
  for (const row of rows.values()) if (typeof row.rollout_path === 'string') {
    let active;
    if (inside(codexHome, row.rollout_path)) for (const candidate of [row.rollout_path, row.rollout_path.endsWith('.zst') ? row.rollout_path.slice(0,-4) : row.rollout_path+'.zst']) {
      const stat = await lstat(candidate).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (stat?.isFile() && !stat.isSymbolicLink()) { active = candidate; break; }
    }
    if (active) paths.set(row.id, active);
    else unsupported.add(row.id); // Never replace a missing active branch with an older rollout.
  }
  const chats = [], unavailable = new Map();
  for (const [id, path] of paths) {
    const row = rows.get(id) || {};
    const title = names.get(id) || row.title || 'Unavailable Codex chat';
    const inaccessible = error => unavailable.set(id, { id, title, error: `Cannot read this transcript (${error.code || error.message}). Restore access and rescan.` });
    let stat;
    try { stat = await lstat(path); } catch (error) { inaccessible(error); continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) { inaccessible(new Error('not a regular file')); continue; }
    const updatedAt = row.updated_at ? iso(row.updated_at) : stat.mtime.toISOString();
    if (days > 0 && Date.parse(updatedAt) < Date.now() - days * 86400_000) continue;
    let meta = {};
    if (!path.endsWith('.zst')) {
      try {
      const file = await open(path, 'r');
      try { const buffer = Buffer.alloc(Math.min(stat.size, 65536)); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const first = buffer.subarray(0, bytesRead).toString().split('\n')[0];
        try { const r = JSON.parse(first); if (r.type === 'session_meta') meta = r.payload || {}; } catch {}
      } finally { await file.close(); }
      } catch (error) { inaccessible(error); continue; }
    }
    const assignment = global['thread-project-assignments']?.[id];
    const project = assignment?.projectKind === 'local' && typeof assignment.projectId === 'string' ? global['local-projects']?.[assignment.projectId] : undefined;
    const desktopRoot = Array.isArray(project?.rootPaths) ? project.rootPaths.find(p => typeof p === 'string' && isAbsolute(p) && p.trim()) : undefined;
    const cwd = row.cwd || meta.cwd || '';
    const root = sqliteRoots.get(id) || desktopRoot || cwd;
    chats.push({ id, path, title: names.get(id) || row.title || 'Untitled Codex chat', cwd, root,
      projectTitle: project?.name || basename(root) || 'No project', assignment: sqliteRoots.has(id) ? 'database' : desktopRoot ? 'Codex desktop' : 'original folder',
      model: row.model || null, createdAt: row.created_at ? iso(row.created_at) : meta.timestamp || updatedAt, updatedAt,
      archived: Boolean(row.archived), compressed: path.endsWith('.zst'), codexHome });
  }
  for (const id of [...unsupported].filter(id => !paths.has(id))) unavailable.set(id, { id,
    title: names.get(id) || rows.get(id)?.title || 'Unavailable Codex chat',
    error: 'The indexed active transcript is missing. No older branch was used instead.' });
  const unavailableChats = [...unavailable.values()];
  return { codexHome, chats: chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), paths, cwds, unsupported, unavailableChats };
}

async function recordsFor(chat, index, seen = new Set(), bytes = { total: 0 }, endByteOffset) {
  if (index.unsupported?.has(chat.id)) throw new Error('This chat has rewound or ambiguous rollout history. No partial history was imported.');
  if (seen.has(chat.id) || seen.size >= LIMITS.forkDepth) throw new Error('Cyclic or excessively deep Codex history.');
  seen.add(chat.id);
  if (!inside(chat.codexHome, await realpath(chat.path))) throw new Error('Transcript escapes the selected Codex home.');
  let data = await bounded(chat.path, LIMITS.transcriptBytes);
  if (chat.path.endsWith('.zst')) data = zstdDecompressSync(data, { maxOutputLength: LIMITS.transcriptBytes });
  if (endByteOffset !== undefined) {
    if (!Number.isSafeInteger(endByteOffset) || endByteOffset < 0 || endByteOffset > data.length) throw new Error('Invalid inherited history byte boundary.');
    data = data.subarray(0, endByteOffset);
    if (data.length && data.at(-1) !== 10) throw new Error('Inherited history ends inside a JSON record.');
  }
  bytes.total += data.length;
  if (bytes.total > LIMITS.transcriptBytes) throw new Error('Selected conversation exceeds the transcript safety limit; no messages were truncated.');
  const records = [];
  for (const [lineIndex, line] of new TextDecoder('utf-8', { fatal: true }).decode(data).split('\n').entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { throw new Error(`Unreadable transcript record ${lineIndex + 1}: ${chat.path}`); }
  }
  const meta = records.find(r => r.type === 'session_meta')?.payload || {};
  // A zero-byte inherited prefix has no parent records to validate.
  if (endByteOffset !== 0 && (meta.id || meta.session_id) !== chat.id) throw new Error('The chat index and transcript session ID disagree.');
  const base = meta.history_base;
  if (base?.thread_id === chat.id) throw new Error('Same-thread rewind history is not supported. No partial history was imported.');
  let parent = [];
  if (base !== undefined) {
    if (!base || typeof base.thread_id !== 'string' || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 0)
      throw new Error('Inherited history requires a valid byte boundary. No partial history was imported.');
    const parentPath = index.paths.get(base.thread_id);
    if (!parentPath) throw new Error(`Inherited Codex history is missing: ${base.thread_id}`);
    parent = await recordsFor({ id: base.thread_id, path: parentPath, codexHome: chat.codexHome }, index, seen, bytes, base.end_byte_offset);
  } else if (meta.forked_from_id && !records.some(r => r.type === 'response_item' && r.payload?.role === 'user')) {
    throw new Error('Fork history lacks an explicit history_base; refusing an incomplete import.');
  }
  // Keep each rollout's folder with its records when flattening inherited history.
  // An explicitly unknown turn folder must not fall back to another turn's folder.
  let cwd = recordedCwd(Object.hasOwn(meta, 'cwd') ? meta.cwd : index.cwds.get(chat.id));
  const own = records.map(record => {
    if (record.type === 'turn_context' && Object.hasOwn(record.payload || {}, 'cwd')) cwd = recordedCwd(record.payload.cwd);
    return { record, cwd };
  });
  return [...parent.filter(({ record }) => record.type !== 'session_meta'), ...own];
}
const textContent = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text || '').join('\n') : '';
const assetContent = payload => {
  const refs = [];
  for (const b of Array.isArray(payload.content) ? payload.content : []) {
    if (['input_image', 'image'].includes(b.type)) refs.push({ value: b.image_url?.url || b.image_url || b.url || b.path, name: b.name, kind: 'upload' });
    if (['input_file', 'file'].includes(b.type)) refs.push({ value: b.file_data || b.path || b.file_path || b.url, name: b.filename || b.name, kind: 'upload' });
  }
  for (const value of [...(payload.local_images || []), ...(payload.images || []), ...(payload.files || [])]) refs.push(typeof value === 'string' ? { value, kind: 'upload' } : { value: value.path || value.url, name: value.name || value.filename, kind: 'upload' });
  return refs.map(r => typeof r.value === 'string' ? r : { ...r, value: 'unavailable:' + (r.name || 'attachment') });
};

export function localFileLinks(text, cwd = '') {
  return markdownLinkDestinations(text).flatMap(link => {
    const target = parseMarkdownFileLink(link.href);
    if (!target) return [];
    const suffix = link.href.match(/[?#].*$/)?.[0] || (target.line ? `:${target.line}${target.column ? ':' + target.column : ''}${target.endLine ? '-' + target.endLine : ''}` : '');
    const sourcePath = sourceFilePath(target.path, cwd);
    return [{ ...link, value: target.path, sourcePath, suffix }];
  });
}

export function projectFileHref(root, path) {
  return './' + relative(root, path).split(sep).map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

export function rewriteFileLinks(text, cwd, recovered) {
  let rewritten = text;
  for (const link of localFileLinks(text, cwd).reverse()) {
    const href = recovered.get(link.sourcePath);
    if (href) rewritten = rewritten.slice(0, link.start) + href + link.suffix + rewritten.slice(link.end);
  }
  return rewritten;
}

export async function readConversation(chat, index) {
  const records = await recordsFor(chat, index);
  const meta = records.find(({ record }) => record.type === 'session_meta')?.record.payload || {};
  chat = { ...chat, cwd: chat.cwd || meta.cwd || '', root: chat.root || meta.cwd || '' };
  const messages = [], warnings = [];
  let model = chat.model;
  const add = (role, text, { record, cwd }, refs, response = false) => {
    if (!text.trim() && refs.length === 0) return;
    // Pair the two representations one-to-one within a same-role segment.
    // Repeated identical user turns remain distinct; old agent events keep order.
    const boundary = messages.findLast(m => m.role !== role)?.ordinal ?? -1;
    const duplicate = messages.findLast(m => m.ordinal > boundary && m.role === role && m.cwd === cwd && m.text.trim() === text.trim() && m.response !== response && !m.paired);
    if (duplicate) { duplicate.refs.push(...refs); duplicate.paired = true; return; }
    messages.push({ ordinal: messages.length, role, text, cwd, createdAt: iso(record.timestamp, chat.createdAt), refs, response });
  };
  for (const entry of records) {
    const { record } = entry;
    const p = record.payload || {};
    if (record.type === 'turn_context' && p.model) model = p.model;
    if (['thread_rolled_back', 'thread_rollback', 'rewind'].includes(p.type) || ['thread_rolled_back', 'thread_rollback', 'rewind'].includes(record.type))
      throw new Error('This transcript contains an unsupported rewind record; no partial history will be imported.');
    if (record.type === 'event_msg' && p.type === 'agent_message') add('assistant', p.message || '', entry, [], false);
    if (record.type === 'event_msg' && p.type === 'user_message') add('user', p.message || '', entry, assetContent(p));
    if (record.type === 'response_item' && p.type === 'message' && p.role === 'user' && /^\s*(?:# AGENTS\.md instructions for |<environment_context>|<permissions instructions>|<user_instructions>|<in-app-browser-context(?:\s|>))/.test(textContent(p.content))) continue;
    if (record.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) add(p.role, textContent(p.content), entry, assetContent(p), true);
  }
  if (!messages.length) throw new Error('No supported conversation messages found.');
  const assets = [];
  let assetBytes = 0;
  const addAsset = asset => {
    assetBytes += asset.sizeBytes || 0;
    if (assetBytes > LIMITS.stagedBytes || assets.length >= 10000) throw new Error('Conversation files exceed the preview safety limit; no data was imported.');
    assets.push(asset);
  };
  for (const [messageIndex, message] of messages.entries()) {
    const local = new Set();
    const source = { ...chat, cwd: message.cwd };
    for (const ref of message.refs) {
      const key = hash(ref.value); if (local.has(key)) continue; local.add(key);
      addAsset({ ...await inspectAsset(ref, source, messageIndex, key), role: message.role });
    }
    // File links are offered as explicit recoverable references, never scraped as arbitrary paths.
    for (const { value, sourcePath } of localFileLinks(message.text, message.cwd)) {
      const key = hash(sourcePath || value);
      if (local.has(key)) continue;
      local.add(key); addAsset({ ...await inspectAsset({ value, kind: 'reference' }, source, messageIndex, key), role: message.role });
    }
  }
  for (const asset of assets) if (asset.error) warnings.push(`${asset.name}: ${asset.error}`);
  const origin = { id: chat.id, path: chat.path.replace(/\.zst$/, ''), cwd: chat.cwd, root: chat.root, title: chat.title, model, archived: chat.archived };
  return { ...chat, model, messages, assets, warnings, sourceHash: hash(JSON.stringify([origin, records, assets.map(a => [a.key, a.sha256 || a.error])])), recordCount: records.length };
}

export async function inspectAsset(ref, chat, messageIndex, key) {
  const result = { key: hash(messageIndex + ':' + key), messageIndex, kind: ref.kind, name: ref.name || 'Attachment', value: ref.value };
  try {
    let bytes, mime;
    if (ref.value.startsWith('unavailable:')) throw new Error('No recoverable local bytes are recorded for this attachment.');
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(ref.value);
    if (data) { mime = data[1]; if (data[2].length > 70_000_000) throw new Error('Attachment exceeds the file safety limit.'); bytes = Buffer.from(data[2], 'base64'); }
    else {
      if (/^[a-z]+:\/\//i.test(ref.value) && !ref.value.startsWith('file://')) throw new Error('Remote attachment is not downloaded.');
      const path = sourceFilePath(ref.value.startsWith('file://') ? fileURLToPath(ref.value) : ref.value, chat.cwd);
      if (!path) throw new Error('The original folder for this relative attachment is unknown.');
      result.path = path; result.name = ref.name || basename(path);
      if ((await lstat(path)).isSymbolicLink() || (await realpath(path)) !== resolve(path)) throw new Error('Symlink requires manual recovery.');
      bytes = await bounded(path, 50 * 1024 * 1024);
    }
    const ext = extname(result.name).toLowerCase();
    mime ||= ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain', '.json': 'application/json', '.md': 'text/markdown' })[ext] || 'application/octet-stream';
    const type = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime) ? 'image' : 'file';
    if (!bytes.length || bytes.length > (type === 'image' ? 10 : 50) * 1024 * 1024) throw new Error(`Outside T3's ${type === 'image' ? '10' : '50'} MiB ${type} limit.`);
    if (data && result.name === 'Attachment') result.name = `attachment-${messageIndex}${({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[mime] || '.bin'}`;
    return { ...result, type, mimeType: mime, sizeBytes: bytes.length, sha256: hash(bytes), bytes };
  } catch (e) { return { ...result, error: e.code === 'ENOENT' ? 'Source file is missing.' : e.message }; }
}

export async function workspaceInventory(root) {
  if (!root || (await realpath(root)) !== resolve(root) || !(await lstat(root)).isDirectory()) throw new Error('Original workspace is missing or is a symlink; locate its real folder first.');
  const files = [], skipped = []; let totalBytes = 0;
  const ignored = new Set(['.git', 'node_modules', '.DS_Store', '.venv', '__pycache__']);
  async function visit(path, depth = 0) {
    if (depth > 32) throw new Error('Workspace nesting exceeds the recovery limit.');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name), rel = relative(root, full);
      if (ignored.has(entry.name)) { skipped.push({ path: rel, reason: 'development metadata/cache' }); continue; }
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); continue; }
      if (stat.isDirectory()) await visit(full, depth + 1);
      else if (stat.isFile()) {
        if (files.length >= LIMITS.workspaceFiles || (totalBytes += stat.size) > LIMITS.stagedBytes) throw new Error('Workspace recovery exceeds the file/size safety limit.');
        files.push({ path: rel, source: full, sizeBytes: stat.size, mode: stat.mode & 0o777 });
      } else skipped.push({ path: rel, reason: 'not a regular file' });
    }
  }
  await visit(root); return { files, skipped, totalBytes };
}
