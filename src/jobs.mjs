import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expand, inside } from './codex.mjs';
import { stageJob, defaultJobRoot } from './stage.mjs';
import { applyJob, atomicJson } from './target.mjs';
import { jobLock } from './recovery.mjs';

// Each child remains an ordinary, independently recoverable atomic import.
// The parent only schedules them and reopens T3 after all have verified.
export async function stageJobs(index, t3Home, selections, { jobRoot = defaultJobRoot(), acceptMissing = false } = {}) {
  if (!Array.isArray(selections) || !selections.length) throw new Error('Select at least one missing chat.');
  if (new Set(selections.map(s => s?.id)).size !== selections.length) throw new Error('A chat was selected twice.');
  const directory = join(expand(jobRoot), randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const jobs = [], sources = [], plannedProjects = [], plannedFiles = new Map(), warnings = new Set();
  let target;
  async function stage(batch) {
    let child;
    try {
      child = await stageJob(index, t3Home, batch, { jobRoot: join(directory, 'batches'), acceptMissing, plannedProjects, plannedFiles });
    } catch (error) {
      if (error.code !== 'THREADLIFT_BATCH_LIMIT' || batch.length === 1) throw error;
      const middle = Math.ceil(batch.length / 2);
      await stage(batch.slice(0, middle)); await stage(batch.slice(middle));
      return;
    }
    if (target && (target.home !== child.job.target.home || target.fingerprint !== child.job.target.fingerprint))
      throw new Error('The T3 format changed during preparation. Rescan before importing.');
    target ||= child.job.target;
    jobs.push(relative(directory, child.path)); sources.push(...child.job.sources);
    plannedProjects.push(...child.job.batch.projects);
    for (const file of child.job.files) plannedFiles.set(file.destination, file.sha256);
    for (const warning of child.job.compatibilityWarnings) warnings.add(warning);
  }
  try {
    for (let i = 0; i < selections.length; i += 20) await stage(selections.slice(i, i + 20));
    const job = { format: 'threadlift-queue-v1', id: randomUUID(), createdAt: new Date().toISOString(),
      target, jobs, sources, compatibilityWarnings: [...warnings] };
    await atomicJson(join(directory, 'job.json'), job);
    await atomicJson(join(directory, 'status.json'), { phase: 'prepared', detail: `Prepared ${sources.length} chats in ${jobs.length} batches. No changes have been made to T3.` });
    return { path: join(directory, 'job.json'), directory, job };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }); throw error;
  }
}

function combinedReceipt(receipts, omittedChats = []) {
  return { format: 'threadlift-receipt-v1', importedAt: new Date().toISOString(),
    threads: receipts.flatMap(r => r.threads), files: receipts.reduce((sum, r) => sum + r.files, 0),
    fileCounts: Object.fromEntries(['attachment', 'linked', 'workspace'].map(kind => [kind, receipts.reduce((sum, r) => sum + (r.fileCounts?.[kind] || 0), 0)])),
    linkedFiles: receipts.flatMap(r => r.linkedFiles || []), missing: receipts.flatMap(r => r.missing), skipped: receipts.flatMap(r => r.skipped),
    backupPaths: receipts.map(r => r.backupPath), omittedChats, sourceUnchanged: true,
    compatibilityWarnings: [...new Set(receipts.flatMap(r => r.compatibilityWarnings || []))],
    continuation: 'Original session IDs and working folders verified; this import does not send a live follow-up.' };
}

export async function applyJobs(jobPath, options = {}) {
  jobPath = await realpath(jobPath);
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  if (job.format === 'threadlift-job-v1') return applyJob(jobPath, options);
  if (job.format !== 'threadlift-queue-v1' || !Array.isArray(job.jobs) || !job.jobs.length) throw new Error('Unsupported recovery job.');
  const directory = dirname(jobPath), unlock = jobLock(directory), receipts = [];
  const status = async value => {
    const update = { ...value, updatedAt: new Date().toISOString() };
    await atomicJson(join(directory, 'status.json'), update); await options.onStatus?.(update);
  };
  try {
    const journal = await readFile(join(directory, 'journal.json'), 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (journal?.phase === 'verified') {
      const result = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
      await status({ phase: 'complete', detail: 'This job was already verified. Nothing was imported again.', result });
      return result;
    }
    for (const [index, child] of job.jobs.entries()) {
      const path = resolve(directory, child);
      if (!inside(join(directory, 'batches'), path) || !inside(join(directory, 'batches'), await realpath(path))) throw new Error('Invalid prepared batch path.');
      const result = await applyJob(path, { ...options, expectedTarget: job.target, appPath: job.reopen ? job.appPath : options.appPath,
        onStatus: update => status({ ...update, phase: ['complete', 'reopening'].includes(update.phase) ? 'verifying' : update.phase,
          detail: `Batch ${index + 1} of ${job.jobs.length}: ${update.detail}`, completedBatches: index, totalBatches: job.jobs.length }) });
      receipts.push(result);
    }
    const result = combinedReceipt(receipts, job.omittedChats);
    result.compatibilityWarnings = [...new Set([...(job.compatibilityWarnings || []), ...result.compatibilityWarnings])];
    await atomicJson(join(directory, 'receipt.json'), result);
    await atomicJson(join(directory, 'journal.json'), { phase: 'verified' });
    await status({ phase: job.reopen ? 'reopening' : 'complete', detail: 'All batches verified. Open T3 when ready.', result });
    return result;
  } catch (error) {
    await status({ phase: 'failed', detail: error.message, completedBatches: receipts.length, totalBatches: job.jobs.length,
      recovery: `${receipts.length} earlier ${receipts.length === 1 ? 'batch was' : 'batches were'} verified and kept. The current batch may need verification. Retry this same prepared job to continue; do not start a new import or restore a backup.`,
      result: combinedReceipt(receipts, job.omittedChats) });
    throw error;
  } finally { unlock(); }
}
