import test from 'node:test';
import assert from 'node:assert/strict';
import { startHttp } from '../src/server.mjs';
test('local API rejects unauthenticated and cross-origin requests and serves a restrictive CSP',async t=>{
  const token='a'.repeat(64),http=await startHttp(token,async()=>({ok:true}));t.after(()=>http.server.close());
  const base=http.url.split('#')[0];
  assert.equal((await fetch(base+'api/state')).status,401);
  assert.equal((await fetch(base+'api/state',{headers:{Authorization:'Bearer '+token,Origin:'https://example.com'}})).status,403);
  const good=await fetch(base+'api/state',{headers:{Authorization:'Bearer '+token,Origin:base.slice(0,-1)}});
  assert.deepEqual(await good.json(),{ok:true});
  assert.match(good.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
});
