import { DatabaseSync } from 'node:sqlite';
import { lstat, realpath, mkdir, open, link, unlink, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, inside } from './codex.mjs';

// SQLite releases this lock on process exit, including a crash. No stale PID file.
export function jobLock(directory) {
  const db = new DatabaseSync(join(directory, 'apply-owner.sqlite'), { timeout: 0 });
  try { db.exec('BEGIN EXCLUSIVE'); }
  catch (e) { db.close(); throw new Error('This import job is already running. Use its existing progress page.'); }
  return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
}
async function statOrNull(path) {
  return lstat(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
}
async function ensureParent(base, destination) {
  if (!inside(base, destination) || resolve(base) === resolve(destination)) throw new Error('Invalid file destination.');
  if ((await realpath(base)) !== resolve(base) || !(await lstat(base)).isDirectory()) throw new Error('The destination folder moved or became a symlink. Review it again.');
  let current = resolve(base);
  for (const part of relative(base, dirname(destination)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('A destination parent is not a regular directory.');
  }
}
async function sameOwned(path, entry) {
  const stat = await statOrNull(path);
  return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.dev === entry.dev && stat.ino === entry.ino && hash(await readFile(path)) === entry.sha256);
}
async function syncDirectory(path) {
  const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); }
}
export async function installFile(file, index, job, journal, save) {
  const base = file.kind === 'attachment' ? job.target.state : file.root;
  await ensureParent(base, file.destination);
  let entry = journal.files.find(e => e.index === index);
  if (entry && entry.destination !== file.destination) throw new Error('Recovery journal disagrees with its file manifest.');
  if (await statOrNull(file.destination)) {
    if (!entry || !await sameOwned(file.destination, entry)) throw new Error(`Destination already exists or changed: ${file.destination}`);
    return;
  }
  let temporary = entry?.temporary;
  const prefix = `.threadlift-${job.id}-${index}-`;
  if (temporary && (dirname(temporary) !== dirname(file.destination) || !basename(temporary).startsWith(prefix))) throw new Error('Invalid recovery temporary path.');
  if (!entry || !await sameOwned(temporary, entry)) {
    // An orphan temporary without a durable ownership record is left untouched.
    temporary = join(dirname(file.destination), prefix + randomUUID() + '.tmp');
    const fd = await open(temporary, 'wx', 0o600);
    try {
      await fd.writeFile(await readFile(file.staged));
      if (file.kind === 'workspace' && Number.isInteger(file.mode)) await fd.chmod(file.mode & 0o777);
      await fd.sync();
      const stat = await fd.stat();
      entry = { index, destination: file.destination, temporary, sha256: file.sha256, dev: stat.dev, ino: stat.ino };
      journal.files = journal.files.filter(e => e.index !== index); journal.files.push(entry);
      await save(); // Write-ahead ownership record BEFORE exposing a destination.
    } finally { await fd.close(); }
  }
  await link(temporary, file.destination); // Atomic and never overwrites an existing name.
  await syncDirectory(dirname(file.destination));
}
export async function cleanOwnedFiles(journal, { destinations = true } = {}) {
  const retained = [];
  for (const entry of journal.files || []) {
    for (const path of [entry.temporary, ...(destinations ? [entry.destination] : [])]) {
      try {
        if (await sameOwned(path, entry)) await unlink(path);
        else if (await statOrNull(path)) retained.push(path);
      } catch { retained.push(path); }
    }
  }
  return retained;
}
