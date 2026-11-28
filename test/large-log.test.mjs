import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, writeFile, appendFile, open, stat, truncate, rm } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createZstdCompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { fixture } from './fixtures.mjs';
import { discoverCodex, readConversation } from '../src/codex.mjs';
import { stageJob } from '../src/stage.mjs';
import { applyJob, inspectTarget } from '../src/target.mjs';

async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

test('large plain and compressed tool logs preserve full fork history, uploads and generated files', async t => {
  const f = await fixture(t), original = (await readFile(f.path, 'utf8')).trim().split('\n').map(JSON.parse);
  original.at(-1).payload.content[0].text = `Earlier answer 🦆\n[Generated result](${join(f.scratch, 'result.txt')})`;
  const file = await open(f.path, 'w');
  try {
    await file.writeFile(original.slice(0, -1).map(JSON.stringify).join('\n') + '\n');
    // Incompressible tool outputs exceed the former limit on BOTH source and unpacked size.
    for (let i = 0; i < 180; i++) await file.writeFile(JSON.stringify({ type: 'response_item', payload: {
      type: 'function_call_output', output: randomBytes(768 * 1024).toString('base64'),
    } }) + '\n');
    await file.writeFile(JSON.stringify(original.at(-1)) + '\n');
  } finally { await file.close(); }
  const size = (await stat(f.path)).size;
  assert.ok(size > 128 * 1024 * 1024);
  let index = await discoverCodex(f.source), plain = await readConversation(index.chats[0], index);
  assert.equal(plain.messages.length, 2); assert.equal(plain.assets.length, 3);
  await appendFile(f.path, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', value: 1 } }) + '\n');
  assert.notEqual((await readConversation(index.chats[0], index)).sourceHash, plain.sourceHash);
  await truncate(f.path, size);
  const id = randomUUID(), childPath = join(dirname(f.path), `rollout-child-${id}.jsonl`);
  await writeFile(childPath, [
    { type: 'session_meta', payload: { id, cwd: f.scratch, history_base: { thread_id: f.id, end_byte_offset: size } } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Continue after the large inherited history' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'The final answer' } },
  ].map(JSON.stringify).join('\n') + '\n');
  index = await discoverCodex(f.source);
  const fork = await readConversation(index.chats.find(c => c.id === id), index);
  await pipeline(createReadStream(f.path), createZstdCompress(), createWriteStream(f.path + '.zst'));
  assert.ok((await stat(f.path + '.zst')).size > 128 * 1024 * 1024);
  await rm(f.path);
  index = await discoverCodex(f.source);
  assert.equal((await readConversation(index.chats.find(c => c.id === f.id), index)).sourceHash, plain.sourceHash);
  const compressed = await readConversation(index.chats.find(c => c.id === id), index);
  assert.equal(compressed.sourceHash, fork.sourceHash);
  assert.deepEqual(compressed.messages.map(m => m.text), [...plain.messages.map(m => m.text), 'Continue after the large inherited history', 'The final answer']);
  const before = await fileHash(f.path + '.zst');
  const staged = await stageJob(index, f.target, [{ id, root: f.workspace, sourceHash: fork.sourceHash }], { jobRoot: join(f.root, 'jobs') });
  await rm(f.scratch, { recursive: true });
  const receipt = await applyJob(staged.path);
  assert.equal(receipt.threads[0].messages, 4);
  assert.equal(receipt.fileCounts.attachment, 2); assert.equal(receipt.fileCounts.linked, 1);
  assert.equal(await readFile(receipt.linkedFiles[0].path, 'utf8'), 'A real workspace file.');
  assert.equal(await fileHash(f.path + '.zst'), before);
});

test('streaming validates ignored records and preserves UTF-8 across chunk boundaries', async t => {
  const f = await fixture(t), records = (await readFile(f.path, 'utf8')).trim().split('\n').map(JSON.parse);
  const text = '🦆'.repeat(20_000);
  records[1].payload.message = text; records[2].payload.content[0].text = text;
  const valid = records.map(JSON.stringify).join('\n'); // A final record without a newline is valid.
  await writeFile(f.path, valid);
  const index = await discoverCodex(f.source);
  assert.equal((await readConversation(index.chats[0], index)).messages[0].text, text);
  for (const [tail, pattern] of [
    [Buffer.from('\n{"type":"response_item","payload":{"type":"function_call_output",bad}}\n'), /Unreadable transcript record/],
    [Buffer.concat([Buffer.from('\n{"type":"response_item","payload":{"type":"function_call_output","output":"'), Buffer.from([0xff]), Buffer.from('"}}\n')]), /encoded data.*encoding/],
    [Buffer.from('\n{"type":"event_msg","payload":{"type":"thread_rolled_back"}}\n'), /unsupported rewind/],
  ]) {
    await writeFile(f.path, Buffer.concat([Buffer.from(valid), tail]));
    await assert.rejects(stageJob(index, f.target, [{ id: f.id }], { jobRoot: join(f.root, 'jobs') }), pattern);
    assert.equal((await inspectTarget(f.target)).owners[f.id], undefined);
  }
});
