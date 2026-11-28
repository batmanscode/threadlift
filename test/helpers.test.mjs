import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { helperFixture } from './helper-fixture.mjs';
import { discoverCodex, readConversation, hash } from '../src/codex.mjs';
import { stageJobs, applyJobs } from '../src/jobs.mjs';
import { stageJob } from '../src/stage.mjs';
import { servePicker } from '../src/server.mjs';

test('bulk recovery excludes explicit helpers while preserving desktop titles, unnamed chats and regular forks', async t => {
  const f = await helperFixture(t), index = await discoverCodex(f.source);
  assert.equal(index.chats.filter(c => c.isHelper).length, 3);
  for (const h of f.helpers) {
    assert.ok(index.paths.has(h.id));
    await assert.rejects(stageJob(index, f.target, [{ id: h.id }], { jobRoot: join(f.root, 'rejected') }), /internal Codex helper session/);
  }
  const picker = await servePicker({ codexHome: f.source, t3Home: f.target, openBrowser: false, reopen: false });
  t.after(() => picker.server.close());
  const [base, token] = picker.url.split('#');
  const state = await fetch(base + 'api/state', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
  assert.equal(state.chats.length, 3); assert.equal(state.helperSessionsExcluded, 3);
  assert.equal(state.chats.find(c => c.id === f.id).title, 'My current Codex title');
  const parent = await readConversation(index.chats.find(c => c.id === f.id), index);
  const regular = await readConversation(index.chats.find(c => c.id === f.regularId), index);
  const fork = await readConversation(index.chats.find(c => c.id === f.forkId), index);
  assert.equal(parent.title, 'My current Codex title');
  assert.equal(regular.title, 'Build a subagent dashboard'); assert.equal(regular.isHelper, false);
  assert.equal(regular.messages[0].text, f.regularPrompt);
  assert.equal(fork.title, 'Follow up on these findings'); assert.equal(fork.isHelper, false);
  assert.equal(fork.messages.length, 3); assert.ok(fork.assets.some(a => a.name === 'result.txt'));
  const paths = [f.path, f.regularPath, f.forkPath, ...f.helpers.map(h => h.path), f.globalPath];
  const before = await Promise.all(paths.map(async p => hash(await readFile(p))));
  const staged = await stageJobs(index, f.target, state.chats.map(c => ({ id: c.id })), { jobRoot: join(f.root, 'jobs') });
  const receipt = await applyJobs(staged.path);
  assert.equal(receipt.threads.length, 3);
  const db = new DatabaseSync(join(f.target, 'userdata/statev2.sqlite'), { readOnly: true });
  try {
    const threads = db.prepare('SELECT payload_json FROM orchestration_v2_projection_threads').all().map(r => JSON.parse(r.payload_json));
    assert.deepEqual(threads.map(t => t.title).sort(), ['My current Codex title', 'Build a subagent dashboard', 'Follow up on these findings'].sort());
    assert.ok(threads.every(t => !f.helpers.some(h => t.id.includes(h.id))));
  } finally { db.close(); }
  assert.deepEqual(await Promise.all(paths.map(async p => hash(await readFile(p)))), before);
});
