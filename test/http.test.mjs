import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startHttp, servePicker } from '../src/server.mjs';
import { fixture, fixtureVersion } from './fixtures.mjs';
import { readAppVersion, inspectTarget, versionWarnings } from '../src/target.mjs';
import { DatabaseSync } from 'node:sqlite';
import { stageJob } from '../src/stage.mjs';
import { discoverCodex } from '../src/codex.mjs';
import { applyJob } from '../src/target.mjs';
test('local API rejects unauthenticated and cross-origin requests and serves a restrictive CSP',async t=>{
  const token='a'.repeat(64),http=await startHttp(token,async()=>({ok:true}));t.after(()=>http.server.close());
  const base=http.url.split('#')[0];
  assert.equal((await fetch(base+'api/state')).status,401);
  assert.equal((await fetch(base+'api/state',{headers:{Authorization:'Bearer '+token,Origin:'https://example.com'}})).status,403);
  const good=await fetch(base+'api/state',{headers:{Authorization:'Bearer '+token,Origin:base.slice(0,-1)}});
  assert.deepEqual(await good.json(),{ok:true});
  assert.match(good.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
});

test('no-reopen ignores an unused app but still refuses an incompatible target', async t => {
  const f = await fixture(t), appPath = join(f.root, 'T3 Code.app');
  await mkdir(join(appPath, 'Contents'), { recursive: true });
  const setAppVersion = version => writeFile(join(appPath, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>T3 Code</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  await setAppVersion('0.1.11');
  const options = { codexHome: f.source, t3Home: f.target, appPath, reopen: false, openBrowser: false };
  const http = await servePicker(options); t.after(() => http.server.close());
  const [base, token] = http.url.split('#');
  const response = await fetch(base + 'api/state', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'picker');
  assert.equal((await inspectTarget(f.target)).version, fixtureVersion);
  assert.throws(() => versionWarnings(fixtureVersion + '-rc.1', fixtureVersion), /older than or incompatible/);
  if (process.platform === 'darwin') {
    await assert.rejects(servePicker({ ...options, reopen: true }), /older than or incompatible/);
    await setAppVersion(fixtureVersion);
    assert.equal(readAppVersion(appPath, fixtureVersion), fixtureVersion);
    await setAppVersion('0.1.14');
    assert.equal(readAppVersion(appPath, fixtureVersion), '0.1.14');
    assert.match(versionWarnings('0.1.14', fixtureVersion)[0], /has not been tested/);
  }
  await writeFile(join(f.target, 'userdata/server-runtime.json'), JSON.stringify({ serverVersion: '0.1.14' }));
  const future = await servePicker(options); t.after(() => future.server.close());
  const [futureBase, futureToken] = future.url.split('#');
  const futureState = await fetch(futureBase + 'api/state', { headers: { Authorization: 'Bearer ' + futureToken } }).then(r => r.json());
  assert.equal(futureState.version, '0.1.14');
  assert.match(futureState.warnings[0], /has not been tested/);
  const staged = await stageJob(await discoverCodex(f.source), f.target, [{ id: f.id }], { jobRoot: join(f.root, 'jobs') });
  const receipt = await applyJob(staged.path);
  assert.equal(receipt.threads[0].messages, 2);
  assert.match(receipt.compatibilityWarnings[0], /has not been tested/);
  await writeFile(join(f.target, 'userdata/server-runtime.json'), JSON.stringify({ serverVersion: '0.1.11' }));
  await assert.rejects(servePicker(options), /older than or incompatible/);
  await rm(join(f.target, 'userdata/server-runtime.json'));
  assert.equal((await inspectTarget(f.target)).version, null);
  const offline = await servePicker(options); t.after(() => offline.server.close());
  const [offlineBase, offlineToken] = offline.url.split('#');
  const offlineState = await fetch(offlineBase + 'api/state', { headers: { Authorization: 'Bearer ' + offlineToken } }).then(r => r.json());
  assert.equal(offlineState.version, null);
  assert.equal(offlineState.formatVersion, fixtureVersion);
  assert.match(offlineState.warnings[0], /installed version is unknown/);
  const db = new DatabaseSync(join(f.target, 'userdata/statev2.sqlite'));
  try { db.exec("INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES (999, 'UnknownFutureFormat', '2026-11-28T00:00:00Z')"); }
  finally { db.close(); }
  await assert.rejects(servePicker(options), /does not match the tested/);
});
