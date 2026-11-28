import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import releases from '../adapters/t3-releases.json' with { type: 'json' };
export const fixtureVersion = process.env.THREADLIFT_TEST_T3_VERSION || releases.at(-1).version;
if (!releases.some(r => r.version === fixtureVersion)) throw new Error('Unsupported test fixture version.');
const { initializeFixture } = await import(`../work/t3-fixture-v${fixtureVersion}.mjs`);
export async function fixture(t, { turns = 1 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'threadlift-test-')));
  t?.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'codex'), target = join(root, 't3'), workspace = join(root, 'project'), scratch = join(root, 'scratch');
  await Promise.all([mkdir(join(source, 'sessions/2026/11/25'), { recursive: true }), mkdir(join(target, 'userdata'), { recursive: true }), mkdir(workspace), mkdir(scratch)]);
  await initializeFixture(join(target, 'userdata/statev2.sqlite'));
  await writeFile(join(target, 'userdata/server-runtime.json'), JSON.stringify({ serverVersion: fixtureVersion }));
  await writeFile(join(target,'userdata/settings.json'),JSON.stringify({providerInstances:{codex:{driver:'codex',enabled:true,config:{setupMode:'existing',homePath:source}}}}),{mode:0o600});
  const id = randomUUID(), path = join(source, `sessions/2026/11/25/rollout-2026-11-25T00-00-00-${id}.jsonl`);
  const time = new Date().toISOString();
  const image = join(scratch, 'sample.png'), pdf = join(scratch, 'brief.pdf');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pV8AAAAASUVORK5CYII=', 'base64'));
  const stream = 'BT /F1 18 Tf 40 120 Td (Threadlift attachment test) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let document = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object,i) => { offsets.push(Buffer.byteLength(document)); document += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(document); document += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  await writeFile(pdf, document);
  await writeFile(join(scratch, 'result.txt'), 'A real workspace file.');
  const records = [{ type: 'session_meta', timestamp: time, payload: { id, cwd: scratch } }];
  for (let i = 0; i < turns; i++) {
    const user = `User message ${i}`, assistant = `Assistant reply ${i}`;
    records.push({ type: 'event_msg', timestamp: time, payload: { type: 'user_message', message: user, local_images: i === 0 ? [image] : [] } });
    records.push({ type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }, ...(i === 0 ? [{ type: 'input_file', path: pdf, filename: 'brief.pdf' }] : [])] } });
    records.push({ type: 'response_item', timestamp: time, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant }] } });
  }
  await writeFile(path, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(source, '.codex-global-state.json'), JSON.stringify({ 'thread-project-assignments': { [id]: { projectKind: 'local', projectId: 'local-1' } }, 'local-projects': { 'local-1': { name: 'Moved project', rootPaths: [workspace] } } }));
  await writeFile(join(source, 'session_index.jsonl'), JSON.stringify({ id, thread_name: 'Moved conversation' })+'\n');
  return { root, source, target, workspace, scratch, id, path };
}

