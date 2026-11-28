import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { fixture } from './fixtures.mjs';

export async function helperFixture(t) {
  const f = await fixture(t), original = (await readFile(f.path, 'utf8')).trim().split('\n').map(JSON.parse);
  const globalPath = join(f.source, '.codex-global-state.json'), global = JSON.parse(await readFile(globalPath, 'utf8'));
  global['thread-titles'] = { titles: { [f.id]: 'My current Codex title' }, order: [f.id] };
  const regularId = randomUUID(), regularPath = join(dirname(f.path), `rollout-regular-${regularId}.jsonl`);
  const regular = structuredClone(original); regular[0].payload.id = regularId;
  const regularPrompt = ['<recommended_plugins>\nGitHub\n</recommended_plugins>',
    '# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>',
    '<in-app-browser-context source="ambient-ui-state">\nTab\n</in-app-browser-context>',
    '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
    '## My request:\nBuild a subagent dashboard'].join('\n');
  regular[1].payload.message = regularPrompt; regular[2].payload.content[0].text = regularPrompt;
  await writeFile(regularPath, regular.map(JSON.stringify).join('\n') + '\n');
  const helpers = [];
  for (const source of [{ subagent: { thread_spawn: { parent_thread_id: f.id } } }, { subAgent: { thread_spawn: { parent_thread_id: f.id } } }, 'subagent']) {
    const id = randomUUID(), compressed = helpers.length === 1;
    const path = join(dirname(f.path), `rollout-helper-${id}.jsonl${compressed ? '.zst' : ''}`);
    const records = [{ type: 'session_meta', payload: { id, cwd: f.scratch, padding: 'x'.repeat(96 * 1024), source } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `[Generated result](${join(f.scratch, 'result.txt')})` }] } }];
    const bytes = Buffer.from(records.map(JSON.stringify).join('\n') + '\n');
    await writeFile(path, compressed ? zstdCompressSync(bytes) : bytes);
    helpers.push({ id, path, bytes });
  }
  const forkId = randomUUID(), forkPath = join(dirname(f.path), `rollout-fork-${forkId}.jsonl`);
  const fork = [{ type: 'session_meta', payload: { id: forkId, cwd: f.scratch, source: 'cli', history_base: { thread_id: helpers[0].id, end_byte_offset: helpers[0].bytes.length } } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Follow up on these findings' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Regular fork reply' } }];
  await writeFile(forkPath, fork.map(JSON.stringify).join('\n') + '\n');
  for (const id of [regularId, forkId]) global['thread-project-assignments'][id] = { projectKind: 'local', projectId: 'local-1' };
  await writeFile(globalPath, JSON.stringify(global));
  return { ...f, regularId, regularPath, regularPrompt, forkId, forkPath, helpers, globalPath };
}
