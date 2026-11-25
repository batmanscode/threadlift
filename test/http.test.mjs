import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startHttp, servePicker } from '../src/server.mjs';
import { fixture } from './fixtures.mjs';
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
  await writeFile(join(appPath, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>T3 Code</string><key>CFBundleShortVersionString</key><string>0.1.13</string></dict></plist>');
  const options = { codexHome: f.source, t3Home: f.target, appPath, reopen: false, openBrowser: false };
  const http = await servePicker(options); t.after(() => http.server.close());
  const [base, token] = http.url.split('#');
  const response = await fetch(base + 'api/state', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'picker');
  if (process.platform === 'darwin') await assert.rejects(servePicker({ ...options, reopen: true }), /Expected T3 Code 0\.1\.12/);
  await writeFile(join(f.target, 'userdata/server-runtime.json'), JSON.stringify({ serverVersion: '0.1.13' }));
  await assert.rejects(servePicker(options), /T3 0\.1\.13 is running/);
});
