import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverCodex, readConversation, hash, expand } from './codex.mjs';
import { inspectTarget, applyJob, atomicJson, readAppVersion } from './target.mjs';
import { jobLock } from './recovery.mjs';
import { stageJob } from './stage.mjs';

const web = new URL('../web/', import.meta.url), cli = fileURLToPath(new URL('../bin/threadlift.mjs', import.meta.url));
const randomToken = () => randomBytes(32).toString('hex');
function authorized(header, token) {
  const supplied = Buffer.from(header || ''), expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const b of req) { if ((size += b.length) > 65536) throw new Error('Request is too large.'); chunks.push(b); }
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
  const index = await discoverCodex(codexHome, { days }), target = await inspectTarget(t3Home), app = await findApp(appPath);
  if (reopen && !app) throw new Error('T3 Code was not found. Install and set up T3 0.1.12 first, or provide --app /path/to/T3.app.');
  if (reopen && target.home !== await realpath(join(homedir(), '.t3')).catch(() => null)) throw new Error('Automatic reopening supports the default ~/.t3 profile. For isolated profiles use --no-reopen and open the intended profile yourself.');
  const cache = new Map(), token = randomToken(); let preparing = false;
  const service = await startHttp(token, async (path, method, data) => {
    if (path === '/api/state' && method === 'GET') return { mode: 'picker', version: target.version,
      chats: index.chats.map(c => ({ id: c.id, title: c.title, root: c.root, cwd: c.cwd, updatedAt: c.updatedAt,
        assignment: c.assignment, archived: c.archived, existing: target.owners[c.id] || null })), projects: target.projects };
    if (path === '/api/preview' && method === 'POST') {
      const meta = index.chats.find(c => c.id === data.id); if (!meta) throw new Error('Chat not found.');
      const c = await readConversation(meta, index); cache.set(c.id, c.sourceHash);
      return { id: c.id, title: c.title, sourceHash: c.sourceHash, cwd: c.cwd, root: c.root, messages: c.messages.length,
        first: c.messages[0]?.text.slice(0,500), last: c.messages.at(-1)?.text.slice(0,500), warnings: c.warnings,
        assets: c.assets.map(({ bytes, value, ...asset }) => asset) };
    }
    if (path === '/api/prepare' && method === 'POST') {
      if (preparing) throw new Error('An import is already being prepared.');
      if (!Array.isArray(data.selections) || data.selections.some(s => !cache.has(s.id))) throw new Error('Preview each selected chat first.');
      preparing = true;
      try {
        const staged = await stageJob(index, target.home, data.selections, { jobRoot, acceptMissing: data.acceptMissing === true });
        staged.job.browserToken = randomToken(); staged.job.appPath = app; staged.job.reopen = reopen;
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
export async function launchWorker(jobPath) {
  if (process.platform !== 'darwin') throw new Error('The independent worker currently supports macOS only.');
  const dir = dirname(jobPath), job = JSON.parse(await readFile(jobPath, 'utf8'));
  const label = `dev.threadlift.${job.id}`;
  execFileSync('/bin/launchctl', ['submit', '-l', label, '-o', join(dir,'worker.log'), '-e', join(dir,'worker-error.log'), '--',
    process.execPath, cli, 'worker', '--job', jobPath, '--label', label], { stdio: 'pipe' });
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try { const ready = JSON.parse(await readFile(join(dir,'worker.json'),'utf8')); return { url: ready.url + '#' + job.browserToken, label }; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await new Promise(r => setTimeout(r,100));
  }
  throw new Error(`Background helper did not start. T3 is unchanged. Details: ${join(dir,'worker-error.log')}`);
}
export async function runWorker(jobPath, { label, cleanupMs = 10*60_000, waitMs } = {}) {
  jobPath = await realpath(jobPath); const dir = dirname(jobPath), job = JSON.parse(await readFile(jobPath,'utf8'));
  if (job.format !== 'threadlift-job-v1' || !/^[a-f0-9]{64}$/.test(job.browserToken || '')) throw new Error('Invalid prepared job.');
  const gateDirectory = join(homedir(), 'Library/Application Support/Threadlift/worker-locks', hash(job.target.home));
  await mkdir(gateDirectory, { recursive: true, mode: 0o700 });
  const releaseGate = jobLock(gateDirectory);
  let service;
  try { service = await startHttp(job.browserToken, async (path, method) => {
    if (path === '/api/state' && method === 'GET') return { mode: 'progress', sources: job.sources,
      status: JSON.parse(await readFile(join(dir,'status.json'),'utf8')), directory: dir, autoReopen: job.reopen === true };
    throw new Error('This import is already prepared.');
  });
  } catch (e) { releaseGate(); throw e; }
  await atomicJson(join(dir,'worker.json'), { pid: process.pid, url: service.url.split('#')[0] });
  const completion = (async () => {
    try {
      if (job.reopen && job.appPath) readAppVersion(job.appPath);
      await applyJob(jobPath, { waitMs });
      const status = JSON.parse(await readFile(join(dir,'status.json'),'utf8'));
      if (job.reopen && job.appPath) {
        try { readAppVersion(job.appPath); execFileSync('/usr/bin/open',['-a',job.appPath]); status.detail = 'Import verified. T3 was asked to reopen. You can close this tab and open your imported chat.'; }
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
        if (label?.startsWith('dev.threadlift.')) { try { execFileSync('/bin/launchctl',['remove',label]); } catch {} }
      },cleanupMs); timer.unref();
    }
  })();
  return { ...service, completion };
}
