import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverCodex, readConversation, hash, expand } from './codex.mjs';
import { inspectTarget, atomicJson, readAppVersion, versionWarnings } from './target.mjs';
import { jobLock } from './recovery.mjs';
import { stageJobs, applyJobs } from './jobs.mjs';

const web = new URL('../web/', import.meta.url), cli = fileURLToPath(new URL('../bin/threadlift.mjs', import.meta.url));
const randomToken = () => randomBytes(32).toString('hex');
function authorized(header, token) {
  const supplied = Buffer.from(header || ''), expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const b of req) { if ((size += b.length) > 1024 * 1024) throw new Error('Request is too large.'); chunks.push(b); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function startHttp(token, route, port = 0) {
  return new Promise((done, reject) => {
    const server = createServer(async (req, res) => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
      const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      try {
        if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(403, { error: 'Invalid local host.' });
        const path = new URL(req.url, origin).pathname;
        if (path.startsWith('/api/')) {
          if (!authorized(req.headers.authorization, token)) return send(401, { error: 'Open the private link printed by Threadlift.' });
          if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Cross-origin requests are not allowed.' });
          return send(200, await route(path, req.method, req.method === 'POST' ? await body(req) : null));
        }
        const files = { '/': ['index.html', 'text/html'], '/app.mjs': ['app.mjs', 'text/javascript'], '/app.css': ['app.css', 'text/css'] };
        if (!files[path] || req.method !== 'GET') return send(404, { error: 'Not found.' });
        res.writeHead(200, { 'Content-Type': files[path][1] }); res.end(await readFile(new URL(files[path][0], web)));
      } catch (e) { if (!res.headersSent) send(400, { error: e.message }); else res.end(); }
    });
    server.on('error', reject); server.listen(port, '127.0.0.1', () => done({ server, url: `http://127.0.0.1:${server.address().port}/#${token}` }));
  });
}
export async function findApp(explicit) {
  const candidates = explicit ? [expand(explicit)] : ['/Applications/T3 Code (Beta).app', '/Applications/T3 Code.app', join(homedir(), 'Applications/T3 Code (Beta).app')];
  for (const path of candidates) if ((await lstat(path).catch(() => null))?.isDirectory()) { readAppVersion(path); return path; }
  return null;
}
export async function servePicker({ codexHome = join(homedir(), '.codex'), t3Home = join(homedir(), '.t3'), days = 30,
  appPath, jobRoot, port = 0, openBrowser = true, directWorker = false, reopen = true } = {}) {
  let index = await discoverCodex(codexHome, { days }), target = await inspectTarget(t3Home), scanId = randomUUID(), scanDays = days;
  const app = reopen ? await findApp(appPath) : null;
  if (reopen && !app) throw new Error(`T3 Code was not found. Install and set up T3 ${target.version} first, or provide --app /path/to/T3.app.`);
  const appVersion = app ? readAppVersion(app, target.formatVersion) : null;
  const warnings = [...new Set([...target.warnings, ...(appVersion ? versionWarnings(appVersion, target.formatVersion) : [])])];
  if (!appVersion && !target.version) warnings.push(`T3’s installed version is unknown. This profile matches the tested ${target.formatVersion} database format.`);
  if (reopen && target.home !== await realpath(join(homedir(), '.t3')).catch(() => null)) throw new Error('Automatic reopening supports the default ~/.t3 profile. For isolated profiles use --no-reopen and open the intended profile yourself.');
  const cache = new Map(), previewFailures = new Map(), token = randomToken(); let preparing = false;
  const pickerState = () => ({ mode: 'picker', version: appVersion || target.version, formatVersion: target.formatVersion, warnings, scanId, scanDays,
      pathContext: { home: homedir(), cwd: process.cwd() }, unavailableChats: index.unavailableChats.filter(c => !target.owners[c.id]),
      chats: index.chats.map(c => ({ id: c.id, title: c.title, root: c.root, cwd: c.cwd, updatedAt: c.updatedAt,
        assignment: c.assignment, archived: c.archived, existing: target.owners[c.id] || null })), projects: target.projects });
  const service = await startHttp(token, async (path, method, data) => {
    if (path === '/api/state' && method === 'GET') return pickerState();
    if (path === '/api/scan' && method === 'POST') {
      if (preparing) throw new Error('An import is already being prepared.');
      index = await discoverCodex(index.codexHome, { days: 0 }); target = await inspectTarget(target.home);
      cache.clear(); previewFailures.clear();
      scanDays = 0; scanId = randomUUID(); return pickerState();
    }
    if (path === '/api/preview' && method === 'POST') {
      try {
      const current = data.scanId === scanId ? index : await discoverCodex(index.codexHome, { days: 0 });
      const meta = current.chats.find(c => c.id === data.id); if (!meta) throw new Error('Chat not found. Rescan first.');
      const c = await readConversation(meta, current); cache.set(c.id, c.sourceHash);
      previewFailures.delete(c.id);
      const folder = c.root || c.cwd;
      const folderError = !folder ? 'Choose the current project folder.' : !(await lstat(folder).catch(() => null))?.isDirectory() ? 'The recorded folder is missing. Choose its current location.' : null;
      return { id: c.id, title: c.title, sourceHash: c.sourceHash, cwd: c.cwd, root: c.root, messages: c.messages.length,
        folderError,
        first: c.messages[0]?.text.slice(0,500), last: c.messages.at(-1)?.text.slice(0,500), warnings: c.warnings,
        assets: c.assets.map(({ bytes, value, ...asset }) => asset) };
      } catch (error) {
        previewFailures.set(data.id, { id: data.id, title: index.chats.find(c => c.id === data.id)?.title || 'Unavailable Codex chat', error: error.message });
        throw error;
      }
    }
    if (path === '/api/prepare' && method === 'POST') {
      if (preparing) throw new Error('An import is already being prepared.');
      if (!Array.isArray(data.selections) || data.selections.some(s => !s || !cache.has(s.id) || cache.get(s.id) !== s.sourceHash)) throw new Error('Preview each selected chat again before preparing.');
      const omittedIds = data.omittedChats || [], failures = new Map([...previewFailures, ...index.unavailableChats.map(c => [c.id, c])]);
      if (!Array.isArray(omittedIds) || omittedIds.some(id => typeof id !== 'string' || !failures.has(id) || data.selections.some(s => s.id === id))) throw new Error('Invalid omitted-chat list. Rescan before importing.');
      if (omittedIds.length && data.acceptOmitted !== true) throw new Error('Review and acknowledge the chats that could not be selected.');
      preparing = true;
      try {
        const staged = await stageJobs(index, target.home, data.selections, { jobRoot, acceptMissing: data.acceptMissing === true });
        staged.job.browserToken = randomToken(); staged.job.appPath = app; staged.job.reopen = reopen;
        staged.job.compatibilityWarnings = [...new Set([...staged.job.compatibilityWarnings, ...warnings])];
        staged.job.omittedChats = [...new Set(omittedIds)].map(id => failures.get(id));
        await atomicJson(staged.path, staged.job);
        const worker = directWorker ? await runWorker(staged.path, { cleanupMs: 120_000 }) : await launchWorker(staged.path);
        setTimeout(() => service.server.close(), 250);
        return { url: worker.url };
      } catch (e) { preparing = false; throw e; }
    }
    throw new Error('Unknown action.');
  }, port);
  if (openBrowser) execFile('/usr/bin/open', [service.url], () => {});
  return service;
}
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
function stopWorker(label) {
  execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'pipe' });
}
export async function launchWorker(jobPath) {
  if (process.platform !== 'darwin') throw new Error('The independent worker currently supports macOS only.');
  jobPath = await realpath(jobPath);
  const dir = dirname(jobPath), job = JSON.parse(await readFile(jobPath, 'utf8'));
  const launchId = randomUUID(), label = `dev.threadlift.${job.id}.${launchId.slice(0,8)}`;
  const plist = join(dir, `worker-${launchId}.plist`);
  const args = [process.execPath, cli, 'worker', '--job', jobPath, '--label', label, '--launch-id', launchId];
  // submit implicitly restarts failures. An explicit KeepAlive=false job is one-shot.
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>${xml(join(dir,'worker.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(dir,'worker-error.log'))}</string>
</dict></plist>`, { mode: 0o600, flag: 'wx' });
  let registered = false;
  try {
    execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { stdio: 'pipe' });
    registered = true;
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const failure = await readFile(join(dir,`startup-${launchId}.json`),'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (failure) throw new Error(failure.message);
      const ready = await readFile(join(dir,'worker.json'),'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (ready?.launchId === launchId) return { url: ready.url + '#' + job.browserToken, label };
      await new Promise(r => setTimeout(r,100));
    }
    throw new Error('The background helper did not acknowledge startup.');
  } catch (error) {
    let stopped = !registered;
    if (registered) { try { stopWorker(label); stopped = true; } catch {} }
    throw new Error(`${error.message} ${stopped ? 'This worker was stopped or did not start.' : 'Worker shutdown could not be confirmed.'} Check this job before retrying: ${dir}`);
  }
}
export async function runWorker(jobPath, { label, launchId, cleanupMs = 10*60_000, waitMs } = {}) {
  jobPath = await realpath(jobPath); const dir = dirname(jobPath), job = JSON.parse(await readFile(jobPath,'utf8'));
  if (!['threadlift-job-v1', 'threadlift-queue-v1'].includes(job.format) || !/^[a-f0-9]{64}$/.test(job.browserToken || '')) throw new Error('Invalid prepared job.');
  const gateDirectory = join(homedir(), 'Library/Application Support/Threadlift/worker-locks', hash(job.target.home));
  let service, releaseGate;
  try {
    await mkdir(gateDirectory, { recursive: true, mode: 0o700 });
    releaseGate = jobLock(gateDirectory);
    service = await startHttp(job.browserToken, async (path, method) => {
      if (path === '/api/state' && method === 'GET') return { mode: 'progress', sources: job.sources,
        status: JSON.parse(await readFile(join(dir,'status.json'),'utf8')), warnings: job.compatibilityWarnings || [], batchCount: job.jobs?.length || 1, directory: dir, autoReopen: job.reopen === true };
      throw new Error('This import is already prepared.');
    });
    await atomicJson(join(dir,'worker.json'), { pid: process.pid, url: service.url.split('#')[0], launchId });
  } catch (error) {
    service?.server.close(); releaseGate?.();
    if (launchId) await atomicJson(join(dir,`startup-${launchId}.json`), { message: error.message });
    throw error;
  }
  const completion = (async () => {
    try {
      await applyJobs(jobPath, { waitMs });
      const status = JSON.parse(await readFile(join(dir,'status.json'),'utf8'));
      if (job.reopen && job.appPath) {
        try { readAppVersion(job.appPath, job.target.formatVersion || job.target.version); execFileSync('/usr/bin/open',['-a',job.appPath]); status.detail = 'Import verified. T3 was asked to reopen. You can close this tab and open your imported chat.'; }
        catch (e) { status.detail = 'Import verified. T3 could not reopen automatically; open it normally.'; status.reopenError = e.message; }
      }
      status.phase = 'complete';
      await atomicJson(join(dir,'status.json'),status);
    } catch (e) {
      const current = await readFile(join(dir,'status.json'),'utf8').then(JSON.parse).catch(() => ({}));
      if (current.phase !== 'failed') await atomicJson(join(dir,'status.json'), { phase: 'failed', detail: e.message });
    } finally {
      releaseGate();
      const timer = setTimeout(() => { service.server.close();
        if (label?.startsWith('dev.threadlift.')) { try { stopWorker(label); } catch {} }
      },cleanupMs); timer.unref();
    }
  })();
  return { ...service, completion };
}
